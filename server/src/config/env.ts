import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    APP_BASE_URL: z.url(),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(28800),
    SESSION_COOKIE_SECURE: z.enum(['auto', 'always', 'never']).default('auto'),
    REDIS_URL: z.string().min(1),
    KEYCLOAK_ISSUER_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.url().optional(),
    ),
    KEYCLOAK_CLIENT_ID: z.string().optional(),
    KEYCLOAK_CLIENT_SECRET: z.string().optional(),
    KEYCLOAK_SCOPE: z.string().default('openid profile email'),
    // Optional internal base URL for server-side calls when the issuer is not
    // reachable from this service (e.g. issuer localhost, app in docker)
    KEYCLOAK_INTERNAL_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.url().optional(),
    ),
    API_BASE_URL: z.url(),
    API_LOGIN_PATH: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().optional(),
    ),
    API_KEY_HEADER: z.string().default('X-API-Key'),
    OAUTH2_TOKEN_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.url().optional(),
    ),
    DASHBOARD_BASE_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.url().optional(),
    ),
    API_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
    OPENAPI_SPEC_PATH: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().optional(),
    ),
    OPENAPI_SPEC_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.url().optional(),
    ),
    TOOLS_DATA_DIR: z.string().default('./generated'),
    STARTUP_AGENT_ENABLED: z.stringbool().default(true),
    FORCE_REGENERATE_TOOLS: z.stringbool().default(false),
    STARTUP_AGENT_MIN_ENDPOINTS: z.coerce.number().int().min(1).max(100).default(15),
    STARTUP_AGENT_MAX_ENDPOINTS: z.coerce.number().int().min(1).max(100).default(25),
    LLM_BASE_URL: z.url(),
    LLM_API_KEY: z.string().default(''),
    LLM_MODEL: z.string().min(1),
    LLM_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
    MAX_TOOL_STEPS: z.coerce.number().int().positive().default(8),
    MAX_TOOL_RESULT_CHARS: z.coerce.number().int().positive().default(8000),
    CHAT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
    // Optional path to a file that overrides the built-in system prompt
    // (e.g. a ConfigMap mounted at /etc/dashboard-gpt/system-prompt.txt)
    SYSTEM_PROMPT_FILE: z.string().optional(),
    CHAT_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
    ENABLE_TOKEN_EXCHANGE: z.stringbool().default(false),
    TOKEN_EXCHANGE_AUDIENCE: z.string().optional(),
  })
  .check((ctx) => {
    if (ctx.value.ENABLE_TOKEN_EXCHANGE && !ctx.value.TOKEN_EXCHANGE_AUDIENCE) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value.TOKEN_EXCHANGE_AUDIENCE,
        path: ['TOKEN_EXCHANGE_AUDIENCE'],
        message: 'TOKEN_EXCHANGE_AUDIENCE is required when ENABLE_TOKEN_EXCHANGE=true',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  return result.data;
}
