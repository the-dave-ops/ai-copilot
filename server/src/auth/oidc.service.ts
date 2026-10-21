import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as client from 'openid-client';
import type { Env } from '../config/env';

@Injectable()
export class OidcService implements OnModuleInit {
  private readonly logger = new Logger(OidcService.name);
  private config: client.Configuration | null = null;

  constructor(private readonly env: ConfigService<Env, true>) {}

  async onModuleInit() {
    const issuerRaw = this.env.get('KEYCLOAK_ISSUER_URL');
    const clientId = this.env.get('KEYCLOAK_CLIENT_ID');
    const clientSecret = this.env.get('KEYCLOAK_CLIENT_SECRET');

    if (!issuerRaw || !clientId || !clientSecret) {
      this.logger.log(
        'KEYCLOAK_ISSUER_URL / KEYCLOAK_CLIENT_ID not fully configured; OIDC SSO is disabled (other auth methods remain available).',
      );
      return;
    }

    const issuer = new URL(issuerRaw);
    const options: client.DiscoveryRequestOptions = {};

    // Local/dev Keycloak often runs on plain http — allow it only for http issuers
    if (issuer.protocol === 'http:') {
      options.execute = [client.allowInsecureRequests];
    }

    // Split-horizon: the browser-facing issuer (e.g. http://localhost:8080) may
    // differ from what this service can reach (e.g. http://keycloak:8080).
    // Rewrite only server-side calls; the issuer string stays untouched so
    // validation and browser-facing endpoints keep working.
    const internalBase = this.env.get('KEYCLOAK_INTERNAL_URL');
    if (internalBase) {
      const internal = new URL(internalBase);
      options[client.customFetch] = (input, init) => {
        const url = new URL(input);
        if (url.origin !== issuer.origin) {
          return fetch(input, init);
        }
        url.protocol = internal.protocol;
        url.host = internal.host;
        return fetch(url, init);
      };
    }

    try {
      this.config = await client.discovery(
        issuer,
        clientId,
        clientSecret,
        undefined,
        options,
      );
      this.logger.log(`Discovered OIDC issuer ${issuer.href}`);
    } catch (err) {
      this.logger.warn(
        `OIDC issuer discovery failed (${err instanceof Error ? err.message : String(err)}); OIDC SSO will be unavailable until reachable.`,
      );
    }
  }

  get isAvailable(): boolean {
    return this.config !== null;
  }

  get clientConfig(): client.Configuration {
    if (!this.config) {
      throw new Error('OIDC is not configured or unreachable');
    }
    return this.config;
  }

  get redirectUri(): string {
    return `${this.env.get('APP_BASE_URL')}/auth/callback`;
  }

  get scope(): string {
    return this.env.get('KEYCLOAK_SCOPE');
  }
}
