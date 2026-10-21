import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { join } from 'path';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { validateEnv } from './config/env';
import { HealthController } from './common/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, cache: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        autoLogging: {
          ignore: (req) => (req as { url?: string }).url === '/health',
        },
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-api-key"]',
            'res.headers["set-cookie"]',
          ],
          censor: '[redacted]',
        },
        serializers: {
          // log path only — query strings may carry tokens from foreign clients
          req: (req) => ({ id: req.id, method: req.method, url: req.url?.split('?')[0] }),
          res: (res) => ({ statusCode: res.statusCode }),
        },
      },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      exclude: ['/api/{*splat}', '/auth/{*splat}'],
    }),
    AuthModule,
    ChatModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
