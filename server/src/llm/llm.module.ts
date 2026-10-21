import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { Env } from '../config/env';

export const LLM_MODEL = Symbol('LLM_MODEL');

@Module({
  providers: [
    {
      provide: LLM_MODEL,
      inject: [ConfigService],
      useFactory: (env: ConfigService<Env, true>): LanguageModel => {
        const provider = createOpenAICompatible({
          name: 'llm',
          baseURL: env.get('LLM_BASE_URL'),
          apiKey: env.get('LLM_API_KEY') || undefined,
        });
        return provider.chatModel(env.get('LLM_MODEL'));
      },
    },
  ],
  exports: [LLM_MODEL],
})
export class LlmModule {}
