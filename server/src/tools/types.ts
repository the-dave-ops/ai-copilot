import type { z } from 'zod';
import type { ApiClientService, ApiRequest, ApiResult } from '../api-client/api-client.service';
import type { ApiAuthPayload, AppSession } from '../auth/session.types';
import type { UploadStoreService } from './upload-store.service';

export interface ToolExecutionContext {
  session: AppSession;
  token: string;
  auth?: ApiAuthPayload;
  api: ApiClientService;
  uploads: UploadStoreService;
}

/**
 * A curated tool definition. `inputSchema` is exposed to the model and used to
 * validate arguments; `buildRequest` maps validated args to an API request;
 * `shape` optionally reduces the API payload before it is sent to the model.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolSpec<A = any> {
  name: string;
  /** Model-facing description — include usage hints and required params. */
  description: string;
  /** false = mutating; the UI requires explicit user approval before it runs. */
  readOnly: boolean;
  inputSchema: z.ZodType<A>;
  buildRequest: (args: A) => Omit<ApiRequest, 'token'>;
  /** Optional multi-step execution (e.g. create release + upload presigned artifacts). */
  execute?: (args: A, ctx: ToolExecutionContext) => Promise<ApiResult>;
  /** Optional: reduce/reshape raw API data before truncation. */
  shape?: (data: unknown) => unknown;
}
