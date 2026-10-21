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

interface ConfigResponse {
  apiTitle?: string | null;
  apiDescription?: string | null;
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
    label: 'Bearer Token / JWT',
    short: 'Bearer Token',
    badge: 'Authorization: Bearer',
    desc: 'Send a Personal Access Token (PAT) or JWT in the Authorization header on every API call.',
  },
  api_key: {
    label: 'API Key',
    short: 'API Key',
    badge: 'Header or Query',
    desc: 'Send an API key in a custom request header (e.g. X-API-Key) or query string parameter.',
  },
  basic: {
    label: 'HTTP Basic Auth',
    short: 'Basic Auth',
    badge: 'Username + Password',
    desc: 'Encode username and password as Base64 in the standard HTTP Basic Authorization header.',
  },
  api_login: {
    label: 'API Login Endpoint',
    short: 'API Login',
    badge: 'POST credentials → Token',
    desc: 'Authenticate directly against the target API login endpoint to exchange credentials for a token.',
  },
  oauth2_client_credentials: {
    label: 'OAuth2 Client Credentials',
    short: 'OAuth2 Client',
    badge: 'Client ID + Secret',
    desc: 'Fetch and auto-refresh an OAuth2 access token from a token URL using Client ID and Secret.',
  },
  oidc: {
    label: 'Single Sign-On (OIDC)',
    short: 'OIDC SSO',
    badge: 'Keycloak / OAuth2 PKCE',
    desc: 'Redirect to the configured OpenID Connect identity provider to sign in with your account.',
  },
  none: {
    label: 'Public API (No Auth)',
    short: 'No Auth',
    badge: 'Public',
    desc: 'Connect without sending authentication headers (for open or public APIs).',
  },
};

export function LoginPage({ onAuthenticated }: { onAuthenticated: (me: Me) => void }) {
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [apiTitle, setApiTitle] = useState('API');
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
            document.title = `${cfg.apiTitle} Copilot`;
          }
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
      <div className="auth-card">
        <div className="auth-header">
          <div className="brand">
            <span className="brand-dot" />
            <span className="auth-brand-title">{apiTitle} Copilot</span>
          </div>
          <h1>Connect to {apiTitle}</h1>
          <p className="muted">
            Choose how to authenticate requests sent to{' '}
            <code>{providers?.apiBaseUrl || 'the target API'}</code>. Your credentials stay encrypted
            in the server session and are never exposed to the LLM.
          </p>
          {schemeSummary && (
            <div className="auth-detected-banner">
              <span>Detected API spec security:</span> <strong>{schemeSummary}</strong>
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
                  <span>Send Key In</span>
                  <select
                    value={apiKeyIn}
                    onChange={(e) => setApiKeyIn(e.target.value as 'header' | 'query')}
                  >
                    <option value="header">HTTP Header</option>
                    <option value="query">Query Parameter</option>
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
                <span>API Key Value *</span>
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
                <span>API Login Endpoint Path or URL *</span>
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
                <span>OAuth2 Token Endpoint URL *</span>
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
                    placeholder="my-client-id"
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
                <span>Scope (optional)</span>
                <input
                  placeholder="e.g. read write api"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                />
              </label>
            </>
          )}

          {method !== 'oidc' && (
            <label className="auth-field">
              <span>Display Name (optional, shown in chat header)</span>
              <input
                placeholder="e.g. Dev Admin"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>
          )}

          {error && <div className="auth-error">{error}</div>}

          <div className="auth-actions">
            <button type="submit" className="action-btn send auth-submit" disabled={submitting}>
              {submitting
                ? 'Connecting…'
                : method === 'oidc'
                  ? 'Continue with Single Sign-On →'
                  : method === 'none'
                    ? 'Continue without Authentication →'
                    : `Connect with ${meta.short} →`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
