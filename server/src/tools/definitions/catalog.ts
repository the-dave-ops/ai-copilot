import { z } from 'zod';
import type { ToolSpec } from '../types';

export const getProjectOffering: ToolSpec<{
  projectIdentifier: string;
  deviceTypeIdentifier?: string;
  platformIdentifier?: string;
}> = {
  name: 'get_project_offering',
  description:
    'Get the catalog offering for a project — which components/versions are offered to devices.',
  readOnly: true,
  inputSchema: z.object({
    projectIdentifier: z.string().min(1).describe('project id or name'),
    deviceTypeIdentifier: z.string().optional(),
    platformIdentifier: z.string().optional(),
  }),
  buildRequest: (args) => ({
    method: 'GET',
    path: `/api/v1/catalog/offering/projects/${args.projectIdentifier}`,
    query: {
      deviceTypeIdentifier: args.deviceTypeIdentifier,
      platformIdentifier: args.platformIdentifier,
    },
  }),
};

export const listPendingVersions: ToolSpec = {
  name: 'list_pending_versions',
  description:
    'List catalog releases awaiting review/approval. Use before accept_pending_version or reject_pending_version.',
  readOnly: true,
  inputSchema: z.object({}),
  buildRequest: () => ({ method: 'GET', path: '/api/v1/catalog/pendingVersions' }),
};
