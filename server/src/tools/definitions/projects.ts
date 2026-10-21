import { z } from 'zod';
import type { ToolSpec } from '../types';

export const listProjects: ToolSpec = {
  name: 'list_projects',
  description: "List the projects the current user is a member of.",
  readOnly: true,
  inputSchema: z.object({}),
  buildRequest: () => ({ method: 'GET', path: '/api/v1/project' }),
};

const projectTypes = z
  .array(z.enum(['product', 'application', 'lib', 'bundle', 'infra', 'config', 'config_map']))
  .optional();

export const searchProjects: ToolSpec<{
  query?: string;
  status?: string;
  page?: number;
  perPage?: number;
  projectTypes?: ('product' | 'application' | 'lib' | 'bundle' | 'infra' | 'config' | 'config_map')[];
}> = {
  name: 'search_projects',
  description:
    'Search projects by free-text query with optional status/type filters and pagination.',
  readOnly: true,
  inputSchema: z.object({
    query: z.string().optional().describe('free-text search'),
    status: z.string().optional().describe('e.g. active, archived'),
    page: z.number().int().positive().optional(),
    perPage: z.number().int().positive().max(50).optional(),
    projectTypes,
  }),
  buildRequest: (args) => ({
    method: 'GET',
    path: '/api/v1/project/search',
    query: {
      query: args.query,
      status: args.status,
      page: args.page,
      perPage: args.perPage,
      projectTypes: args.projectTypes,
    },
  }),
};

export const getProject: ToolSpec<{ projectIdentifier: string }> = {
  name: 'get_project',
  description:
    'Get a project by its identifier (id or name). Returns metadata, members count and configuration summary.',
  readOnly: true,
  inputSchema: z.object({
    projectIdentifier: z.string().min(1).describe('project id or name'),
  }),
  buildRequest: (args) => ({ method: 'GET', path: `/api/v1/project/${args.projectIdentifier}` }),
};

export const getProjectReleases: ToolSpec<{ projectIdentifier: string }> = {
  name: 'get_project_releases',
  description:
    'List the releases (versions) of a project — use this when asked "what versions does X have".',
  readOnly: true,
  inputSchema: z.object({
    projectIdentifier: z.string().min(1).describe('project id or name'),
  }),
  buildRequest: (args) => ({
    method: 'GET',
    path: `/api/v1/project/${args.projectIdentifier}/projectReleases`,
  }),
};

export const getReleaseDetails: ToolSpec<{ projectIdentifier: string; version: string }> = {
  name: 'get_release_details',
  description:
    'Get detailed information about a specific project release version, including its uploaded artifacts, status, dependencies, and policies.',
  readOnly: true,
  inputSchema: z.object({
    projectIdentifier: z.string().min(1).describe('project id or name'),
    version: z.string().min(1).describe('release version string'),
  }),
  buildRequest: (args) => ({
    method: 'GET',
    path: `/api/v1/catalog/releases/project/${args.projectIdentifier}/version/${args.version}`,
  }),
};
