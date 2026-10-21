import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Response } from 'express';
import {
  convertToModelMessages,
  pipeUIMessageStreamToResponse,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type ToolSet,
  type UIMessage,
} from 'ai';
import type { AppSession } from '../auth/session.types';
import type { Env } from '../config/env';
import { LLM_MODEL } from '../llm/llm.module';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { ToolsRegistry } from '../tools/tools.registry';
import type { ToolSpec } from '../tools/types';
import { SYSTEM_PROMPT } from './system-prompt';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly fileSystemPrompt?: string;

  constructor(
    @Inject(LLM_MODEL) private readonly model: LanguageModel,
    private readonly registry: ToolsRegistry,
    private readonly executor: ToolExecutorService,
    private readonly env: ConfigService<Env, true>,
  ) {
    const file = this.env.get('SYSTEM_PROMPT_FILE');
    if (file) {
      this.fileSystemPrompt = readFileSync(file, 'utf8');
      this.logger.log(`Loaded system prompt from ${file} (${this.fileSystemPrompt.length} chars)`);
    }
  }

  private getSystemPrompt(): string {
    if (this.fileSystemPrompt) return this.fileSystemPrompt;
    const generated = this.registry.getGeneratedConfig();
    if (generated?.systemPrompt) return generated.systemPrompt;
    return SYSTEM_PROMPT;
  }

  /**
   * Builds the per-request tool set. The session is captured in a closure so
   * the token is resolved at execution time — it never appears in tool input,
   * model messages, or the streamed response.
   */
  private buildTools(
    session: AppSession,
    specs: ToolSpec[],
    inputOverrides?: Record<string, Record<string, unknown>>,
  ): ToolSet {
    const set: ToolSet = {};
    for (const spec of specs) {
      set[spec.name] = tool({
        description: spec.description,
        inputSchema: spec.inputSchema,
        ...(spec.readOnly ? {} : { needsApproval: true as const }),
        execute: (args: unknown, options?: { toolCallId?: string }) => {
          const override = options?.toolCallId ? inputOverrides?.[options.toolCallId] : undefined;
          let mergedArgs = args;
          if (override && typeof args === 'object' && args !== null) {
            const base = { ...(args as Record<string, unknown>) };
            // Only allow modifying existing non-fileIds keys from the signed input
            for (const [k, v] of Object.entries(override)) {
              if (k !== 'fileIds' && Object.prototype.hasOwnProperty.call(base, k)) {
                base[k] = v;
              }
            }
            mergedArgs = base;
          }
          return this.executor.execute(session, spec, mergedArgs);
        },
      });
    }
    return set;
  }

  async streamChat(
    session: AppSession,
    uiMessages: UIMessage[],
    res: Response,
    inputOverrides?: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    const activeSpecs = this.registry.selectForConversation(uiMessages);
    const tools = this.buildTools(session, activeSpecs, inputOverrides);
    // Drop tool parts that never reached a terminal state (e.g. a stale
    // approval-requested or a call for an unknown tool) — otherwise
    // streamText throws MissingToolResultsError on the next turn.
    const terminalStates = new Set(['output-available', 'output-error', 'approval-responded']);
    const sanitized = uiMessages.map((m) => ({
      ...m,
      parts: m.parts?.filter(
        (p) =>
          !(p.type === 'dynamic-tool' || p.type.startsWith('tool-')) ||
          terminalStates.has((p as { state?: string }).state ?? ''),
      ),
    }));
    const messages = await convertToModelMessages(sanitized, {
      tools,
      ignoreIncompleteToolCalls: true,
    });

    const result = streamText({
      model: this.model,
      system: this.getSystemPrompt(),
      messages,
      tools,
      maxOutputTokens: this.env.get('LLM_MAX_TOKENS'),
      stopWhen: [
        stepCountIs(this.env.get('MAX_TOOL_STEPS')),
        // Stop if the last step emitted tool calls that produced no results
        // (e.g. an approval-gated call mid-loop) — continuing would crash the
        // next step's message conversion with MissingToolResultsError.
        ({ steps }) => {
          const last = steps.at(-1);
          return !!last && last.toolCalls.length !== last.toolResults.length;
        },
      ],
      abortSignal: AbortSignal.timeout(this.env.get('CHAT_REQUEST_TIMEOUT_MS')),
      // cryptographically binds approvals to this server AND the specific user —
      // a forged or cross-user tool-approval-response cannot trigger a mutating tool
      experimental_toolApprovalSecret: createHmac('sha256', this.env.get('SESSION_SECRET'))
        .update(session.auth?.user.sub ?? session.id ?? 'anon')
        .digest('hex'),
      // A call for a tool that doesn't exist (or with irreparable input) would
      // otherwise orphan a tool-call part and crash the next step with
      // MissingToolResultsError — drop it instead.
      repairToolCall: async ({ toolCall, error }) => {
        this.logger.warn(`dropping unresolvable tool call "${toolCall.toolName}": ${error.message}`);
        return null;
      },
    });

    await pipeUIMessageStreamToResponse({
      response: res,
      stream: result.toUIMessageStream({
        onError: (error) => {
          this.logger.error({ err: error }, 'chat stream failed');
          return 'Something went wrong while generating the response. Please try again.';
        },
      }),
    });
  }
}
