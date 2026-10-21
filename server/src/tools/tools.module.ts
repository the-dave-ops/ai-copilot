import { Module } from '@nestjs/common';
import { ApiClientModule } from '../api-client/api-client.module';
import { AuthModule } from '../auth/auth.module';
import { StateStoreService } from '../common/state-store.service';
import { LlmModule } from '../llm/llm.module';
import { StartupAgentService } from './startup-agent.service';
import { ToolExecutorService } from './tool-executor.service';
import { ToolsRegistry } from './tools.registry';
import { UploadStoreService } from './upload-store.service';

@Module({
  imports: [ApiClientModule, AuthModule, LlmModule],
  providers: [
    StartupAgentService,
    ToolsRegistry,
    ToolExecutorService,
    UploadStoreService,
    StateStoreService,
  ],
  exports: [
    StartupAgentService,
    ToolsRegistry,
    ToolExecutorService,
    UploadStoreService,
    StateStoreService,
  ],
})
export class ToolsModule {}
