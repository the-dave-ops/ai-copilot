#!/usr/bin/env tsx
/**
 * Prints a DRAFT ToolSpec skeleton for chosen OpenAPI operationIds so new tools
 * can be curated quickly. It does NOT auto-register anything — copy the output
 * into server/src/tools/definitions/, review it, then add it to ToolsRegistry.
 *
 * Usage:
 *   npm run gen:tools -- DeviceController_getDeviceDetails GetMapController_getMap
 *   npm run gen:tools -- --list            # list all operationIds
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const SPEC_PATH = resolve(__dirname, '../openapi/getapp-api.yaml');

interface Param {
  name: string;
  in: string;
  required?: boolean;
  schema?: Record<string, unknown>;
}
interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Param[];
  requestBody?: { content?: Record<string, { schema?: unknown }> };
}

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, unknown> };
};

const wanted = process.argv.slice(2);
const ops: { id: string; method: string; path: string; op: Operation }[] = [];
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    if (op?.operationId) ops.push({ id: op.operationId, method, path, op });
  }
}

if (wanted.length === 0 || wanted[0] === '--list') {
  for (const o of ops) console.log(`${o.method.toUpperCase().padEnd(6)} ${o.path.padEnd(58)} ${o.id}`);
  process.exit(0);
}

const schemaName = (s: unknown): string | null => {
  const ref = (s as { $ref?: string })?.$ref;
  return ref ? ref.split('/').pop()! : null;
};

for (const opId of wanted) {
  const found = ops.find((o) => o.id === opId);
  if (!found) {
    console.error(`// operationId not found: ${opId}`);
    continue;
  }
  const { method, path, op } = found;
  const params = op.parameters ?? [];
  const pathParams = params.filter((p) => p.in === 'path');
  const queryParams = params.filter((p) => p.in === 'query');
  const bodySchema = schemaName(op.requestBody?.content?.['application/json']?.schema);
  const readOnly = method.toLowerCase() === 'get';
  const toolName = opId.replace(/Controller_|^v\d_/g, '').replace(/_([a-z])/g, (_, c) => c.toUpperCase());

  const fields: string[] = [];
  for (const p of pathParams) {
    fields.push(`    ${p.name}: z.string().min(1),`);
  }
  for (const p of queryParams) {
    const t = p.schema?.type === 'number' || p.schema?.type === 'integer' ? 'z.number().int()' : 'z.string()';
    fields.push(`    ${JSON.stringify(p.name)}: ${t}.optional(),`);
  }
  if (bodySchema) {
    fields.push(`    // TODO: map ${bodySchema} fields (see openapi/getapp-api.yaml)`);
    fields.push(`    body: z.record(z.string(), z.unknown()).optional(),`);
  }

  const queryEntries = queryParams
    .map((p) => `        ${JSON.stringify(p.name)}: args[${JSON.stringify(p.name)}],`)
    .join('\n');

  console.log(`
export const ${toolName}: ToolSpec = {
  name: '${toolName.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase()).replace(/^_/, '')}',
  description: ${JSON.stringify(op.summary ?? op.description ?? 'TODO')},
  readOnly: ${readOnly},
  inputSchema: z.object({
${fields.join('\n')}
  }),
  buildRequest: (args) => ({
    method: '${method.toUpperCase()}',
    path: \`${path}\`,${queryEntries ? `\n    query: {\n${queryEntries}\n    },` : ''}${bodySchema ? '\n    body: args.body,' : ''}
  }),
};`);
}
