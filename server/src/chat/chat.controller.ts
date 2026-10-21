import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { UIMessage } from 'ai';
import type { Env } from '../config/env';
import { TokenService } from '../auth/token.service';
import { StateStoreService } from '../common/state-store.service';
import { ToolsRegistry } from '../tools/tools.registry';
import { UploadStoreService } from '../tools/upload-store.service';
import { ChatService } from './chat.service';
import { ChatThrottlerGuard } from './chat-throttler.guard';

interface UploadedMulterFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

@Controller('api')
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly tokens: TokenService,
    private readonly uploads: UploadStoreService,
    private readonly stateStore: StateStoreService,
    private readonly registry: ToolsRegistry,
    private readonly env: ConfigService<Env, true>,
  ) {}

  @Get('config')
  getConfig() {
    const cfg = this.registry.getGeneratedConfig();
    const paramEnums: Record<string, string[]> = {};
    const paramLabels: Record<string, string> = {};
    for (const t of cfg?.tools ?? []) {
      for (const p of t.parameters) {
        if (p.enum && p.enum.length > 0 && !paramEnums[p.name]) {
          paramEnums[p.name] = p.enum;
        }
        if (!paramLabels[p.name]) {
          paramLabels[p.name] = p.name
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, (c) => c.toUpperCase());
        }
      }
    }
    return {
      apiTitle: cfg?.apiTitle ?? null,
      apiDescription: cfg?.apiDescription ?? null,
      authConfig: cfg?.authConfig ?? null,
      slashCommands: cfg?.slashCommands ?? null,
      starterCards: cfg?.starterCards ?? null,
      paramEnums: Object.keys(paramEnums).length > 0 ? paramEnums : null,
      paramLabels: Object.keys(paramLabels).length > 0 ? paramLabels : null,
      toolCount: this.registry.specs.length,
    };
  }

  @Get('history')
  async getHistory(@Req() req: Request) {
    const sub = req.session.auth?.user.sub;
    if (!sub) return { messages: [] };
    return { messages: await this.stateStore.getHistory(sub) };
  }

  @Put('history')
  async saveHistory(@Req() req: Request, @Body() body: unknown) {
    const sub = req.session.auth?.user.sub;
    const messages = (body as { messages?: unknown })?.messages;
    if (!sub || !Array.isArray(messages)) {
      throw new BadRequestException('body must contain a messages array');
    }
    await this.stateStore.saveHistory(sub, messages as UIMessage[]);
    return { ok: true };
  }

  @Delete('history')
  async clearHistory(@Req() req: Request) {
    const sub = req.session.auth?.user.sub;
    if (sub) {
      await this.stateStore.clearHistory(sub);
    }
    return { ok: true };
  }

  @Get('threads')
  async listThreads(@Req() req: Request) {
    const sub = req.session.auth?.user.sub;
    if (!sub) return { threads: [] };
    return { threads: await this.stateStore.listThreads(sub) };
  }

  @Put('threads/:threadId')
  async saveThread(
    @Req() req: Request,
    @Param('threadId') threadId: string,
    @Body() body: unknown,
  ) {
    const sub = req.session.auth?.user.sub;
    const payload = body as { messages?: unknown; title?: string };
    if (!sub || !Array.isArray(payload?.messages)) {
      throw new BadRequestException('body must contain a messages array');
    }
    const threads = await this.stateStore.upsertThread(
      sub,
      threadId,
      payload.messages as UIMessage[],
      payload.title,
    );
    return { threads };
  }

  @Delete('threads/:threadId')
  async deleteThread(@Req() req: Request, @Param('threadId') threadId: string) {
    const sub = req.session.auth?.user.sub;
    if (!sub) return { threads: [] };
    return { threads: await this.stateStore.deleteThread(sub, threadId) };
  }

  @Get('audit')
  async getAudit(@Req() req: Request) {
    const sub = req.session.auth?.user.sub;
    if (!sub) return { entries: [] };
    return { entries: await this.stateStore.getAudit(sub) };
  }

  @Post('uploads')
  @UseInterceptors(FilesInterceptor('files', 10))
  uploadFiles(@Req() req: Request, @UploadedFiles() files?: UploadedMulterFile[]) {
    if (!files?.length) {
      throw new BadRequestException('No files uploaded');
    }
    return {
      files: files.map((f) => {
        const meta = this.uploads.save(req.session.id, f.originalname, f.mimetype, f.buffer);
        return {
          fileId: meta.fileId,
          fileName: meta.fileName,
          size: meta.size,
          mimeType: meta.mimeType,
        };
      }),
    };
  }

  @Delete('uploads/:fileId')
  deleteUpload(@Req() req: Request, @Param('fileId') fileId: string) {
    this.uploads.remove(req.session.id, fileId);
    return { ok: true };
  }

  @Post('chat')
  @UseGuards(ChatThrottlerGuard)
  @Throttle({
    default: {
      limit: Number(process.env.CHAT_RATE_LIMIT_PER_MINUTE) || 20,
      ttl: 60_000,
    },
  })
  async postChat(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    const payload = body as {
      messages?: unknown;
      toolInputOverrides?: Record<string, Record<string, unknown>>;
    };
    const messages = payload?.messages;
    if (!Array.isArray(messages)) {
      throw new BadRequestException('body must contain a messages array');
    }
    // Ensure the session token is valid (or refreshed and persisted to Redis)
    // BEFORE opening the 200 SSE stream, so an expired session returns a real
    // HTTP 401 that triggers the UI login redirect.
    await this.tokens.getValidAccessToken(req.session);
    await this.chat.streamChat(
      req.session,
      messages as UIMessage[],
      res,
      payload.toolInputOverrides,
    );
  }
}
