import { z } from 'zod';
import type { ToolSpec } from '../types';

export const listGroups: ToolSpec = {
  name: 'list_groups',
  description: 'List the organization device groups (id, name, parent, number of devices).',
  readOnly: true,
  inputSchema: z.object({}),
  buildRequest: () => ({ method: 'GET', path: '/api/v1/org/groups' }),
};
