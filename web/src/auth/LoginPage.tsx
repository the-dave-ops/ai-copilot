import { useEffect, useState } from 'react';
import type { Me } from '../App';

export type AuthMethod =
  | 'bearer'
  | 'api_key'
  | 'basic'
  | 'api_login'
  | 'oauth2_client_credentials'
  | 'oidc'
  | 'none';

interface ProvidersResponse {
  oidcEnabled: boolean;
  apiBaseUrl: string;
  defaultApiKeyHeader: string;
  defaultLoginPath: string;
  defaultOAuth2TokenUrl: string;
  methods: AuthMethod[];
}

interface ToolPreviewItem {
  name: string;
  method: string;
  path: string;
  description: string;
  readOnly: boolean;
}

interface ConfigResponse {
  apiTitle?: string | null;
  apiDescription?: string | null;
  apiBaseUrl?: string | null;
  toolCount?: number;
  tools?: ToolPreviewItem[];
  slashCommands?: unknown[];
  authConfig?: {
    defaultMethod?: AuthMethod;
    apiKeyName?: string;
    apiKeyIn?: 'header' | 'query';
    loginEndpoint?: string;
    oauth2TokenUrl?: string;
    schemeSummary?: string;
  } | null;
}

const METHOD_META: Record<
  AuthMethod,
  { label: string; short: string; badge: string; desc: string }
> = {
  bearer: {
    label: 'Bearer Token / Personal Access Token',
    short: 'Bearer Token',
    badge: 'Authorization: Bearer',
    desc: 'Injects your JWT or Personal Access Token into the Authorization header on every request.',
  },
  api_key: {
    label: 'API Key Authentication',
    short: 'API Key',
    badge: 'Custom Header / Query',
    desc: 'Attaches a custom API key header (e.g. X-API-Key) or URL query parameter per call.',
  },
  basic: {
    label: 'HTTP Basic Authentication',
    short: 'Basic Auth',
    badge: 'RFC 7617 Base64',
    desc: 'Encodes username and password credentials using standard HTTP Basic authentication.',
  },
  api_login: {
    label: 'Direct API Token Exchange',
    short: 'API Login',
    badge: 'POST → Bearer',
    desc: 'Authenticates directly against the target API login endpoint and stores the returned token.',
  },
  oauth2_client_credentials: {
    label: 'OAuth 2.0 Client Credentials',
    short: 'OAuth2 Client',
    badge: 'Machine-to-Machine',
    desc: 'Exchanges Client ID and Secret at the OAuth2 token endpoint with automatic expiry refresh.',
  },
  oidc: {
    label: 'Enterprise Single Sign-On (OIDC)',
    short: 'OIDC SSO',
    badge: 'OAuth 2.0 PKCE S256',
    desc: 'Redirects to your identity provider (Keycloak, Okta, Auth0, Azure AD) with PKCE verification.',
  },
  none: {
    label: 'Public / Unauthenticated Access',
    short: 'Public API',
    badge: 'No Auth Header',
    desc: 'Connects directly to open or public API endpoints without sending authentication headers.',
  },
};

