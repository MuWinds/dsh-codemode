import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryTools } from '../lib/discovery.js';
import { normalizeConfig } from '../lib/rules.js';

const options = normalizeConfig({ searchLimit: 3 });

const definitions = new Map([
  ['run_code', { name: 'run_code', description: 'Execute a TypeScript program', parameters: { type: 'object' } }],
  ['pwsh', {
    name: 'pwsh',
    description: 'Run commands in a PowerShell shell',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  }],
  ['mcp__okx__market_get_ticker', {
    name: 'mcp__okx__market_get_ticker',
    description: 'Get the latest ticker for an instrument',
    parameters: { type: 'object', properties: { instId: { type: 'string' } }, required: ['instId'] },
    output: { schema: { type: 'object', additionalProperties: true } },
  }],
  ['mcp__okx__place_order', {
    name: 'mcp__okx__place_order',
    description: 'Place an order on the exchange',
    parameters: { type: 'object', properties: { instId: { type: 'string' }, size: { type: 'number' } } },
  }],
]);

const ctx = {
  tools: {
    // `schemas()` is the public projection; `get()` recovers the full definition
    // (and its output schema). Both are public in dsh-tools.
    schemas: () => [...definitions.values()],
    get: (name) => definitions.get(name),
  },
};

const exec = { agent: { id: 'agent-1' } };

const debugState = { assemblies: 1, entries: [{ at: 'now', applied: true, hidden: { total: 2 } }] };

function tools() {
  const list = createDiscoveryTools(ctx, options, 'run_code', { getDebug: () => debugState });
  assert.deepEqual(list.map((tool) => tool.name), options.metaTools);
  for (const tool of list) {
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function');
    assert.ok(tool.parameters);
    assert.equal(tool.output.schema.additionalProperties, true);
  }
  return Object.fromEntries(list.map((tool) => [tool.name, tool]));
}

test('list returns every callable tool including the hidden ones, never run_code', async () => {
  const { code_tools_list: list } = tools();
  const value = await list.execute({}, exec);
  assert.deepEqual(value.tools.map((row) => row.name).sort(), [
    'mcp__okx__market_get_ticker',
    'mcp__okx__place_order',
    'pwsh',
  ]);
  assert.equal(value.total, 3);
  assert.equal(value.hidden, 2);
  assert.deepEqual(value.namespaces, [{ namespace: 'okx', count: 2, kind: 'mcp' }]);
  const ticker = value.tools.find((row) => row.name === 'mcp__okx__market_get_ticker');
  assert.equal(ticker.hidden, true);
  assert.equal(ticker.namespace, 'okx');
});

test('list supports a namespace filter', async () => {
  const { code_tools_list: list } = tools();
  const value = await list.execute({ namespace: 'native' }, exec);
  assert.deepEqual(value.tools.map((row) => row.name), ['pwsh']);
});

test('search returns full parameter schemas for the ranked hits', async () => {
  const { code_tools_search: search } = tools();
  const value = await search.execute({ query: 'ticker' }, exec);
  assert.equal(value.count, 1);
  assert.equal(value.tools[0].name, 'mcp__okx__market_get_ticker');
  assert.deepEqual(value.tools[0].parameters.properties.instId, { type: 'string' });
  assert.equal(value.tools[0].hidden, true);
});

test('search validates its query argument', async () => {
  const { code_tools_search: search } = tools();
  await assert.rejects(() => search.execute({}, exec), /"query" must be a non-empty string/);
  await assert.rejects(() => search.execute({ query: '   ' }, exec), /"query" must be a non-empty string/);
});

test('describe resolves one tool by exact name and reports misses', async () => {
  const { code_tools_describe: describe } = tools();
  const hit = await describe.execute({ name: 'mcp__okx__place_order' }, exec);
  assert.equal(hit.found, true);
  assert.equal(hit.namespace, 'okx');
  assert.deepEqual(hit.parameters.properties.size, { type: 'number' });

  const miss = await describe.execute({ name: 'mcp__nope__nothing' }, exec);
  assert.equal(miss.found, false);
  assert.match(miss.hint, /code_tools_list/);
});

