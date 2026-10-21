import { z } from 'zod';
import type { ToolSpec } from '../types';

export const listMaps: ToolSpec = {
  name: 'list_maps',
  description: 'List all maps in the catalog (catalog ids, names, bounding areas).',
  readOnly: true,
  inputSchema: z.object({}),
  buildRequest: () => ({ method: 'GET', path: '/api/v1/map/maps' }),
};

export const getMap: ToolSpec<{ catalogId: string }> = {
  name: 'get_map',
  description: 'Get details of a single map by catalogId.',
  readOnly: true,
  inputSchema: z.object({
    catalogId: z.string().min(1).describe('map catalog id'),
  }),
  buildRequest: (args) => ({ method: 'GET', path: `/api/v1/map/map/${args.catalogId}` }),
};