export function LoginPage({ onAuthenticated }: { onAuthenticated: (me: Me) => void }) {
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [apiTitle, setApiTitle] = useState('API');
  const [apiDesc, setApiDesc] = useState('Self-configuring enterprise API copilot');
  const [toolCount, setToolCount] = useState(0);
  const [slashCount, setSlashCount] = useState(0);
  const [sampleTools, setSampleTools] = useState<ToolPreviewItem[]>([]);
  const [schemeSummary, setSchemeSummary] = useState<string | null>(null);
  const [method, setMethod] = useState<AuthMethod>('bearer');

  // Form states
  const [token, setToken] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyName, setApiKeyName] = useState('X-API-Key');
  const [apiKeyIn, setApiKeyIn] = useState<'header' | 'query'>('header');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginPath, setLoginPath] = useState('/api/v1/login');
  const [tokenUrl, setTokenUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [scope, setScope] = useState('');
  const [displayName, setDisplayName] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('/auth/providers').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/config').then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([prov, cfg]: [ProvidersResponse | null, ConfigResponse | null]) => {
        if (prov) {
          setProviders(prov);
          if (prov.defaultApiKeyHeader) setApiKeyName(prov.defaultApiKeyHeader);
          if (prov.defaultLoginPath) setLoginPath(prov.defaultLoginPath);
          if (prov.defaultOAuth2TokenUrl) setTokenUrl(prov.defaultOAuth2TokenUrl);
        }
        if (cfg) {
          if (cfg.apiTitle) {
            setApiTitle(cfg.apiTitle);
            document.title = `${cfg.apiTitle} — API Copilot`;
          }
          if (cfg.apiDescription) setApiDesc(cfg.apiDescription);
          if (typeof cfg.toolCount === 'number') setToolCount(cfg.toolCount);
          if (Array.isArray(cfg.slashCommands)) setSlashCount(cfg.slashCommands.length);
          if (Array.isArray(cfg.tools)) setSampleTools(cfg.tools.slice(0, 5));
          const ac = cfg.authConfig;
          if (ac) {
            if (ac.schemeSummary) setSchemeSummary(ac.schemeSummary);
            if (ac.apiKeyName) setApiKeyName(ac.apiKeyName);
            if (ac.apiKeyIn) setApiKeyIn(ac.apiKeyIn);
            if (ac.loginEndpoint) setLoginPath(ac.loginEndpoint);
            if (ac.oauth2TokenUrl) setTokenUrl(ac.oauth2TokenUrl);
            if (ac.defaultMethod) {
              if (ac.defaultMethod === 'oidc' && !prov?.oidcEnabled) {
                setMethod('bearer');
              } else {
                setMethod(ac.defaultMethod);
              }
            }
          }
        }
      })
      .catch(() => {});
  }, []);

  const availableMethods: AuthMethod[] = providers?.methods ?? [
    'bearer',
    'api_key',
    'basic',
    'api_login',
    'oauth2_client_credentials',
    'none',
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (method === 'oidc') {
      window.location.href = '/auth/login';
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/auth/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          method,
          token,
          apiKey,
          apiKeyName,
          apiKeyIn,
          username,
          password,
          loginPath,
          tokenUrl,
          clientId,
          clientSecret,
          scope,
          displayName,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        user?: Me;
        message?: string;
      };
      if (!res.ok || !data.user) {
        throw new Error(data.message || `Authentication failed (${res.status})`);
      }
      onAuthenticated(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  };

  const meta = METHOD_META[method];

  return (
    <div className="auth-shell">
      <div className="auth-split-container">
        {/* Left Enterprise Telemetry & Architecture Panel */}
        <aside className="auth-showcase">
          <div>
            <div className="auth-brand-row">
              <div className="brand-logo-mark">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 2 7 12 12 22 7 12 2" />
                  <polyline points="2 17 12 22 22 17" />
                  <polyline points="2 12 12 17 22 12" />
                </svg>
              </div>
              <span className="auth-brand-name">API Copilot</span>
              <span className="auth-version-pill">Enterprise</span>
            </div>

            <h2 className="auth-showcase-title">{apiTitle}</h2>
            <p className="auth-showcase-desc">{apiDesc}</p>

            <div className="auth-telemetry-grid">
              <div className="auth-stat-card">
                <span className="auth-stat-value">{toolCount || 20}</span>
                <span className="auth-stat-label">Curated API Tools</span>
              </div>
              <div className="auth-stat-card">
                <span className="auth-stat-value">{slashCount || 14}</span>
                <span className="auth-stat-label">Slash Commands</span>
              </div>
            </div>

            {providers?.apiBaseUrl && (
              <div className="auth-target-box">
                <span className="auth-target-label">TARGET ENDPOINT</span>
                <code>{providers.apiBaseUrl}</code>
              </div>
            )}

            {sampleTools.length > 0 && (
              <div className="auth-preview-tools">
                <span className="auth-target-label">DISCOVERED OPERATIONS</span>
                <div className="auth-preview-list">
                  {sampleTools.map((t) => (
                    <div key={t.name} className="auth-preview-item">
                      <span className={`http-badge ${t.method.toLowerCase()}`}>{t.method}</span>
                      <code className="auth-preview-path">{t.path}</code>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="auth-security-guarantees">
            <div className="guarantee-item">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span>Zero-knowledge LLM context — tokens stay in encrypted server sessions</span>
            </div>
            <div className="guarantee-item">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <span>Cryptographically signed human-in-the-loop approval for all mutations</span>
            </div>
          </div>
        </aside>

        {/* Right Authentication Form Panel */}
        <main className="auth-card">
          <div className="auth-header">
            <span className="auth-eyebrow">Authentication Gateway</span>
            <h1>Connect to {apiTitle}</h1>
            <p className="muted">
              Select an authentication protocol to authorize API calls on your behalf.
            </p>
            {schemeSummary && (
              <div className="auth-detected-banner">
                <span className="status-dot online" />
                <span>OpenAPI Security Scheme:</span> <strong>{schemeSummary}</strong>
              </div>
            )}
          </div>

          <div className="auth-tabs" role="tablist">
            {availableMethods.map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={method === m}
                className={`auth-tab ${method === m ? 'active' : ''}`}
                onClick={() => {
                  setMethod(m);
                  setError(null);
                }}
              >
                {METHOD_META[m].short}
              </button>
            ))}
          </div>

          <form className="auth-form" onSubmit={(e) => void handleSubmit(e)}>
            <div className="auth-method-info">
              <div>
                <strong>{meta.label}</strong>
                <p className="muted">{meta.desc}</p>
              </div>
              <span className="badge neutral">{meta.badge}</span>
            </div>

            {method === 'bearer' && (
              <label className="auth-field">
                <span>Bearer Token / Personal Access Token *</span>
                <input
                  type="password"
                  required
                  placeholder="eyJhbGciOi... or pat_..."
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoFocus
                />
              </label>
            )}

            {method === 'api_key' && (
              <>
                <div className="auth-row">
                  <label className="auth-field">
                    <span>Injection Target</span>
                    <select
                      value={apiKeyIn}
                      onChange={(e) => setApiKeyIn(e.target.value as 'header' | 'query')}
                    >
                      <option value="header">HTTP Request Header</option>
                      <option value="query">URL Query Parameter</option>
                    </select>
                  </label>
                  <label className="auth-field">
                    <span>{apiKeyIn === 'header' ? 'Header Name *' : 'Query Param Name *'}</span>
                    <input
                      required
                      placeholder="X-API-Key"
                      value={apiKeyName}
                      onChange={(e) => setApiKeyName(e.target.value)}
                    />
                  </label>
                </div>
                <label className="auth-field">
                  <span>API Key Secret *</span>
                  <input
                    type="password"
                    required
                    placeholder="Enter your API key"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    autoFocus
                  />
                </label>
              </>
            )}

            {method === 'basic' && (
              <div className="auth-row">
                <label className="auth-field">
                  <span>Username *</span>
                  <input
                    required
                    placeholder="Username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus
                  />
                </label>
                <label className="auth-field">
                  <span>Password *</span>
                  <input
                    type="password"
                    required
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
              </div>
            )}

            {method === 'api_login' && (
              <>
                <label className="auth-field">
                  <span>API Login Path (relative to target API) *</span>
                  <input
                    required
                    placeholder="/api/v1/login"
                    value={loginPath}
                    onChange={(e) => setLoginPath(e.target.value)}
                  />
                </label>
                <div className="auth-row">
                  <label className="auth-field">
                    <span>Username / Email *</span>
                    <input
                      required
                      placeholder="user@example.com"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoFocus
                    />
                  </label>
                  <label className="auth-field">
                    <span>Password *</span>
                    <input
                      type="password"
                      required
                      placeholder="Password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </label>
                </div>
              </>
            )}

            {method === 'oauth2_client_credentials' && (
              <>
                <label className="auth-field">
                  <span>OAuth 2.0 Token Endpoint URL *</span>
                  <input
                    type="url"
                    required
                    placeholder="https://auth.example.com/oauth/token"
                    value={tokenUrl}
                    onChange={(e) => setTokenUrl(e.target.value)}
                  />
                </label>
                <div className="auth-row">
                  <label className="auth-field">
                    <span>Client ID *</span>
                    <input
                      required
                      placeholder="client-id"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                    />
                  </label>
                  <label className="auth-field">
                    <span>Client Secret *</span>
                    <input
                      type="password"
                      required
                      placeholder="Client secret"
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                    />
                  </label>
                </div>
                <label className="auth-field">
                  <span>OAuth Scopes (optional)</span>
                  <input
                    placeholder="e.g. read:items write:items"
                    value={scope}
                    onChange={(e) => setScope(e.target.value)}
                  />
                </label>
              </>
            )}

            {method !== 'oidc' && (
              <label className="auth-field">
                <span>Session Display Name (optional)</span>
                <input
                  placeholder="e.g. Platform Operator"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </label>
            )}

            {error && <div className="auth-error">{error}</div>}

            <div className="auth-actions">
              <button type="submit" className="action-btn send auth-submit" disabled={submitting}>
                <span>
                  {submitting
                    ? 'Establishing Session…'
                    : method === 'oidc'
                      ? 'Continue with Single Sign-On'
                      : method === 'none'
                        ? 'Launch Public Session'
                        : `Authorize with ${meta.short}`}
                </span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </div>
          </form>
        </main>
      </div>
    </div>
  );
}
