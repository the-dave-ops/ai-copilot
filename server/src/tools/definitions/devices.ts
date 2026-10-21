import { z } from 'zod';
import type { ToolSpec } from '../types';

export const listDevices: ToolSpec<{ groups?: string[] }> = {
  name: 'list_devices',
  description:
    'List registered devices, optionally filtered by group names. Returns device ids, names, connection state and group info.',
  readOnly: true,
  inputSchema: z.object({
    groups: z.array(z.string()).optional().describe('filter by group names'),
  }),
  buildRequest: (args) => ({
    method: 'GET',
    path: '/api/v1/device/devices',
    query: { groups: args.groups },
  }),
};

export const getDevice: ToolSpec<{ deviceId: string }> = {
  name: 'get_device',
  description:
    'Get details of a single device by its deviceId (status, OS, platform, group, last seen).',
  readOnly: true,
  inputSchema: z.object({
    deviceId: z.string().min(1).describe('the device identifier'),
  }),
  buildRequest: (args) => ({ method: 'GET', path: `/api/v1/device/${args.deviceId}` }),
};

export const getDeviceSoftware: ToolSpec<{ deviceId: string }> = {
  name: 'get_device_software',
  description: 'List the software components installed on a device.',
  readOnly: true,
  inputSchema: z.object({
    deviceId: z.string().min(1).describe('the device identifier'),
  }),
  buildRequest: (args) => ({ method: 'GET', path: `/api/v1/device/${args.deviceId}/softwares` }),
};

export const getDeviceMaps: ToolSpec<{ deviceId: string }> = {
  name: 'get_device_maps',
  description: 'List the maps installed on a device.',
  readOnly: true,
  inputSchema: z.object({
    deviceId: z.string().min(1).describe('the device identifier'),
  }),
  buildRequest: (args) => ({ method: 'GET', path: `/api/v1/device/${args.deviceId}/maps` }),
};
