import { z } from 'zod';
import type { ApiRequest } from '../api-client/api-client.service';
import type { ToolSpec } from './types';

export interface GeneratedToolParamSpec {
  name: string;
  in: 'path' | 'query' | 'body';
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  itemType?: 'string' | 'number' | 'integer' | 'boolean';
  enum?: string[];
  required?: boolean;
  nullable?: boolean;
  description?: string;
}

export interface GeneratedToolSpec {
  name: string;
  operationId?: string;
  description: string;
  readOnly: boolean;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pathTemplate: string;
  parameters: GeneratedToolParamSpec[];
  domainKeywords?: string[];
  isCore?: boolean;
}

export interface SlashParamFieldConfig {
  key: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  options?: string[];
  required?: boolean;
}

export interface SlashCommandConfig {
  cmd: string;
  aliases?: string[];
  category: 'Read' | 'Write' | 'App';
  desc: string;
  usage?: string;
  mode: 'instant' | 'form' | 'ui';
  prompt?: string;
  openFilePicker?: boolean;
  fields?: SlashParamFieldConfig[];
  promptTemplate?: string;
  inlineArgPromptTemplate?: string;
  uiAction?: 'new' | 'theme' | 'activity' | 'threads';
}

export interface StarterCardConfig {
  title: string;
  desc: string;
  cmd: string;
}

export interface DetectedAuthConfig {
  defaultMethod:
    | 'oidc'
    | 'bearer'
    | 'api_key'
    | 'basic'
    | 'api_login'
    | 'oauth2_client_credentials'
    | 'none';
  supportedMethods: (
    | 'oidc'
    | 'bearer'
    | 'api_key'
    | 'basic'
    | 'api_login'
    | 'oauth2_client_credentials'
    | 'none'
  )[];
  apiKeyName?: string;
  apiKeyIn?: 'header' | 'query';
  loginEndpoint?: string;
  oauth2TokenUrl?: string;
  schemeSummary?: string;
}

export interface GeneratedApiConfig {
  version: 1;
  generatedAt: string;
  apiBaseUrl?: string;
  specSource?: string;
  apiTitle: string;
  apiDescription: string;
  systemPrompt: string;
  authConfig?: DetectedAuthConfig;
  tools: GeneratedToolSpec[];
  slashCommands: SlashCommandConfig[];
  starterCards: StarterCardConfig[];
}

function buildZodField(param: GeneratedToolParamSpec): z.ZodType {
  let schema: z.ZodType;

  if (param.enum && param.enum.length > 0) {
    const values = param.enum as [string, ...string[]];
    schema = param.type === 'array' ? z.array(z.enum(values)) : z.enum(values);
  } else {
    switch (param.type) {
      case 'number':
        schema = z.number();
        break;
      case 'integer':
        schema = z.number().int();
        break;
      case 'boolean':
        schema = z.boolean();
        break;
      case 'array': {
        const itemSchema =
          param.itemType === 'number'
            ? z.number()
            : param.itemType === 'integer'
              ? z.number().int()
              : param.itemType === 'boolean'
                ? z.boolean()
                : z.string();
        schema = z.array(itemSchema);
        break;
      }
      case 'object':
        schema = z.record(z.string(), z.unknown());
        break;
      case 'string':
      default:
        schema = param.required ? z.string().min(1) : z.string();
        break;
    }
  }

  if (param.nullable) {
    schema = schema.nullable();
  }
  if (!param.required) {
    schema = schema.optional();
  }
  if (param.description) {
    schema = schema.describe(param.description);
  }
  return schema;
}

export function buildToolSpecFromGenerated(gen: GeneratedToolSpec): ToolSpec<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const param of gen.parameters) {
    shape[param.name] = buildZodField(param);
  }

  const pathParams = gen.parameters.filter((p) => p.in === 'path');
  const queryParams = gen.parameters.filter((p) => p.in === 'query');
  const bodyParams = gen.parameters.filter((p) => p.in === 'body');

  return {
    name: gen.name,
    description: gen.description,
    readOnly: gen.readOnly,
    inputSchema: z.object(shape),
    buildRequest: (args: Record<string, unknown>): Omit<ApiRequest, 'token'> => {
      let path = gen.pathTemplate;
      for (const p of pathParams) {
        const val = args[p.name];
        if (val !== undefined && val !== null) {
          path = path.replace(`{${p.name}}`, encodeURIComponent(String(val)));
        }
      }
      // Also replace any remaining {param} placeholders if matched by arg name
      path = path.replace(/\{([^}]+)\}/g, (full, key: string) => {
        const val = args[key];
        return val !== undefined && val !== null ? encodeURIComponent(String(val)) : full;
      });

      const query: Record<string, unknown> = {};
      for (const p of queryParams) {
        if (args[p.name] !== undefined) {
          query[p.name] = args[p.name];
        }
      }

      let body: unknown = undefined;
      if (bodyParams.length === 1 && bodyParams[0].name === 'body' && bodyParams[0].type === 'object') {
        body = args.body;
      } else if (bodyParams.length > 0) {
        const bodyObj: Record<string, unknown> = {};
        for (const p of bodyParams) {
          if (args[p.name] !== undefined) {
            bodyObj[p.name] = args[p.name];
          }
        }
        body = bodyObj;
      }

      return {
        method: gen.method,
        path,
        ...(Object.keys(query).length > 0 ? { query } : {}),
        ...(body !== undefined ? { body } : {}),
      };
    },
  };
}
