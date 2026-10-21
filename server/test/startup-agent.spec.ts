import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import { buildToolSpecFromGenerated, type GeneratedToolSpec } from '../src/tools/dynamic-tool.builder';
import { StartupAgentService } from '../src/tools/startup-agent.service';
import { ToolsRegistry } from '../src/tools/tools.registry';

const makeEnv = (overrides: Record<string, unknown>) =>
  ({
    get: (k: string) => overrides[k],
  }) as never;

const SAMPLE_OPENAPI_SPEC = {
  openapi: '3.0.0',
  info: {
    title: 'PetStore Inventory API',
    description: 'Manage pets, orders, and store inventory',
    version: '1.0.0',
  },
  paths: Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => {
      const idx = i + 1;
      const isGet = idx % 2 === 1;
      const path = isGet ? `/api/v1/items/${idx}/{itemId}` : `/api/v1/items/${idx}`;
      const method = isGet ? 'get' : 'post';
      return [
        path,
        {
          [method]: {
            operationId: isGet ? `ItemsController_getItem${idx}` : `ItemsController_createItem${idx}`,
            summary: isGet ? `Get item ${idx} details` : `Create item ${idx}`,
            tags: ['Items'],
            parameters: isGet
              ? [
                  { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
                  { name: 'includeMeta', in: 'query', required: false, schema: { type: 'boolean' } },
                ]
              : [],
            ...(isGet
              ? {}
              : {
                  requestBody: {
                    required: true,
                    content: {
                      'application/json': {
                        schema: {
                          type: 'object',
                          required: ['name'],
                          properties: {
                            name: { type: 'string', description: 'Item name' },
                            status: { type: 'string', enum: ['available', 'pending', 'sold'] },
                            quantity: { type: 'integer' },
                          },
                        },
                      },
                    },
                  },
                }),
          },
        },
      ];
    }),
  ),
};

