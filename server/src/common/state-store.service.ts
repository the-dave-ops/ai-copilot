import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type RedisClientType } from 'redis';
import type { UIMessage } from 'ai';
import type { Env } from '../config/env';

export interface AuditEntry {
  id: string;
  timestamp: string;
  tool: string;
  args: unknown;
  status: number | string;
  durationMs: number;
}

export interface ChatThread {
  id: string;
  title: string;
  updatedAt: string;
  messages: UIMessage[];
}

const MAX_AUDIT_ENTRIES = 50;
const MAX_THREADS = 25;

@Injectable()
export class StateStoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StateStoreService.name);
  private client: RedisClientType | null = null;
  private readonly memHistory = new Map<string, UIMessage[]>();
  private readonly memThreads = new Map<string, ChatThread[]>();
  private readonly memAudit = new Map<string, AuditEntry[]>();

  constructor(private readonly env: ConfigService<Env, true>) {}

  async onModuleInit(): Promise<void> {
    if (process.env.JEST_WORKER_ID) return;
    try {
      const c = createClient({
        url: this.env.get('REDIS_URL'),
        socket: { connectTimeout: 2000, reconnectStrategy: (retries) => Math.min(retries * 200, 2000) },
      });
      c.on('error', (err) => this.logger.warn(`redis state store error: ${String(err)}`));
      await c.connect();
      this.client = c as RedisClientType;
    } catch (err) {
      this.logger.warn(`Using in-memory state store fallback (${String(err)})`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client?.isOpen) {
      await this.client.quit().catch(() => {});
    }
  }

  private historyKey(sub: string): string {
    return `dgpt:history:${sub}`;
  }

  private threadsKey(sub: string): string {
    return `dgpt:threads:${sub}`;
  }

  private auditKey(sub: string): string {
    return `dgpt:audit:${sub}`;
  }

  async getHistory(sub: string): Promise<UIMessage[]> {
    if (this.client?.isOpen) {
      const raw = await this.client.get(this.historyKey(sub));
      if (!raw) return [];
      try {
        return JSON.parse(raw) as UIMessage[];
      } catch {
        return [];
      }
    }
    return this.memHistory.get(sub) ?? [];
  }

  async saveHistory(sub: string, messages: UIMessage[]): Promise<void> {
    const trimmed = messages.slice(-60);
    if (this.client?.isOpen) {
      await this.client.set(this.historyKey(sub), JSON.stringify(trimmed));
      return;
    }
    this.memHistory.set(sub, trimmed);
  }

  async clearHistory(sub: string): Promise<void> {
    if (this.client?.isOpen) {
      await this.client.del(this.historyKey(sub));
    }
    this.memHistory.delete(sub);
  }

  async listThreads(sub: string): Promise<ChatThread[]> {
    if (this.client?.isOpen) {
      const raw = await this.client.get(this.threadsKey(sub));
      if (!raw) return [];
      try {
        return JSON.parse(raw) as ChatThread[];
      } catch {
        return [];
      }
    }
    return this.memThreads.get(sub) ?? [];
  }

  async upsertThread(sub: string, threadId: string, messages: UIMessage[], customTitle?: string): Promise<ChatThread[]> {
    const threads = await this.listThreads(sub);
    const trimmed = messages.slice(-60);
    const firstUserText = trimmed
      .find((m) => m.role === 'user')
      ?.parts?.find((p) => p.type === 'text') as { text?: string } | undefined;
    const rawTitle =
      customTitle?.trim() ||
      firstUserText?.text?.split('\n')[0]?.trim().slice(0, 44) ||
      'New conversation';

    const existingIdx = threads.findIndex((t) => t.id === threadId);
    const updated: ChatThread = {
      id: threadId,
      title: existingIdx >= 0 && !customTitle ? threads[existingIdx].title : rawTitle,
      updatedAt: new Date().toISOString(),
      messages: trimmed,
    };

    const next = [updated, ...threads.filter((t) => t.id !== threadId)].slice(0, MAX_THREADS);
    if (this.client?.isOpen) {
      await this.client.set(this.threadsKey(sub), JSON.stringify(next));
    } else {
      this.memThreads.set(sub, next);
    }
    return next;
  }

  async deleteThread(sub: string, threadId: string): Promise<ChatThread[]> {
    const threads = await this.listThreads(sub);
    const next = threads.filter((t) => t.id !== threadId);
    if (this.client?.isOpen) {
      await this.client.set(this.threadsKey(sub), JSON.stringify(next));
    } else {
      this.memThreads.set(sub, next);
    }
    return next;
  }

  async appendAudit(sub: string, entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<void> {
    const full: AuditEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    if (this.client?.isOpen) {
      const key = this.auditKey(sub);
      await this.client.lPush(key, JSON.stringify(full));
      await this.client.lTrim(key, 0, MAX_AUDIT_ENTRIES - 1);
      return;
    }
    const list = [full, ...(this.memAudit.get(sub) ?? [])].slice(0, MAX_AUDIT_ENTRIES);
    this.memAudit.set(sub, list);
  }

  async getAudit(sub: string): Promise<AuditEntry[]> {
    if (this.client?.isOpen) {
      const items = await this.client.lRange(this.auditKey(sub), 0, MAX_AUDIT_ENTRIES - 1);
      return items
        .map((raw) => {
          try {
            return JSON.parse(raw) as AuditEntry;
          } catch {
            return null;
          }
        })
        .filter((x): x is AuditEntry => x !== null);
    }
    return this.memAudit.get(sub) ?? [];
  }
}
