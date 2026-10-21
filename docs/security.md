# Security model

## Credential & Token Handling

- Credentials and tokens (Bearer JWT/PAT, API Key, HTTP Basic Auth, API Login token, OAuth2 Client Credentials, or OIDC tokens) are stored **only** in the server-side session (Redis via `connect-redis`). The browser receives a single `HttpOnly`, `Secure` (when HTTPS), `SameSite=Lax` session cookie.
- No token or API key is ever written to `localStorage`, URLs, the frontend bundle, or logs.
- `pino` redacts `req.headers.authorization`, `cookie`, `x-api-key`, and `set-cookie`; request URLs are logged path-only (query strings are dropped as they may carry API keys); tool arguments are sanitized in the audit log.
- The LLM never sees a token or credential: tools close over the server-side `session` object and `TokenService.getValidApiAuth(session)` resolves headers/query parameters at execution time, per HTTP call.
- For OIDC and OAuth2 Client Credentials, `TokenService` refreshes expiring tokens automatically.
- After login (`POST /auth/credentials` or `/auth/callback`), the session ID is regenerated (`session.regenerate`) to prevent session fixation.

## Multi-User Tenant Isolation & SSRF Protection

- **Per-user Redis isolation**: Non-OIDC credentials derive a deterministic, non-reversible SHA-256 subject identifier (`hashCredentialId`) so two users authenticating with different API keys or tokens never share conversation threads or audit logs.
- **SSRF protection**:
  - `api_login` endpoints are strictly resolved against and restricted to the configured `API_BASE_URL` origin.
  - User-supplied `oauth2_client_credentials` token URLs block loopback, link-local, and RFC1918 private IP ranges unless explicitly configured via `OAUTH2_TOKEN_URL` or matching `API_BASE_URL`.
- **CSRF protection**: Same-origin verification (`Origin` / `Referer` / `Sec-Fetch-Site`) is enforced on all mutating `/api/*` endpoints, `/auth/credentials`, and `/auth/logout`.

## Human-in-the-loop for Mutations

- Every tool generated from `POST`, `PUT`, `PATCH`, or `DELETE` operations is marked `readOnly: false` and registered with `needsApproval: true`.
- Mutating tool calls emit a `tool-approval-request` in the UI and **nothing is sent to the target API** until the user explicitly clicks **Approve & Run**.
- Approvals are cryptographically bound to both the server (`SESSION_SECRET`) and the specific user (`session.auth.user.sub`) via `experimental_toolApprovalSecret`. Forged or cross-user approval responses fail signature verification.
- Mutating calls are never retried by `ApiClientService` (`GET` requests retry once on transient network errors or HTTP 502/503/504).

## Prompt Injection Defenses

- All API responses are treated as untrusted data. The system prompt instructs the model never to follow instructions found inside tool outputs.
- Tool inputs are validated with `zod` schemas before any network call is executed.
- Tool outputs are truncated to `MAX_TOOL_RESULT_CHARS` before entering the model context.
