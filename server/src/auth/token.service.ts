import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as client from 'openid-client';
import type { ApiAuthPayload, AppSession, AuthMethod, SessionUser } from './session.types';
import type { Env } from '../config/env';
import { OidcService } from './oidc.service';

const REFRESH_WINDOW_MS = 30_000;
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;

/**
 * Resolves a valid access token or full ApiAuthPayload for a session.
 * Supports:
 * - OIDC SSO (`oidc`) with automatic refresh + optional token exchange
 * - Bearer Token / Personal Access Token (`bearer`)
 * - API Key in custom header or query param (`api_key`)
 * - HTTP Basic Auth (`basic`)
 * - Direct API Login endpoint (`api_login`)
 * - OAuth2 Client Credentials (`oauth2_client_credentials`) with auto re-fetch on expiry
 * - Public / No-Auth (`none`)
 */
@Injectable()
export class TokenService {
  private readonly refreshLocks = new Map<string, Promise<string>>();

  constructor(
    private readonly oidc: OidcService,
    private readonly env: ConfigService<Env, true>,
  ) {}

  async getValidAccessToken(session: AppSession): Promise<string> {
    const auth = session.auth;
    if (!auth) {
      throw new UnauthorizedException('Not authenticated');
    }

    const method: AuthMethod = auth.method ?? 'oidc';

    if (method === 'none') {
      return '';
    }

    if (method === 'bearer' || method === 'api_key' || method === 'basic' || method === 'api_login') {
      return auth.accessToken;
    }

    if (method === 'oauth2_client_credentials') {
      if (auth.expiresAt - Date.now() < REFRESH_WINDOW_MS && auth.clientCredentials) {
        return this.refreshClientCredentials(session);
      }
      return auth.accessToken;
    }

    // Default: OIDC flow
    const userToken =
      auth.expiresAt - Date.now() < REFRESH_WINDOW_MS
        ? await this.refreshWithLock(session)
        : auth.accessToken;

    if (!this.env.get('ENABLE_TOKEN_EXCHANGE')) {
      return userToken;
    }
    return this.exchangeToken(session, userToken);
  }

  async getValidApiAuth(session: AppSession): Promise<ApiAuthPayload> {
    const auth = session.auth;
    if (!auth) {
      throw new UnauthorizedException('Not authenticated');
    }
    const method: AuthMethod = auth.method ?? 'oidc';
    const token = await this.getValidAccessToken(session);

    if (method === 'none') {
      return { method: 'none' };
    }

    if (method === 'api_key') {
      const keyName = auth.apiKeyName || this.env.get('API_KEY_HEADER') || 'X-API-Key';
      if (auth.apiKeyIn === 'query') {
        return { method: 'api_key', query: { [keyName]: token } };
      }
      return { method: 'api_key', headers: { [keyName]: token } };
    }

    if (method === 'basic') {
      return {
        method: 'basic',
        headers: { authorization: `Basic ${token}` },
      };
    }

    // oidc, bearer, api_login, oauth2_client_credentials all use Bearer header
    return {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    };
  }

  private async refreshClientCredentials(session: AppSession): Promise<string> {
    const creds = session.auth?.clientCredentials;
    if (!creds) {
      throw new UnauthorizedException('Client credentials missing');
    }
    const res = await this.fetchOAuth2ClientCredentialsToken(
      creds.tokenUrl,
      creds.clientId,
      creds.clientSecret,
      creds.scope,
    );
    session.auth!.accessToken = res.accessToken;
    session.auth!.expiresAt = Date.now() + res.expiresIn * 1000;
    if (typeof session.save === 'function') {
      await new Promise<void>((resolve) => session.save(() => resolve()));
    }
    return res.accessToken;
  }

