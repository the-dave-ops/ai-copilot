import { z } from 'zod';
import type { ToolSpec } from '../types';

const projectTypeEnum = z.enum([
  'product',
  'application',
  'lib',
  'bundle',
  'infra',
  'config',
  'config_map',
]);

export const createProject: ToolSpec<{
  name: string;
  projectName?: string;
  description?: string;
  projectType?: z.infer<typeof projectTypeEnum>;
  label?: string;
}> = {
  name: 'create_project',
  description:
    'Create a new project. `name` is the unique slug identifier; `projectName` is the display name.',
  readOnly: false,
  inputSchema: z.object({
    name: z.string().min(1).describe('unique project slug'),
    projectName: z.string().optional().describe('display name'),
    description: z.string().optional(),
    projectType: projectTypeEnum.optional(),
    label: z.string().optional(),
  }),
  buildRequest: (args) => ({
    method: 'POST',
    path: '/api/v1/project',
    body: {
      name: args.name,
      projectName: args.projectName,
      description: args.description,
      projectType: args.projectType,
      label: args.label,
    },
  }),
};

interface ArtifactInitResponse {
  artifactId?: number;
  uploadUrl?: string;
  uploadId?: string;
  objectKey?: string;
  partSize?: number;
  partCount?: number;
  urls?: { partNumber: number; url: string }[];
}

export const createRelease: ToolSpec<{
  projectIdentifier: string;
  version: string;
  name?: string;
  releaseNotes?: string;
  status?: 'draft' | 'in_review' | 'approved' | 'released' | 'archived' | 'error';
  dependencies?: string[];
  fileIds?: string[];
  isInstallationFile?: boolean;
}> = {
  name: 'create_release',
  description:
    'Create or update a release (version) for a project, optionally uploading attached files (pass their `fileIds` from the user message). Defaults to draft unless `status` is given.',
  readOnly: false,
  inputSchema: z.object({
    projectIdentifier: z.string().min(1).describe('project id or name'),
    version: z.string().min(1).describe('semver-ish version string'),
    name: z.string().optional(),
    releaseNotes: z.string().optional(),
    status: z
      .enum(['draft', 'in_review', 'approved', 'released', 'archived', 'error'])
      .optional(),
    dependencies: z.array(z.string()).optional(),
    fileIds: z
      .array(z.string().min(1))
      .optional()
      .describe('fileIds of user-uploaded files to attach as release artifacts'),
    isInstallationFile: z.boolean().optional(),
  }),
  buildRequest: (args) => ({
    method: 'POST',
    path: `/api/v1/catalog/releases/project/${args.projectIdentifier}`,
    body: {
      version: args.version,
      name: args.name,
      releaseNotes: args.releaseNotes,
      status: args.status,
      dependencies: args.dependencies,
    },
  }),
  execute: async (args, { session, token, api, uploads }) => {
    const hasFiles = Boolean(args.fileIds?.length);
    const initialStatus = hasFiles && args.status && args.status !== 'draft' ? 'draft' : args.status;

    const releaseRes = await api.request({
      method: 'POST',
      path: `/api/v1/catalog/releases/project/${args.projectIdentifier}`,
      token,
      body: {
        version: args.version,
        name: args.name,
        releaseNotes: args.releaseNotes,
        status: initialStatus,
        dependencies: args.dependencies,
      },
    });
    if (!releaseRes.ok || !hasFiles) return releaseRes;

    const uploadedArtifacts: { fileName: string; artifactId?: number; size: number }[] = [];
    for (const fileId of args.fileIds ?? []) {
      const staged = uploads.getForSession(session.id, fileId);
      if (!staged) {
        return {
          ok: false,
          status: 400,
          message: `Uploaded file ${fileId} not found in current session (please re-attach the file).`,
        };
      }
      const { meta, buffer } = staged;
      const artRes = await api.request({
        method: 'POST',
        path: `/api/v1/catalog/releases/project/${args.projectIdentifier}/version/${args.version}/artifact`,
        token,
        body: {
          artifactName: meta.fileName,
          type: 'file',
          isInstallationFile: args.isInstallationFile ?? true,
          isExecutable: false,
          fileSize: meta.size,
        },
      });
      if (!artRes.ok) return artRes;

      const init = (artRes.data ?? {}) as ArtifactInitResponse;
      if (init.uploadId && init.urls?.length && init.objectKey && init.partSize) {
        const parts: { partNumber: number; eTag: string }[] = [];
        for (const part of init.urls) {
          const start = (part.partNumber - 1) * init.partSize;
          const end = Math.min(start + init.partSize, buffer.length);
          const putRes = await fetch(part.url, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream' },
            body: new Uint8Array(buffer.subarray(start, end)),
          });
          if (!putRes.ok) {
            return {
              ok: false,
              status: putRes.status,
              message: `Failed uploading part ${part.partNumber} for ${meta.fileName} (HTTP ${putRes.status})`,
            };
          }
          const eTag = (putRes.headers.get('etag') ?? '').replace(/"/g, '');
          parts.push({ partNumber: part.partNumber, eTag });
        }
        const completeRes = await api.request({
          method: 'POST',
          path: '/api/v1/upload/multipart/complete',
          token,
          body: { uploadId: init.uploadId, objectKey: init.objectKey, parts },
        });
        if (!completeRes.ok) return completeRes;
      } else if (init.uploadUrl) {
        const putRes = await fetch(init.uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': meta.mimeType || 'application/octet-stream' },
          body: new Uint8Array(buffer),
        });
        if (!putRes.ok) {
          return {
            ok: false,
            status: putRes.status,
            message: `Failed uploading ${meta.fileName} to storage (HTTP ${putRes.status})`,
          };
        }
      } else {
        return {
          ok: false,
          status: 500,
          message: `API did not return an uploadUrl for artifact ${meta.fileName}`,
        };
      }

      uploads.remove(session.id, fileId);
      uploadedArtifacts.push({
        fileName: meta.fileName,
        artifactId: init.artifactId,
        size: meta.size,
      });
    }

    if (args.status && args.status !== 'draft') {
      const finalRes = await api.request({
        method: 'POST',
        path: `/api/v1/catalog/releases/project/${args.projectIdentifier}`,
        token,
        body: {
          version: args.version,
          name: args.name,
          releaseNotes: args.releaseNotes,
          status: args.status,
          dependencies: args.dependencies,
        },
      });
      if (!finalRes.ok) return finalRes;
      return {
        ok: true,
        status: finalRes.status,
        data: { release: finalRes.data, uploadedArtifacts },
      };
    }

    return {
      ok: true,
      status: releaseRes.status,
      data: { release: releaseRes.data, uploadedArtifacts },
    };
  },
};

