import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface StagedFile {
  fileId: string;
  sessionId: string;
  fileName: string;
  size: number;
  mimeType: string;
  diskPath: string;
  createdAt: number;
}

const UPLOAD_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class UploadStoreService implements OnModuleDestroy {
  private readonly dir = join(tmpdir(), 'dgpt-uploads');
  private readonly files = new Map<string, StagedFile>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor() {
    mkdirSync(this.dir, { recursive: true });
    this.sweepTimer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  private sweepExpired(): void {
    const cutoff = Date.now() - UPLOAD_TTL_MS;
    for (const [id, meta] of this.files.entries()) {
      if (meta.createdAt < cutoff) {
        this.files.delete(id);
        try {
          rmSync(meta.diskPath, { force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  save(sessionId: string, originalName: string, mimeType: string, buffer: Buffer): StagedFile {
    const fileId = randomUUID();
    const safeName = (originalName || 'artifact.bin')
      .replace(/[\\/]/g, '_')
      .replace(/\s+/g, '_');
    const diskPath = join(this.dir, `${fileId}-${safeName}`);
    writeFileSync(diskPath, buffer);
    const meta: StagedFile = {
      fileId,
      sessionId,
      fileName: safeName,
      size: buffer.length,
      mimeType: mimeType || 'application/octet-stream',
      diskPath,
      createdAt: Date.now(),
    };
    this.files.set(fileId, meta);
    return meta;
  }

  getForSession(sessionId: string, fileId: string): { meta: StagedFile; buffer: Buffer } | null {
    const meta = this.files.get(fileId);
    if (!meta || meta.sessionId !== sessionId) return null;
    return { meta, buffer: readFileSync(meta.diskPath) };
  }

  remove(sessionId: string, fileId: string): void {
    const meta = this.files.get(fileId);
    if (!meta || meta.sessionId !== sessionId) return;
    this.files.delete(fileId);
    try {
      rmSync(meta.diskPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