  async fetchOAuth2ClientCredentialsToken(
    tokenUrl: string,
    clientId: string,
    clientSecret: string,
    scope?: string,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      ...(scope ? { scope } : {}),
    });
    const basicHeader = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
    let res: Response;
    try {
      res = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          authorization: `Basic ${basicHeader}`,
        },
        body: body.toString(),
        signal: AbortSignal.timeout(12_000),
      });
    } catch (err) {
      throw new UnauthorizedException(
        `OAuth2 token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new UnauthorizedException(`OAuth2 token request failed with HTTP ${res.status}`);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const accessToken = String(data.access_token ?? data.token ?? '');
    if (!accessToken) {
      throw new UnauthorizedException('OAuth2 endpoint did not return an access_token');
    }
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    return { accessToken, expiresIn };
  }

  storeManualAuth(
    session: AppSession,
    opts: {
      method: AuthMethod;
      accessToken: string;
      user: SessionUser;
      expiresInSeconds?: number;
      refreshToken?: string;
      apiKeyIn?: 'header' | 'query';
      apiKeyName?: string;
      clientCredentials?: {
        tokenUrl: string;
        clientId: string;
        clientSecret: string;
        scope?: string;
      };
    },
  ): SessionUser {
    const expiresAt = opts.expiresInSeconds
      ? Date.now() + opts.expiresInSeconds * 1000
      : Date.now() + ONE_YEAR_MS;

    session.auth = {
      method: opts.method,
      accessToken: opts.accessToken,
      refreshToken: opts.refreshToken,
      expiresAt,
      user: opts.user,
      apiKeyIn: opts.apiKeyIn,
      apiKeyName: opts.apiKeyName,
      clientCredentials: opts.clientCredentials,
    };
    return opts.user;
  }

  private refreshWithLock(session: AppSession): Promise<string> {
    const key = session.id;
    const existing = this.refreshLocks.get(key);
    if (existing) {
      return existing;
    }
    const pending = this.doRefresh(session).finally(() => {
      this.refreshLocks.delete(key);
    });
    this.refreshLocks.set(key, pending);
    return pending;
  }

  private async doRefresh(session: AppSession): Promise<string> {
    const auth = session.auth;
    if (!auth?.refreshToken) {
      session.destroy(() => undefined);
      throw new UnauthorizedException('Session expired');
    }
    // Another caller may have refreshed while we waited for the lock
    if (auth.expiresAt - Date.now() >= REFRESH_WINDOW_MS) {
      return auth.accessToken;
    }
    try {
      const tokens = await client.refreshTokenGrant(
        this.oidc.clientConfig,
        auth.refreshToken,
      );
      this.storeTokens(session, tokens, auth.user);
      if (typeof session.save === 'function') {
        await new Promise<void>((resolve) => session.save(() => resolve()));
      }
      return session.auth!.accessToken;
    } catch {
      if (typeof session.destroy === 'function') {
        session.destroy(() => undefined);
      }
      throw new UnauthorizedException('Session refresh failed — please log in again');
    }
  }

  private async exchangeToken(session: AppSession, userToken: string): Promise<string> {
    const cached = session.exchangedToken;
    if (
      cached &&
      cached.forAccessToken === userToken &&
      cached.expiresAt - Date.now() > REFRESH_WINDOW_MS
    ) {
      return cached.token;
    }
    try {
      const tokens = await client.genericGrantRequest(
        this.oidc.clientConfig,
        TOKEN_EXCHANGE_GRANT,
        {
          subject_token: userToken,
          subject_token_type: ACCESS_TOKEN_TYPE,
          requested_token_type: ACCESS_TOKEN_TYPE,
          audience: this.env.get('TOKEN_EXCHANGE_AUDIENCE')!,
        },
      );
      const expiresAt =
        Date.now() + (typeof tokens.expires_in === 'number' ? tokens.expires_in : 300) * 1000;
      session.exchangedToken = { token: tokens.access_token, expiresAt, forAccessToken: userToken };
      if (typeof session.save === 'function') {
        await new Promise<void>((resolve) => session.save(() => resolve()));
      }
      return tokens.access_token;
    } catch {
      throw new UnauthorizedException('Token exchange failed');
    }
  }

  storeTokens(
    session: AppSession,
    tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers,
    fallbackUser?: SessionUser,
  ): SessionUser {
    const claims = tokens.claims();
    const user: SessionUser = claims
      ? {
          sub: claims.sub,
          email: typeof claims.email === 'string' ? claims.email : undefined,
          name:
            typeof claims.name === 'string'
              ? claims.name
              : typeof claims.preferred_username === 'string'
                ? claims.preferred_username
                : undefined,
          roles: extractRoles(claims as Record<string, unknown>),
        }
      : (fallbackUser ?? { sub: 'unknown', roles: [] });

    const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 300;
    session.auth = {
      method: 'oidc',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? session.auth?.refreshToken,
      idToken: tokens.id_token ?? session.auth?.idToken,
      expiresAt: Date.now() + expiresIn * 1000,
      user,
    };
    return user;
  }
}

function extractRoles(claims: Record<string, unknown>): string[] {
  const roles = new Set<string>();
  const realm = claims.realm_access as { roles?: unknown } | undefined;
  if (Array.isArray(realm?.roles)) {
    realm.roles.forEach((r) => typeof r === 'string' && roles.add(r));
  }
  const resource = claims.resource_access as Record<string, { roles?: unknown }> | undefined;
  for (const entry of Object.values(resource ?? {})) {
    if (Array.isArray(entry?.roles)) {
      entry.roles.forEach((r) => typeof r === 'string' && roles.add(r));
    }
  }
  return [...roles];
}