test('every discovery tool declares itself concurrency-safe', () => {
  const { code_tools_list: list, code_tools_search: search, code_tools_describe: describe, code_debug: debug } = tools();
  assert.equal(list.isConcurrencySafe(), true);
  assert.equal(search.isConcurrencySafe(), true);
  assert.equal(describe.isConcurrencySafe(), true);
  assert.equal(debug.isConcurrencySafe(), true);
});

test('code_debug reports the hidden namespaces and the masking history', async () => {
  const { code_debug: debug } = tools();
  const value = await debug.execute({}, exec);
  assert.deepEqual(value.hidden.namespaces, [{ namespace: 'okx', count: 2, kind: 'mcp' }]);
  assert.equal(value.assemblies, 1);
  assert.deepEqual(value.recent, debugState.entries);
  assert.deepEqual(value.discoveryTools, options.metaTools);
  assert.equal(value.nativeScope, true);
  assert.deepEqual(value.nativeTools, []);
  assert.deepEqual(value.hiddenTools, []);
});

test('a scope key makes the listing flag out-of-preset tools, like the request masking does', async () => {
  const scopeKey = {};
  const spawn = { name: 'spawn_teammate', description: 'Create a teammate', parameters: {} };
  const agentNames = [...definitions.keys(), 'spawn_teammate'];
  const scoped = {
    tools: {
      schemas: () => [...definitions.values(), spawn],
      // Global view: the MCP server tools plus the deployment-level Team tool.
      // Preset view: everything the preset itself registered.
      // Agent view: the calling session's full chain, per-agent tools included.
      get: (name, scope) => {
        if (scope === undefined) return ['mcp__okx__market_get_ticker', 'mcp__okx__place_order'].includes(name) ? definitions.get(name) : undefined;
        if (scope === scopeKey) return name === 'spawn_teammate' ? undefined : definitions.get(name);
        if (scope !== undefined) return agentNames.includes(name) ? (definitions.get(name) ?? spawn) : undefined;
        return undefined;
      },
    },
  };
  const list = createDiscoveryTools(scoped, options, 'run_code', { scopeKey })
    .find((tool) => tool.name === options.metaTools[0]);
  const value = await list.execute({}, exec);

  const teammate = value.tools.find((row) => row.name === 'spawn_teammate');
  assert.equal(teammate.hidden, true);
  assert.equal(teammate.namespace, 'plugin');
  assert.deepEqual(value.namespaces, [
    { namespace: 'okx', count: 2, kind: 'mcp' },
    { namespace: 'plugin', count: 1, kind: 'plugin' },
  ]);
  // A preset-owned tool stays native.
  assert.equal(value.tools.find((row) => row.name === 'pwsh').hidden, false);
});

test('the debug tool is skipped without a state provider, and when debug is off', () => {
  const noProvider = createDiscoveryTools(ctx, options, 'run_code');
  assert.equal(noProvider.length, 3);
  const off = createDiscoveryTools(ctx, normalizeConfig({ debug: false }), 'run_code', { getDebug: () => debugState });
  assert.equal(off.length, 3);
});

test('an unavailable registry surface degrades to an empty listing instead of throwing', async () => {
  const bare = createDiscoveryTools({ tools: {} }, options, 'run_code');
  const value = await bare[0].execute({}, exec);
  assert.deepEqual(value.tools, []);
  assert.equal(value.total, 0);
});

test('a projection without a resolvable definition still lists the tool', async () => {
  const projectionOnly = {
    tools: {
      schemas: () => [{ name: 'pwsh', description: 'Run commands', parameters: { type: 'object' } }],
      // No `get`: the definition (and its output schema) is unavailable.
    },
  };
  const [list] = createDiscoveryTools(projectionOnly, options, 'run_code');
  const value = await list.execute({}, exec);
  assert.equal(value.total, 1);
  assert.equal(value.tools[0].name, 'pwsh');
});
