import type { Session, SessionData } from 'express-session';

/**
 * Everything stored in the server-side session. The browser only ever
 * receives the opaque session cookie — none of this leaves the server.
 */

/** req.session is typed by express as Session & SessionData; mirror that here. */
export type AppSession = Session & SessionData;

export interface SessionUser {
  sub: string;
  email?: string;
  name?: string;
  roles: string[];
}

export type AuthMethod =
  | 'oidc'
  | 'bearer'
  | 'api_key'
  | 'basic'
  | 'api_login'
  | 'oauth2_client_credentials'
  | 'none';

export interface ApiAuthPayload {
  method: AuthMethod;
  /** Header map to attach to outgoing API requests (e.g. Authorization or X-API-Key) */
  headers?: Record<string, string>;
  /** Query parameters to attach to outgoing API requests (e.g. api_key=...) */
  query?: Record<string, string>;
}

export interface AuthSession {
  method?: AuthMethod;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** epoch milliseconds at which the access token expires */
  expiresAt: number;
  user: SessionUser;
  /** Method-specific credentials stored server-side only */
  apiKeyIn?: 'header' | 'query';
  apiKeyName?: string;
  clientCredentials?: {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    scope?: string;
  };
}

export interface OidcFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
}

declare module 'express-session' {
  interface SessionData {
    oidc?: OidcFlowState;
    auth?: AuthSession;
    /** cached token-exchange result, keyed to the current user token */
    exchangedToken?: { token: string; expiresAt: number; forAccessToken: string };
  }
}
