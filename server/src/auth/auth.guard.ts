import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Strict check: requires an authenticated server-side session with a valid
 * user subject and access token. Returns a JSON 401 so the SPA can redirect
 * to /auth/login.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.session?.auth?.user?.sub) {
      throw new UnauthorizedException('Not authenticated');
    }
    return true;
  }
}

/**
 * Registered globally; enforces the session check and same-origin CSRF
 * protection on /api/* routes.
 */
@Injectable()
export class ApiAuthGuard extends AuthGuard {
  override canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const path = req.path ?? '';
    if (path === '/auth/credentials') {
      this.verifySameOrigin(req);
      return true;
    }
    if (path !== '/api' && !path.startsWith('/api/')) {
      return true;
    }
    this.verifySameOrigin(req);
    if (path === '/api/config' && (req.method ?? 'GET').toUpperCase() === 'GET') {
      return true;
    }
    return super.canActivate(ctx);
  }

  private verifySameOrigin(req: Request): void {
    const method = (req.method ?? 'GET').toUpperCase();
    if (!MUTATING_METHODS.has(method)) return;

    const headers = req.headers ?? {};
    const fetchSite = headers['sec-fetch-site'];
    if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
      throw new ForbiddenException('Cross-origin request blocked');
    }

    const source = (headers.origin ?? headers.referer) as string | undefined;
    if (!source) return;

    let sourceOrigin: string;
    try {
      sourceOrigin = new URL(source).origin;
    } catch {
      throw new ForbiddenException('Invalid Origin/Referer header');
    }

    const allowedOrigins = new Set<string>();
    if (process.env.APP_BASE_URL) {
      try {
        allowedOrigins.add(new URL(process.env.APP_BASE_URL).origin);
      } catch {
        // ignore malformed env in tests
      }
    }
    const host = headers['x-forwarded-host'] ?? headers.host;
    const proto = (headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol ?? 'http';
    if (typeof host === 'string' && host) {
      allowedOrigins.add(`${proto}://${host}`);
    }

    if (allowedOrigins.size > 0 && !allowedOrigins.has(sourceOrigin)) {
      throw new ForbiddenException('Cross-origin request blocked');
    }
  }
}