export const pushOffering: ToolSpec<{
  catalogId: string;
  devices: string[];
  itemType: 'software' | 'map' | 'cache' | 'config';
  groups?: number[];
}> = {
  name: 'push_offering',
  description:
    'Push (deploy) a catalog component to a set of devices or groups. Use get_project_offering to find catalogIds.',
  readOnly: false,
  inputSchema: z.object({
    catalogId: z.string().min(1),
    devices: z.array(z.string()).min(1).describe('device ids'),
    itemType: z.enum(['software', 'map', 'cache', 'config']),
    groups: z.array(z.number().int()).optional().describe('group ids'),
  }),
  buildRequest: (args) => ({
    method: 'POST',
    path: '/api/v1/catalog/offering/push',
    body: {
      catalogId: args.catalogId,
      devices: args.devices,
      itemType: args.itemType,
      groups: args.groups,
    },
  }),
};

export const updateDeviceProps: ToolSpec<{
  deviceId: string;
  name?: string;
  orgUID?: string | null;
  groupId?: number | null;
}> = {
  name: 'update_device_props',
  description:
    'Update device properties: rename, set/remove org UID, or set/remove group association.',
  readOnly: false,
  inputSchema: z.object({
    deviceId: z.string().min(1),
    name: z.string().optional(),
    orgUID: z.string().nullable().optional().describe('null removes the org UID'),
    groupId: z.number().int().nullable().optional().describe('null removes group association'),
  }),
  buildRequest: (args) => ({
    method: 'PUT',
    path: `/api/v1/device/${args.deviceId}`,
    body: { name: args.name, orgUID: args.orgUID, groupId: args.groupId },
  }),
};

