import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ApiAuthGuard, AuthGuard } from '../src/auth/auth.guard';

const ctx = (
  path: string,
  auth: unknown,
  method = 'GET',
  headers: Record<string, string> = {},
): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        path,
        method,
        protocol: 'http',
        headers: { host: 'localhost:3000', ...headers },
        session: auth ? { auth } : {},
      }),
    }),
  }) as unknown as ExecutionContext;

describe('AuthGuard', () => {
  const guard = new AuthGuard();
  it('allows when session has auth', () => {
    expect(guard.canActivate(ctx('/api/chat', { user: { sub: 'u' } }))).toBe(true);
  });
  it('throws 401 without auth', () => {
    expect(() => guard.canActivate(ctx('/api/chat', null))).toThrow(UnauthorizedException);
  });
});

describe('ApiAuthGuard', () => {
  const guard = new ApiAuthGuard();
  it('skips non-/api routes even without session', () => {
    expect(guard.canActivate(ctx('/auth/login', null))).toBe(true);
    expect(guard.canActivate(ctx('/health', null))).toBe(true);
  });
  it('enforces on /api routes', () => {
    expect(() => guard.canActivate(ctx('/api/chat', null))).toThrow(UnauthorizedException);
    expect(guard.canActivate(ctx('/api/chat', { user: { sub: 'u' } }))).toBe(true);
  });
  it('blocks cross-origin mutating requests (CSRF)', () => {
    expect(() =>
      guard.canActivate(
        ctx('/api/chat', { user: { sub: 'u' } }, 'POST', {
          origin: 'https://evil.example.com',
        }),
      ),
    ).toThrow(ForbiddenException);
    expect(
      guard.canActivate(
        ctx('/api/chat', { user: { sub: 'u' } }, 'POST', {
          origin: 'http://localhost:3000',
        }),
      ),
    ).toBe(true);
  });
});
