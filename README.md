# api-copilot

A self-configuring ChatGPT-style web copilot for **any REST / OpenAPI API**.

Point `api-copilot` at your API:
1. **On first startup**, the **Startup Discovery Agent** inspects your API's OpenAPI/Swagger specification (via file path, URL, or auto-probing `API_BASE_URL`), selects the **top 15–25 endpoints**, and generates runtime tools, a guided `/` slash-command menu, starter cards, and a tailored system prompt into a local directory (`./generated`).
2. **On subsequent restarts**, the server detects the saved configuration in `./generated` and starts immediately without re-running the discovery agent (automatically re-running only if `API_BASE_URL` or `OPENAPI_SPEC_URL` changes).
3. **Multi-method Authentication UI**: Users sign in and connect to the target API using their own credentials (**Bearer Token / PAT**, **API Key** in header or query param, **HTTP Basic Auth**, **Direct API Login Endpoint**, **OAuth2 Client Credentials**, **OIDC Single Sign-On**, or **Public / No-Auth**). The API remains the sole authority on permissions.

```
Browser (React chat UI + Connect UI)
  └─ HttpOnly session cookie ─► NestJS agent service
                                  ├─ StartupAgentService: OpenAPI discovery → ./generated/
                                  ├─ AuthModule: Bearer, API Key, Basic, API Login, OAuth2, OIDC, Public
                                  ├─ ChatModule: POST /api/chat (streaming UI message protocol)
                                  ├─ ToolsModule: dynamic zod tool registry + human-in-the-loop executor
                                  ├─ ApiClientModule: per-call auth injection to target API
                                  └─ LlmModule: any OpenAI-compatible provider
                            ─► Target REST API
                            ─► Redis (encrypted server-side sessions, threads & audit log)
```

---

## Security Model (Summary — see `docs/security.md`)

- **Zero token leakage to the LLM or browser**: Tokens, API keys, and credentials live **only** in the Redis-backed server session. The browser receives an `HttpOnly`, `Secure`, `SameSite=Lax` cookie, and `TokenService` injects credentials server-side per HTTP call.
- **Cryptographically signed human-in-the-loop approvals**: Every mutating tool (`POST` / `PUT` / `PATCH` / `DELETE`) requires explicit user approval in the UI before any API request is made. Approvals are HMAC-signed with `SESSION_SECRET` and bound to the user's session.
- **SSRF & CSRF protection**: Direct login paths are origin-bound to `API_BASE_URL`, OAuth2 token URLs block private/loopback networks unless explicitly configured by the administrator, and mutating routes verify same-origin headers.
- **Per-user tenant isolation**: Conversation threads and audit logs in Redis are isolated per user via cryptographic credential hashing.

---

## Quick Start (Docker Compose)

```bash
cp .env.example .env
# Edit .env to set API_BASE_URL, OPENAPI_SPEC_URL (or OPENAPI_SPEC_PATH), and LLM_API_KEY
docker compose up --build
```

- **Web UI**: `http://localhost:3000`
- By default, `.env.example` and `docker-compose.yml` point at the free public **FakeRESTApi** (`https://fakerestapi.azurewebsites.net`) so you can test immediately with **No Auth** or any other authentication tab.

### Local Development (without Docker for the app)

```bash
docker compose up -d redis
npm install && npm run install:all
cp .env.example .env        # set API_BASE_URL, LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
npm run build
npm start
```

---

## Connecting Your Own API

Set the following in `.env`:

| Variable | Description |
|---|---|
| `API_BASE_URL` | Root URL of the target API (e.g. `https://api.example.com`) |
| `OPENAPI_SPEC_URL` | *(Optional)* Direct URL to OpenAPI/Swagger JSON or YAML. If omitted, the agent probes `/openapi.json`, `/openapi.yaml`, `/api-json`, `/swagger.json`, `/v3/api-docs`, etc. |
| `OPENAPI_SPEC_PATH` | *(Optional)* Local file path to an OpenAPI `.yaml` or `.json` file |
| `TOOLS_DATA_DIR` | Local directory where generated tools & slash commands are saved (default `./generated`) |
| `STARTUP_AGENT_ENABLED` | Run the discovery agent when `TOOLS_DATA_DIR` is empty (default `true`) |
| `FORCE_REGENERATE_TOOLS` | Set to `true` to force re-running the startup agent on next boot |
| `STARTUP_AGENT_MIN_ENDPOINTS` / `MAX_ENDPOINTS` | Target number of endpoints for the startup agent to select (default `15`–`25`) |

