import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { ApiAuthGuard } from './auth.guard';
import { OidcService } from './oidc.service';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController],
  providers: [
    OidcService,
    TokenService,
    { provide: APP_GUARD, useClass: ApiAuthGuard },
  ],
  exports: [OidcService, TokenService],
})
export class AuthModule {}