describe('StartupAgentService & Dynamic Tools', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dgpt-startup-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('inspects the API spec on first start, selects 15-25 endpoints, and saves tools & slash menu to local directory', async () => {
    const specFile = join(tempDir, 'petstore.json');
    const dataDir = join(tempDir, 'generated');
    writeFileSync(specFile, JSON.stringify(SAMPLE_OPENAPI_SPEC), 'utf8');

    const env = makeEnv({
      TOOLS_DATA_DIR: dataDir,
      OPENAPI_SPEC_PATH: specFile,
      STARTUP_AGENT_ENABLED: true,
      STARTUP_AGENT_MIN_ENDPOINTS: 15,
      STARTUP_AGENT_MAX_ENDPOINTS: 25,
      API_BASE_URL: 'http://api.test',
      LLM_BASE_URL: 'https://api.openai.com/v1',
      LLM_API_KEY: '', // triggers deterministic fallback without network call
      NODE_ENV: 'test',
    });

    const dummyModel = {} as LanguageModel;
    const agent = new StartupAgentService(env, dummyModel);
    await agent.onModuleInit();

    // Check files persisted in local directory
    expect(existsSync(join(dataDir, 'api-config.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'tools.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'slash-commands.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'system-prompt.txt'))).toBe(true);

    const loaded = agent.getLoadedConfig();
    expect(loaded).not.toBeNull();
    expect(loaded!.apiTitle).toBe('PetStore Inventory API');
    expect(loaded!.tools.length).toBeGreaterThanOrEqual(15);
    expect(loaded!.tools.length).toBeLessThanOrEqual(25);
    expect(loaded!.slashCommands.length).toBeGreaterThan(4);
    expect(loaded!.starterCards.length).toBeGreaterThan(0);

    // Verify ToolsRegistry uses the generated tools
    const registry = new ToolsRegistry(agent);
    expect(registry.specs.length).toBe(loaded!.tools.length);
    expect(registry.specs[0].name).toBe(loaded!.tools[0].name);
  });

  it('loads existing tools on restart and does NOT re-run the startup agent', async () => {
    const dataDir = join(tempDir, 'generated');
    const specFile = join(tempDir, 'petstore.json');
    writeFileSync(specFile, JSON.stringify(SAMPLE_OPENAPI_SPEC), 'utf8');

    const env = makeEnv({
      TOOLS_DATA_DIR: dataDir,
      OPENAPI_SPEC_PATH: specFile,
      STARTUP_AGENT_ENABLED: true,
      STARTUP_AGENT_MIN_ENDPOINTS: 15,
      STARTUP_AGENT_MAX_ENDPOINTS: 20,
      API_BASE_URL: 'http://api.test',
      LLM_BASE_URL: 'https://api.openai.com/v1',
      LLM_API_KEY: '',
      NODE_ENV: 'test',
    });

    const dummyModel = {} as LanguageModel;

    // First startup generates the config
    const firstAgent = new StartupAgentService(env, dummyModel);
    await firstAgent.onModuleInit();
    const firstSavedRaw = readFileSync(join(dataDir, 'api-config.json'), 'utf8');
    expect(firstSavedRaw).toContain('PetStore Inventory API');

    // Second startup (simulating app restart): spy on runDiscoveryAgent to verify it is NOT called
    const secondAgent = new StartupAgentService(env, dummyModel);
    const discoverySpy = jest.spyOn(secondAgent, 'runDiscoveryAgent');
    await secondAgent.onModuleInit();

    expect(discoverySpy).not.toHaveBeenCalled();
    expect(secondAgent.getLoadedConfig()?.apiTitle).toBe('PetStore Inventory API');
    expect(secondAgent.getLoadedConfig()?.tools.length).toBe(
      firstAgent.getLoadedConfig()?.tools.length,
    );

    // Third startup with a different API_BASE_URL automatically re-runs the startup agent
    const changedEnv = makeEnv({
      TOOLS_DATA_DIR: dataDir,
      OPENAPI_SPEC_PATH: specFile,
      STARTUP_AGENT_ENABLED: true,
      STARTUP_AGENT_MIN_ENDPOINTS: 15,
      STARTUP_AGENT_MAX_ENDPOINTS: 20,
      API_BASE_URL: 'http://new-api.test',
      LLM_BASE_URL: 'https://api.openai.com/v1',
      LLM_API_KEY: '',
      NODE_ENV: 'test',
    });
    const thirdAgent = new StartupAgentService(changedEnv, dummyModel);
    const thirdSpy = jest.spyOn(thirdAgent, 'runDiscoveryAgent');
    await thirdAgent.onModuleInit();
    expect(thirdSpy).toHaveBeenCalledTimes(1);
    expect(thirdAgent.getLoadedConfig()?.apiBaseUrl).toBe('http://new-api.test');
  });

  it('builds executable ToolSpec from GeneratedToolSpec with path, query, and body params', () => {
    const genSpec: GeneratedToolSpec = {
      name: 'update_store_order',
      description: 'Update an order in the store',
      readOnly: false,
      method: 'PUT',
      pathTemplate: '/api/v1/orders/{orderId}',
      parameters: [
        { name: 'orderId', in: 'path', type: 'string', required: true },
        { name: 'notify', in: 'query', type: 'boolean', required: false },
        {
          name: 'status',
          in: 'body',
          type: 'string',
          enum: ['pending', 'shipped', 'cancelled'],
          required: true,
        },
        { name: 'quantity', in: 'body', type: 'integer', required: false },
      ],
    };

    const toolSpec = buildToolSpecFromGenerated(genSpec);
    expect(toolSpec.name).toBe('update_store_order');
    expect(toolSpec.readOnly).toBe(false);

    // Valid input passes zod validation
    const valid = toolSpec.inputSchema.safeParse({
      orderId: 'ord-42',
      notify: true,
      status: 'shipped',
      quantity: 3,
    });
    expect(valid.success).toBe(true);

    // Invalid enum fails zod validation
    const invalid = toolSpec.inputSchema.safeParse({
      orderId: 'ord-42',
      status: 'invalid-status',
    });
    expect(invalid.success).toBe(false);

    // Request builder maps path, query, and body properly
    const req = toolSpec.buildRequest(valid.data!);
    expect(req).toEqual({
      method: 'PUT',
      path: '/api/v1/orders/ord-42',
      query: { notify: true },
      body: { status: 'shipped', quantity: 3 },
    });
  });
});