export const addProjectMember: ToolSpec<{
  projectIdentifier: string;
  email: string;
  role: 'project-owner' | 'project-admin' | 'project-member';
}> = {
  name: 'add_project_member',
  description: 'Add a member to a project with a given role.',
  readOnly: false,
  inputSchema: z.object({
    projectIdentifier: z.string().min(1),
    email: z.string().email(),
    role: z.enum(['project-owner', 'project-admin', 'project-member']),
  }),
  buildRequest: (args) => ({
    method: 'POST',
    path: `/api/v1/project/${args.projectIdentifier}/member`,
    body: { email: args.email, role: args.role },
  }),
};

export const editProjectMember: ToolSpec<{
  projectIdentifier: string;
  memberId: string;
  role: 'project-owner' | 'project-admin' | 'project-member';
}> = {
  name: 'edit_project_member',
  description: "Change a project member's role.",
  readOnly: false,
  inputSchema: z.object({
    projectIdentifier: z.string().min(1),
    memberId: z.string().min(1),
    role: z.enum(['project-owner', 'project-admin', 'project-member']),
  }),
  buildRequest: (args) => ({
    method: 'PUT',
    path: `/api/v1/project/${args.projectIdentifier}/member/${args.memberId}`,
    body: { role: args.role },
  }),
};

export const removeProjectMember: ToolSpec<{
  projectIdentifier: string;
  memberId: string;
}> = {
  name: 'remove_project_member',
  description: 'Remove a member from a project.',
  readOnly: false,
  inputSchema: z.object({
    projectIdentifier: z.string().min(1),
    memberId: z.string().min(1),
  }),
  buildRequest: (args) => ({
    method: 'DELETE',
    path: `/api/v1/project/${args.projectIdentifier}/member/${args.memberId}`,
  }),
};

export const editProject: ToolSpec<{
  projectIdentifier: string;
  name?: string;
  projectName?: string;
  description?: string;
  projectType?: z.infer<typeof projectTypeEnum>;
  label?: string;
}> = {
  name: 'edit_project',
  description: 'Update project fields (display name, description, type, label).',
  readOnly: false,
  inputSchema: z.object({
    projectIdentifier: z.string().min(1),
    name: z.string().optional(),
    projectName: z.string().optional(),
    description: z.string().optional(),
    projectType: projectTypeEnum.optional(),
    label: z.string().optional(),
  }),
  buildRequest: (args) => ({
    method: 'PUT',
    path: `/api/v1/project/${args.projectIdentifier}`,
    body: {
      name: args.name,
      projectName: args.projectName,
      description: args.description,
      projectType: args.projectType,
      label: args.label,
    },
  }),
};

export const deleteRelease: ToolSpec<{ projectIdentifier: string; version: string }> = {
  name: 'delete_release',
  description: 'Delete a specific release version of a project.',
  readOnly: false,
  inputSchema: z.object({
    projectIdentifier: z.string().min(1),
    version: z.string().min(1),
  }),
  buildRequest: (args) => ({
    method: 'DELETE',
    path: `/api/v1/catalog/releases/project/${args.projectIdentifier}/version/${args.version}`,
  }),
};

export const unpushOffering: ToolSpec<{
  catalogId: string;
  devices: string[];
  itemType: 'software' | 'map' | 'cache' | 'config';
  groups?: number[];
}> = {
  name: 'unpush_offering',
  description: 'Withdraw a pushed catalog component from devices or groups.',
  readOnly: false,
  inputSchema: z.object({
    catalogId: z.string().min(1),
    devices: z.array(z.string()).min(1),
    itemType: z.enum(['software', 'map', 'cache', 'config']),
    groups: z.array(z.number().int()).optional(),
  }),
  buildRequest: (args) => ({
    method: 'POST',
    path: '/api/v1/catalog/offering/unpush',
    body: {
      catalogId: args.catalogId,
      devices: args.devices,
      itemType: args.itemType,
      groups: args.groups,
    },
  }),
};

