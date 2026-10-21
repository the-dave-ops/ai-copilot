import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';

import type { ApiAuthPayload } from '../auth/session.types';

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  token?: string;
  auth?: ApiAuthPayload;
  query?: Record<string, unknown>;
  body?: unknown;
}

export type ApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number | null; message: string };

const RETRYABLE_STATUS = new Set([502, 503, 504]);

/** Thin HTTP client to the GetApp API. The bearer token is injected per call. */
@Injectable()
export class ApiClientService {
  constructor(private readonly env: ConfigService<Env, true>) {}

  async request(req: ApiRequest): Promise<ApiResult> {
    const maxAttempts = req.method === 'GET' ? 2 : 1;
    let last: ApiResult | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      last = await this.once(req);
      // never retry mutating calls; only retry retryable failures on GET
      if (last.ok || req.method !== 'GET') {
        return last;
      }
      if (last.status === null || RETRYABLE_STATUS.has(last.status)) {
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
      }
      return last;
    }
    return last!;
  }

  private async once(req: ApiRequest): Promise<ApiResult> {
    const url = new URL(req.path, this.env.get('API_BASE_URL'));
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        v.forEach((item) => url.searchParams.append(k, String(item)));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
    // Inject auth query params (e.g. API key in query string)
    if (req.auth?.query) {
      for (const [k, v] of Object.entries(req.auth.query)) {
        if (v) url.searchParams.set(k, v);
      }
    }

    const authHeaders: Record<string, string> = {};
    if (req.auth) {
      if (req.auth.headers) {
        Object.assign(authHeaders, req.auth.headers);
      }
    } else if (req.token) {
      authHeaders.authorization = `Bearer ${req.token}`;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: req.method,
        headers: {
          ...authHeaders,
          accept: 'application/json',
          ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(this.env.get('API_TIMEOUT_MS')),
      });
    } catch (err) {
      const msg = err instanceof Error && err.name === 'TimeoutError'
        ? `API request timed out after ${this.env.get('API_TIMEOUT_MS')}ms`
        : `API unreachable: ${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, status: null, message: msg };
    }

    const contentType = res.headers.get('content-type') ?? '';
    const data: unknown = contentType.includes('json')
      ? await res.json().catch(() => null)
      : await res.text().catch(() => '');

    if (res.ok) {
      return { ok: true, status: res.status, data };
    }
    const detail =
      typeof data === 'object' && data !== null && 'message' in data
        ? String((data as { message: unknown }).message)
        : '';
    return {
      ok: false,
      status: res.status,
      message: `API returned ${res.status}${detail ? `: ${detail}` : ''}`,
    };
  }
}
