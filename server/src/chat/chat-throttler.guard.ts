import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

/** Rate-limit per authenticated user (fall back to IP). */
@Injectable()
export class ChatThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Request): Promise<string> {
    return req.session?.auth?.user.sub ?? req.ip ?? 'anonymous';
  }
}
