import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import * as client from 'openid-client';
import type { Env } from '../config/env';
import { AuthGuard } from './auth.guard';
import { OidcService } from './oidc.service';
import type { AuthMethod, SessionUser } from './session.types';
import { TokenService } from './token.service';

interface CredentialsLoginBody {
  method?: AuthMethod;
  token?: string;
  apiKey?: string;
  apiKeyName?: string;
  apiKeyIn?: 'header' | 'query';
  username?: string;
  password?: string;
  loginPath?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  displayName?: string;
}

function hashCredentialId(prefix: string, secret: string): string {
  const digest = createHash('sha256').update(secret).digest('hex').slice(0, 16);
  return `${prefix}:${digest}`;
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower === 'metadata.google.internal'
  ) {
    return true;
  }
  const ipVer = isIP(lower);
  if (ipVer === 4) {
    const parts = lower.split('.').map(Number);
    if (parts[0] === 127 || parts[0] === 10 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
  } else if (ipVer === 6) {
    if (lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
      return true;
    }
  }
  return false;
}

function tryDecodeJwtUser(jwt: string, fallbackLabel: string): SessionUser {
  const parts = jwt.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      const rawSub = payload.sub ?? payload.user_id ?? payload.id ?? payload.preferred_username;
      const sub = rawSub ? String(rawSub) : hashCredentialId('jwt', jwt);
      const email = typeof payload.email === 'string' ? payload.email : undefined;
      const name =
        typeof payload.name === 'string'
          ? payload.name
          : typeof payload.preferred_username === 'string'
            ? payload.preferred_username
            : fallbackLabel;
      return { sub, email, name, roles: [] };
    } catch {
      // not a standard JWT
    }
  }
  return { sub: hashCredentialId('token', jwt), name: fallbackLabel, roles: [] };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly oidc: OidcService,
    private readonly tokens: TokenService,
    private readonly env: ConfigService<Env, true>,
  ) {}

  @Get('providers')
  getProviders() {
    return {
      oidcEnabled: this.oidc.isAvailable,
      apiBaseUrl: this.env.get('API_BASE_URL'),
      defaultApiKeyHeader: this.env.get('API_KEY_HEADER') || 'X-API-Key',
      defaultLoginPath: this.env.get('API_LOGIN_PATH') || '/api/v1/login',
      defaultOAuth2TokenUrl: this.env.get('OAUTH2_TOKEN_URL') || '',
      methods: [
        'bearer',
        'api_key',
        'basic',
        'api_login',
        'oauth2_client_credentials',
        ...(this.oidc.isAvailable ? (['oidc'] as const) : []),
        'none',
      ],
    };
  }

  @Post('credentials')
  async loginWithCredentials(@Req() req: Request, @Body() rawBody: unknown) {
    const body = (rawBody ?? {}) as CredentialsLoginBody;
    const method = body.method ?? 'bearer';

    let accessToken = '';
    let refreshToken: string | undefined;
    let expiresInSeconds: number | undefined;
    let apiKeyIn: 'header' | 'query' | undefined;
    let apiKeyName: string | undefined;
    let clientCredentials:
      | { tokenUrl: string; clientId: string; clientSecret: string; scope?: string }
      | undefined;
    let user: SessionUser;

    if (method === 'none') {
      const label = body.displayName?.trim() || 'Guest User';
      user = { sub: `guest-${req.session.id.slice(0, 8)}`, name: label, roles: [] };
    } else if (method === 'bearer') {
      const tok = (body.token ?? '').trim().replace(/^Bearer\s+/i, '');
      if (!tok) {
        throw new BadRequestException('Bearer token is required');
      }
      accessToken = tok;
      const label = body.displayName?.trim() || 'Bearer Token User';
      user = tryDecodeJwtUser(tok, label);
    } else if (method === 'api_key') {
      const key = (body.apiKey ?? body.token ?? '').trim();
      if (!key) {
        throw new BadRequestException('API Key value is required');
      }
      accessToken = key;
      apiKeyIn = body.apiKeyIn === 'query' ? 'query' : 'header';
      apiKeyName = (body.apiKeyName ?? '').trim() || this.env.get('API_KEY_HEADER') || 'X-API-Key';
      const label = body.displayName?.trim() || `API Key (${apiKeyName})`;
      user = { sub: hashCredentialId(`apikey:${apiKeyName}`, key), name: label, roles: [] };
    } else if (method === 'basic') {
      const username = (body.username ?? '').trim();
      const password = body.password ?? '';
      if (!username || !password) {
        throw new BadRequestException('Username and password are required for Basic Auth');
      }
      accessToken = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
      user = {
        sub: hashCredentialId(`basic:${username}`, accessToken),
        name: body.displayName?.trim() || username,
        roles: [],
      };
    } else if (method === 'api_login') {
      const username = (body.username ?? '').trim();
      const password = body.password ?? '';
      if (!username || !password) {
        throw new BadRequestException('Username and password are required');
      }
      const apiBase = new URL(this.env.get('API_BASE_URL'));
      const loginPath = (body.loginPath ?? '').trim() || this.env.get('API_LOGIN_PATH') || '/api/v1/login';
      let loginUrl: URL;
      try {
        loginUrl = new URL(loginPath, apiBase);
      } catch {
        throw new BadRequestException('Invalid login endpoint path');
      }
      if (loginUrl.origin !== apiBase.origin) {
        throw new BadRequestException(
          `Login endpoint must belong to the configured API origin (${apiBase.origin})`,
        );
      }

      let res: globalThis.Response;
      try {
        res = await fetch(loginUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            username,
            userName: username,
            email: username,
            password,
          }),
          signal: AbortSignal.timeout(12_000),
        });
      } catch (err) {
        throw new UnauthorizedException(
          `Failed to reach login endpoint ${loginUrl.pathname}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!res.ok) {
        throw new UnauthorizedException(`API login failed with HTTP ${res.status}`);
      }
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const nestedTokens =
        typeof data.tokens === 'object' && data.tokens !== null
          ? (data.tokens as Record<string, unknown>)
          : typeof data.data === 'object' && data.data !== null
            ? (data.data as Record<string, unknown>)
            : {};
      const extractedToken = String(
        data.accessToken ??
          data.access_token ??
          data.token ??
          data.jwt ??
          data.id_token ??
          nestedTokens.accessToken ??
          nestedTokens.access_token ??
          nestedTokens.token ??
          '',
      );
      if (!extractedToken) {
        throw new UnauthorizedException(
          'API login succeeded but no token field (accessToken/access_token/token/jwt) was found in response',
        );
      }
      accessToken = extractedToken;
      const extractedRefresh =
        data.refreshToken ?? data.refresh_token ?? nestedTokens.refreshToken ?? nestedTokens.refresh_token;
      if (typeof extractedRefresh === 'string' && extractedRefresh) {
        refreshToken = extractedRefresh;
      }
      user = tryDecodeJwtUser(extractedToken, body.displayName?.trim() || username);
    } else if (method === 'oauth2_client_credentials') {
      const configuredTokenUrl = this.env.get('OAUTH2_TOKEN_URL');
      const tokenUrl = configuredTokenUrl || (body.tokenUrl ?? '').trim();
      const clientId = (body.clientId ?? '').trim();
      const clientSecret = body.clientSecret ?? '';
      const scope = (body.scope ?? '').trim() || undefined;
      if (!tokenUrl || !clientId || !clientSecret) {
        throw new BadRequestException(
          'Token URL, Client ID, and Client Secret are required for OAuth2 Client Credentials',
        );
      }
      let parsedTokenUrl: URL;
      try {
        parsedTokenUrl = new URL(tokenUrl);
      } catch {
        throw new BadRequestException('Invalid OAuth2 token URL');
      }
      if (parsedTokenUrl.protocol !== 'https:' && parsedTokenUrl.protocol !== 'http:') {
        throw new BadRequestException('OAuth2 token URL must use http or https');
      }
      const apiBaseOrigin = new URL(this.env.get('API_BASE_URL')).origin;
      if (
        !configuredTokenUrl &&
        parsedTokenUrl.origin !== apiBaseOrigin &&
        isPrivateOrLoopbackHost(parsedTokenUrl.hostname)
      ) {
        throw new BadRequestException(
          'OAuth2 token URL cannot target private/internal hosts unless explicitly set via OAUTH2_TOKEN_URL',
        );
      }
      const tokenRes = await this.tokens.fetchOAuth2ClientCredentialsToken(
        parsedTokenUrl.href,
        clientId,
        clientSecret,
        scope,
      );
      accessToken = tokenRes.accessToken;
      expiresInSeconds = tokenRes.expiresIn;
      clientCredentials = { tokenUrl: parsedTokenUrl.href, clientId, clientSecret, scope };
      user = {
        sub: hashCredentialId(`client:${clientId}`, clientSecret),
        name: body.displayName?.trim() || `OAuth2 (${clientId})`,
        roles: [],
      };
    } else {
      throw new BadRequestException(`Unsupported authentication method: ${String(method)}`);
    }

    if (typeof req.session.regenerate === 'function') {
      await new Promise<void>((resolve, reject) =>
        req.session.regenerate((err) => (err ? reject(err) : resolve())),
      );
    }

    this.tokens.storeManualAuth(req.session, {
      method,
      accessToken,
      refreshToken,
      expiresInSeconds,
      user,
      apiKeyIn,
      apiKeyName,
      clientCredentials,
    });

    if (typeof req.session.save === 'function') {
      await new Promise<void>((resolve, reject) =>
        req.session.save((err) => (err ? reject(err) : resolve())),
      );
    }

    return {
      ok: true,
      user: {
        sub: user.sub,
        email: user.email,
        name: user.name,
        roles: user.roles,
        authMethod: method,
        dashboardBaseUrl: this.env.get('DASHBOARD_BASE_URL')?.replace(/\/$/, ''),
      },
    };
  }

  @Get('login')
  async login(@Req() req: Request, @Res() res: Response) {
    if (!this.oidc.isAvailable) {
      res.redirect('/?login=1');
      return;
    }
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();

    req.session.oidc = { state, nonce, codeVerifier };
    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );

    const url = client.buildAuthorizationUrl(this.oidc.clientConfig, {
      redirect_uri: this.oidc.redirectUri,
      scope: this.oidc.scope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    res.redirect(url.href);
  }

  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const flow = req.session.oidc;
    if (!flow) {
      throw new BadRequestException('No login flow in progress');
    }
    // Consume the one-time OIDC challenge immediately to prevent replay
    delete req.session.oidc;

    let tokens;
    try {
      const currentUrl = new URL(req.originalUrl, this.env.get('APP_BASE_URL'));
      tokens = await client.authorizationCodeGrant(this.oidc.clientConfig, currentUrl, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
      });
    } catch {
      await new Promise<void>((resolve) => req.session.save(() => resolve()));
      throw new UnauthorizedException('Login failed');
    }

    // Rotate the session id after authentication to prevent session fixation
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    this.tokens.storeTokens(req.session, tokens);
    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );
    res.redirect('/');
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() req: Request) {
    const auth = req.session.auth!;
    const { user } = auth;
    return {
      sub: user.sub,
      email: user.email,
      name: user.name,
      roles: user.roles,
      authMethod: auth.method ?? 'oidc',
      apiKeyName: auth.apiKeyName,
      dashboardBaseUrl: this.env.get('DASHBOARD_BASE_URL')?.replace(/\/$/, ''),
    };
  }

  @Get('logout')
  @Post('logout')
  logout(@Req() req: Request, @Res() res: Response) {
    const fetchSite = req.headers?.['sec-fetch-site'];
    if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
      throw new ForbiddenException('Cross-origin logout blocked');
    }
    const appOrigin = new URL(this.env.get('APP_BASE_URL')).origin;
    const referer = req.headers?.origin ?? req.headers?.referer;
    if (typeof referer === 'string' && referer) {
      try {
        if (new URL(referer).origin !== appOrigin) {
          throw new ForbiddenException('Cross-origin logout blocked');
        }
      } catch (err) {
        if (err instanceof ForbiddenException) throw err;
        throw new ForbiddenException('Invalid Referer header');
      }
    }

    const idToken = req.session.auth?.idToken;
    req.session.destroy(async () => {
      res.clearCookie('dgpt.sid');
      if (idToken && this.oidc.isAvailable) {
        try {
          const endSessionUrl = client.buildEndSessionUrl(this.oidc.clientConfig, {
            id_token_hint: idToken,
          });
          await fetch(endSessionUrl.href, { method: 'GET', redirect: 'manual' });
        } catch {
          // best-effort backchannel SSO logout
        }
      }
      res.redirect('/');
    });
  }
}
