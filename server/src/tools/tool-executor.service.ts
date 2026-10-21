import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ApiClientService } from '../api-client/api-client.service';
import { TokenService } from '../auth/token.service';
import type { AppSession } from '../auth/session.types';
import type { Env } from '../config/env';
import { sanitizeForAudit } from '../common/audit';
import { StateStoreService } from '../common/state-store.service';
import type { ToolSpec } from './types';
import { UploadStoreService } from './upload-store.service';

export interface ToolResult {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
  truncated?: boolean;
  totalItems?: number;
  returnedItems?: number;
}

/**
 * Runs a curated tool against the API on behalf of the session's user.
 * - validates args with zod before any network call
 * - resolves the user's token per call (never from args/messages)
 * - truncates large payloads so they fit the model's context
 * - maps failures to short messages the model can act on
 */
@Injectable()
export class ToolExecutorService {
  constructor(
    private readonly api: ApiClientService,
    private readonly tokens: TokenService,
    private readonly env: ConfigService<Env, true>,
    @InjectPinoLogger(ToolExecutorService.name)
    private readonly logger: PinoLogger,
    @Optional()
    private readonly uploads?: UploadStoreService,
    @Optional()
    private readonly stateStore?: StateStoreService,
  ) {}

  async execute(session: AppSession, spec: ToolSpec, rawArgs: unknown): Promise<ToolResult> {
    const startedAt = Date.now();
    let status: number | string = 'ok';
    try {
      const parsed = spec.inputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        status = 'bad_args';
        return {
          ok: false,
          error:
            'Invalid arguments: ' +
            parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; '),
        };
      }

      let token: string;
      let authPayload: Awaited<ReturnType<TokenService['getValidApiAuth']>> | undefined;
      try {
        if (typeof this.tokens.getValidApiAuth === 'function') {
          authPayload = await this.tokens.getValidApiAuth(session);
          token = session.auth?.accessToken ?? '';
        } else {
          token = await this.tokens.getValidAccessToken(session);
        }
      } catch (err) {
        if (err instanceof UnauthorizedException) {
          status = 'unauthenticated';
          throw err;
        }
        throw err;
      }

      const res = spec.execute
        ? await spec.execute(parsed.data, {
            session,
            token,
            auth: authPayload,
            api: this.api,
            uploads: this.uploads ?? new UploadStoreService(),
          })
        : await this.api.request({
            ...spec.buildRequest(parsed.data),
            token,
            ...(authPayload ? { auth: authPayload } : {}),
          });
      if (!res.ok) {
        status = res.status ?? 'network';
        return {
          ok: false,
          status: res.status ?? undefined,
          error: res.status === 403
            ? 'Forbidden — your account does not have permission for this action.'
            : res.message,
        };
      }

      status = res.status;
      const shaped = spec.shape ? spec.shape(res.data) : res.data;
      return this.fitToContext(shaped);
    } finally {
      const durationMs = Date.now() - startedAt;
      const sanitizedArgs = sanitizeForAudit(rawArgs);
      const sub = session.auth?.user.sub;
      this.logger.info(
        {
          audit: 'tool_call',
          sub,
          tool: spec.name,
          args: sanitizedArgs,
          status,
          durationMs,
        },
        'tool call',
      );
      if (sub && this.stateStore) {
        void this.stateStore
          .appendAudit(sub, { tool: spec.name, args: sanitizedArgs, status, durationMs })
          .catch(() => {});
      }
    }
  }

  private fitToContext(data: unknown): ToolResult {
    const max = this.env.get('MAX_TOOL_RESULT_CHARS');
    if (JSON.stringify(data)?.length <= max) {
      return { ok: true, data };
    }
    if (Array.isArray(data)) {
      // keep the first N items that fit — the model sees what was dropped
      let lo = 0;
      let hi = data.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (JSON.stringify(data.slice(0, mid)).length <= max) lo = mid;
        else hi = mid - 1;
      }
      return {
        ok: true,
        data: data.slice(0, lo),
        truncated: true,
        totalItems: data.length,
        returnedItems: lo,
      };
    }
    const text = JSON.stringify(data) ?? String(data);
    return { ok: true, data: text.slice(0, max), truncated: true };
  }
}
