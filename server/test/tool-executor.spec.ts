import { ToolExecutorService } from '../src/tools/tool-executor.service';
import { ApiClientService } from '../src/api-client/api-client.service';
import type { TokenService } from '../src/auth/token.service';
import type { AppSession } from '../src/auth/session.types';
import type { ToolSpec } from '../src/tools/types';
import { listDevices } from '../src/tools/definitions/devices';
import { z } from 'zod';

const envGet = (values: Record<string, unknown>) =>
  ({ get: (k: string) => values[k] }) as never;

const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };

const session = {
  id: 's1',
  auth: { user: { sub: 'user-1', roles: [] }, accessToken: 'x', expiresAt: 0 },
} as unknown as AppSession;

const tokenService = {
  getValidAccessToken: jest.fn(async () => 'test-token'),
} as unknown as TokenService;

function makeExecutor() {
  const api = new ApiClientService(envGet({ API_BASE_URL: 'http://api.test', API_TIMEOUT_MS: 5000 }));
  return new ToolExecutorService(
    api,
    tokenService,
    envGet({ MAX_TOOL_RESULT_CHARS: 1000 }),
    logger as never,
  );
}

const echoSpec: ToolSpec<{ value: string }> = {
  name: 'echo',
  description: 'test tool',
  readOnly: true,
  inputSchema: z.object({ value: z.string().min(1) }),
  buildRequest: (a) => ({ method: 'GET', path: '/echo', query: { value: a.value } }),
};

describe('ToolExecutorService', () => {
  afterEach(() => jest.clearAllMocks());

  it('rejects invalid args without calling the API', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const res = await makeExecutor().execute(session, echoSpec, { value: '' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Invalid arguments');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('attaches the session token as Bearer and returns data', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const res = await makeExecutor().execute(session, echoSpec, { value: 'hi' });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ ok: 1 });
    const req = fetchSpy.mock.calls[0][0] as URL;
    expect(String(req)).toBe('http://api.test/echo?value=hi');
    const init = fetchSpy.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-token');
  });

  it('maps API errors into actionable messages without leaking headers', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'device not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await makeExecutor().execute(session, listDevices, {});
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.error).toContain('device not found');
    expect(JSON.stringify(res)).not.toContain('test-token');
  });

  it('truncates large array results and reports truncation', async () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ name: `item-${i}` }));
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(items), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await makeExecutor().execute(session, listDevices, {});
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.totalItems).toBe(200);
    expect(res.returnedItems).toBeLessThan(200);
    expect(JSON.stringify(res.data)!.length).toBeLessThanOrEqual(1000);
  });

  it('writes an audit entry for every call', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await makeExecutor().execute(session, echoSpec, { value: 'v', token: 'SECRET' } as never);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const entry = logger.info.mock.calls[0][0] as Record<string, unknown>;
    expect(entry.audit).toBe('tool_call');
    expect(entry.sub).toBe('user-1');
    expect(entry.tool).toBe('echo');
    expect(JSON.stringify(entry.args)).toContain('[redacted]');
  });

  it('supports API Key in custom header and query param, Basic Auth, and No-Auth via getValidApiAuth', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const api = new ApiClientService(envGet({ API_BASE_URL: 'http://api.test', API_TIMEOUT_MS: 5000 }));

    // 1. API Key in header
    const apiKeyHeaderTokens = {
      getValidApiAuth: jest.fn(async () => ({
        method: 'api_key' as const,
        headers: { 'X-Custom-Key': 'secret-api-key' },
      })),
    } as unknown as TokenService;
    const exec1 = new ToolExecutorService(api, apiKeyHeaderTokens, envGet({ MAX_TOOL_RESULT_CHARS: 1000 }), logger as never);
    await exec1.execute(session, echoSpec, { value: '1' });
    expect((fetchSpy.mock.calls[0][1]!.headers as Record<string, string>)['X-Custom-Key']).toBe('secret-api-key');

    // 2. API Key in query param
    const apiKeyQueryTokens = {
      getValidApiAuth: jest.fn(async () => ({
        method: 'api_key' as const,
        query: { api_key: 'q-key-123' },
      })),
    } as unknown as TokenService;
    const exec2 = new ToolExecutorService(api, apiKeyQueryTokens, envGet({ MAX_TOOL_RESULT_CHARS: 1000 }), logger as never);
    await exec2.execute(session, echoSpec, { value: '2' });
    expect(String(fetchSpy.mock.calls[1][0])).toBe('http://api.test/echo?value=2&api_key=q-key-123');

    // 3. HTTP Basic Auth
    const basicTokens = {
      getValidApiAuth: jest.fn(async () => ({
        method: 'basic' as const,
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      })),
    } as unknown as TokenService;
    const exec3 = new ToolExecutorService(api, basicTokens, envGet({ MAX_TOOL_RESULT_CHARS: 1000 }), logger as never);
    await exec3.execute(session, echoSpec, { value: '3' });
    expect((fetchSpy.mock.calls[2][1]!.headers as Record<string, string>).authorization).toBe('Basic dXNlcjpwYXNz');

    // 4. Public / No-Auth
    const noneTokens = {
      getValidApiAuth: jest.fn(async () => ({
        method: 'none' as const,
      })),
    } as unknown as TokenService;
    const exec4 = new ToolExecutorService(api, noneTokens, envGet({ MAX_TOOL_RESULT_CHARS: 1000 }), logger as never);
    await exec4.execute(session, echoSpec, { value: '4' });
    expect((fetchSpy.mock.calls[3][1]!.headers as Record<string, string>).authorization).toBeUndefined();
  });
});