### What Gets Saved in `TOOLS_DATA_DIR` (`./generated`)
- `api-config.json`: Full configuration (API metadata, detected auth schemes, tools, slash commands, starter cards, system prompt)
- `tools.json`: Declarative tool specifications with parameter schemas
- `slash-commands.json`: Slash commands (`/`) and starter cards for the React UI
- `system-prompt.txt`: Generated system prompt for the LLM

---

## Supported Authentication Methods

When a user opens the app, the **Connect** screen lets them authenticate using any of:
1. **Bearer Token / JWT (`bearer`)** — sends `Authorization: Bearer <token>`
2. **API Key (`api_key`)** — sends a custom header (e.g. `X-API-Key`) or query parameter (`?api_key=...`)
3. **HTTP Basic Auth (`basic`)** — sends `Authorization: Basic base64(username:password)`
4. **API Login Endpoint (`api_login`)** — `POST`s credentials to the API's login route (auto-detected from OpenAPI or set via `API_LOGIN_PATH`) and extracts the token
5. **OAuth2 Client Credentials (`oauth2_client_credentials`)** — exchanges `client_id` & `client_secret` at the token URL and auto-refreshes before expiry
6. **Single Sign-On / OIDC (`oidc`)** — PKCE Authorization Code flow when `KEYCLOAK_ISSUER_URL` is configured
7. **Public / No Auth (`none`)** — connects without auth headers for open/public APIs

---

## Switching LLM Providers

Change `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` in `.env` — works with OpenAI, OpenRouter, Anthropic/LiteLLM proxies, Azure OpenAI, Ollama, and vLLM.

---

## Kubernetes Deployment

### Option 1: Helm Chart (`helm/api-copilot`)

```bash
helm install api-copilot ./helm/api-copilot \
  --namespace api-copilot --create-namespace \
  --set image.repository=ghcr.io/your-org/api-copilot \
  --set image.tag=latest \
  --set config.appBaseUrl=https://chat.example.com \
  --set config.apiBaseUrl=https://api.example.com \
  --set config.openApiSpecUrl=https://api.example.com/openapi.json \
  --set config.redisUrl=redis://redis.api-copilot.svc:6379 \
  --set config.llmBaseUrl=https://api.openai.com/v1 \
  --set config.llmModel=gpt-4o \
  --set secrets.sessionSecret=$(openssl rand -hex 32) \
  --set secrets.llmApiKey=sk-...
```

The Helm chart automatically provisions a `PersistentVolumeClaim` (`persistence.enabled=true`) mounted at `/app/generated` so the startup agent's generated tools persist across pod restarts.

### Option 2: Raw Kubernetes Manifests (`k8s/`)

1. Edit `k8s/01-configmap.yaml`, `k8s/02-secret.yaml`, and `k8s/05-ingress.yaml` with your domain, `API_BASE_URL`, `OPENAPI_SPEC_URL`, `SESSION_SECRET`, and `LLM_API_KEY`.
2. Apply the manifests:

```bash
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/01-configmap.yaml
kubectl apply -f k8s/02-secret.yaml
kubectl apply -f k8s/03-deployment.yaml
kubectl apply -f k8s/04-service.yaml
kubectl apply -f k8s/05-ingress.yaml
```

---

## Tests

```bash
npm test          # runs unit tests (startup agent, tool executor, guards) + e2e tests
npm run build     # builds React frontend into server/public and compiles NestJS server
```

## License

MIT — see [LICENSE](./LICENSE).