export const acceptPendingVersion: ToolSpec<{
  projectName: string;
  version: string;
  isDraft?: boolean;
  reason?: string;
}> = {
  name: 'accept_pending_version',
  description:
    'Accept a pending catalog version (use list_pending_versions to find projectName/version).',
  readOnly: false,
  inputSchema: z.object({
    projectName: z.string().min(1),
    version: z.string().min(1),
    isDraft: z.boolean().optional(),
    reason: z.string().optional(),
  }),
  buildRequest: (args) => ({
    method: 'POST',
    path: '/api/v1/catalog/pendingVersions/accept',
    body: args,
  }),
};

export const rejectPendingVersion: ToolSpec<{
  projectName: string;
  version: string;
  reason?: string;
}> = {
  name: 'reject_pending_version',
  description: 'Reject a pending catalog version, optionally with a reason.',
  readOnly: false,
  inputSchema: z.object({
    projectName: z.string().min(1),
    version: z.string().min(1),
    reason: z.string().optional(),
  }),
  buildRequest: (args) => ({
    method: 'POST',
    path: '/api/v1/catalog/pendingVersions/reject',
    body: args,
  }),
};

export const createGroup: ToolSpec<{ name: string; description?: string; parent?: number }> = {
  name: 'create_group',
  description: 'Create an org device group; omit parent for a root group.',
  readOnly: false,
  inputSchema: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parent: z.number().int().optional(),
  }),
  buildRequest: (args) => ({ method: 'POST', path: '/api/v1/org/groups', body: args }),
};

export const editGroup: ToolSpec<{ groupId: number; name?: string; description?: string }> = {
  name: 'edit_group',
  description: 'Rename a group or change its description.',
  readOnly: false,
  inputSchema: z.object({
    groupId: z.number().int(),
    name: z.string().optional(),
    description: z.string().optional(),
  }),
  buildRequest: (args) => ({
    method: 'PUT',
    path: `/api/v1/org/groups/${args.groupId}`,
    body: { name: args.name, description: args.description },
  }),
};

export const deleteGroup: ToolSpec<{ groupId: number }> = {
  name: 'delete_group',
  description: 'Delete an org device group by id.',
  readOnly: false,
  inputSchema: z.object({ groupId: z.number().int() }),
  buildRequest: (args) => ({ method: 'DELETE', path: `/api/v1/org/groups/${args.groupId}` }),
};

export const setGroupChildren: ToolSpec<{
  groupId: number;
  parent?: number | null;
  devices?: string[];
  childGroups?: number[];
}> = {
  name: 'set_group_children',
  description:
    'Set a group\'s parent and/or attach device platform ids and child groups to it.',
  readOnly: false,
  inputSchema: z.object({
    groupId: z.number().int(),
    parent: z.number().int().nullable().optional().describe('null removes the parent'),
    devices: z.array(z.string()).optional().describe('device platform ids'),
    childGroups: z.array(z.number().int()).optional(),
  }),
  buildRequest: (args) => ({
    method: 'POST',
    path: '/api/v1/org/groups/childs',
    body: { id: args.groupId, parent: args.parent, platforms: args.devices, groups: args.childGroups },
  }),
};

const commandActions = z.enum([
  'Discovery',
  'Push',
  'DeliveryStart',
  'DeliveryStop',
  'DeliveryCancel',
  'DeliveryDelete',
  'DeployStart',
  'MetadataRequest',
]);

export const sendDeviceCommand: ToolSpec<{
  deviceId: string | string[];
  action: z.infer<typeof commandActions>;
  catalogId?: string;
  correlationId?: string;
}> = {
  name: 'send_device_command',
  description:
    'Send a reactive command to connected device(s): a single id, an array of ids, or "all". Actions like Push/DeployStart usually need catalogId.',
  readOnly: false,
  inputSchema: z.object({
    deviceId: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    action: commandActions,
    catalogId: z.string().optional(),
    correlationId: z.string().optional(),
  }),
  buildRequest: (args) => ({
    method: 'POST',
    path: '/api/v1/device/reactive/command',
    body: args,
  }),
};

export const deleteDevice: ToolSpec<{ deviceId: string }> = {
  name: 'delete_device',
  description: 'Delete/unregister a device. Destructive — confirm details with the user first.',
  readOnly: false,
  inputSchema: z.object({ deviceId: z.string().min(1) }),
  buildRequest: (args) => ({ method: 'DELETE', path: `/api/v1/device/${args.deviceId}` }),
};
