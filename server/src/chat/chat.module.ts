import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LlmModule } from '../llm/llm.module';
import { ToolsModule } from '../tools/tools.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatThrottlerGuard } from './chat-throttler.guard';

@Module({
  imports: [AuthModule, LlmModule, ToolsModule],
  controllers: [ChatController],
  providers: [ChatService, ChatThrottlerGuard],
})
export class ChatModule {}
