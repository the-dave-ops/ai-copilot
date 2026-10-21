import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { RedisStore } from 'connect-redis';
import session from 'express-session';
import { Logger } from 'nestjs-pino';
import { createClient } from 'redis';
import { AppModule } from './app.module';
import './auth/session.types';
import type { Env } from './config/env';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.flushLogs();
  const env = app.get<ConfigService<Env, true>>(ConfigService);

  const redis = createClient({ url: env.get('REDIS_URL') });
  redis.on('error', (err) => app.get(Logger).error({ err }, 'redis client error'));
  await redis.connect();

  const secureSetting = env.get('SESSION_COOKIE_SECURE');
  const secure =
    secureSetting === 'always' ||
    (secureSetting === 'auto' && env.get('APP_BASE_URL').startsWith('https:'));

  // Trust the first proxy hop so Secure cookies and req.protocol work behind an ingress
  app.set('trust proxy', 1);
  app.use(
    session({
      store: new RedisStore({ client: redis, prefix: 'dgpt:sess:' }),
      name: 'dgpt.sid',
      secret: env.get('SESSION_SECRET'),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        maxAge: env.get('SESSION_TTL_SECONDS') * 1000,
      },
    }),
  );

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(env.get('PORT'));
}
void bootstrap();
