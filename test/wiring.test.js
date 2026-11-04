import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../lib/index.js';
import { markNested } from '../lib/executor.js';

/** The tag `@deepseek-ai/dsh-scope` writes onto a preset-scoped context. */
const SCOPE_TAG = Symbol('dsh.scope');

/** Fixture layer assignment: the layer each tool is registered in. */
const LAYERS = {
  // The preset's own composition: its standard rows plus this package.
  preset: ['pwsh', 'code_run', 'code_tools_list', 'code_tools_search', 'code_tools_describe', 'code_debug'],
  // The global layer: MCP client tools and other deployment-level bundles.
  // `run_code` is deliberately absent: DSH 0.2.2 reserves that name and
  // `tools.register()` throws on it, so it can never reach an executor's
  // `describe()` input. The `RESERVED_RUN_TOOL` rule is covered in
  // rules.test.js.
  global: ['mcp_probe', 'mcp__fake__get_ticker', 'mcp__fake__place_order', 'mcp__fake__account_balance'],
  // The agent layer: tools a plugin registers through `agent.ctx`.
  agent: ['spawn_teammate'],
};

/** A definition with the schema fields the registry projects. */
function definition(name, description, extra = {}) {
  return { name, description, parameters: { type: 'object', properties: {} }, ...extra };
}

const definitions = new Map([
  ['pwsh', definition('pwsh', 'Run commands in a PowerShell shell', { isConcurrencySafe: () => true })],
  ['code_run', definition('code_run', 'Program transport')],
  ['mcp_probe', definition('mcp_probe', 'Probe an MCP server')],
  ['spawn_teammate', definition('spawn_teammate', 'Create a teammate')],
  ['mcp__fake__get_ticker', definition('mcp__fake__get_ticker', 'Get the latest ticker')],
  ['mcp__fake__place_order', definition('mcp__fake__place_order', 'Place an order')],
  ['mcp__fake__account_balance', definition('mcp__fake__account_balance', 'Read the balance')],
  ['code_tools_list', definition('code_tools_list', 'List tools')],
  ['code_tools_search', definition('code_tools_search', 'Search tools')],
  ['code_tools_describe', definition('code_tools_describe', 'Describe a tool')],
  ['code_debug', definition('code_debug', 'Report masking')],
]);

/** One name's resolved definition, given the layers the caller's scope sees. */
function resolve(name, visibleLayers) {
  for (const layer of visibleLayers) {
    if (LAYERS[layer].includes(name)) return definitions.get(name);
  }
  return undefined;
}

/**
 * Minimal Cordis-shaped context that captures everything apply() wires.
 *
 * The fake registry models the three layers the real one has, so the scope rule
 * is exercised exactly as it is in DSH: `get(name)` is the global view and
 * `get(name, scopeKey)` adds the preset's own layer.
 *
 * The registry in DSH 0.2.2 asks the selected executor for the model-facing
 * schemas, so `executor.describe(definitions(agent))` is the request surface and
 * this harness reproduces that call directly.
 */
function harness(config = {}, { runtime, globalScope = false } = {}) {
  const registered = [];
  const sections = [];
  const effects = [];
  const logs = [];
  const forwarded = [];
  const presetKey = {};
  const agentKey = {};
  // The delegate stands in for the deployment's native executor: it records
  // what reached it, which is exactly what a real pipeline would have executed.
  const createDelegate = () => ({
    describe: (tools) => ({ schemas: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })) }),
    execute: async (input) => {
      forwarded.push(...(input.calls ?? []).map((call) => call.name));
      return {
        results: (input.calls ?? []).map((call) => ({
          callId: call.id,
          result: { isError: false, value: { ok: call.name }, content: [] },
        })),
        additionalContexts: [],
        concluded: false,
      };
    },
  });
  let executor;
  const visibleFor = (scope) => {
    if (scope === undefined) return ['global'];
    if (scope === agentKey) return ['global', 'preset', 'agent'];
    if (scope === presetKey) return ['global', 'preset'];
    return ['global'];
  };
  /** Everything a scope can see, as `describe()` receives it. */
  const definitionsFor = (scope = agentKey) => visibleFor(scope)
    .flatMap((layer) => LAYERS[layer])
    .map((name) => definitions.get(name));
  const ctx = {
    logger: {
      info: (message) => logs.push(['info', String(message)]),
      warn: (message) => logs.push(['warn', String(message)]),
      debug: (message) => logs.push(['debug', String(message)]),
    },
    get: (service) => {
      if (service === 'ptcRuntime') return runtime;
      if (service === 'systemPrompt') return { getSectionOrder: () => 5000 };
      return undefined;
    },
    effect: (factory, label) => {
      const entry = { disposer: factory(), label };
      effects.push(entry);
      return () => {
        effects.splice(effects.indexOf(entry), 1);
        return entry.disposer?.();
      };
    },
    tools: {
      register: (definition) => {
        registered.push(definition);
        // The real registry makes a registered tool visible in the scope that
        // registered it, so a custom transport name must join the preset layer.
        if (!definitions.has(definition.name)) {
          definitions.set(definition.name, definition);
          LAYERS.preset.push(definition.name);
        }
        return () => {};
      },
      setExecutor: (candidate) => {
        executor = candidate;
        return () => {};
      },
      schemas: (scope) => definitionsFor(scope),
      definitions: (scope) => definitionsFor(scope),
      get: (name, scope) => resolve(name, visibleFor(scope)),
      execute: async (input) => ({ results: [], additionalContexts: [], concluded: false }),
    },
    on: () => () => {},
  };
  // Mounted inside the preset: the context inherits the preset's scope tag.
  // Mounted at the host level (`globalScope: true`) there is no tag at all.
  if (!globalScope) ctx[SCOPE_TAG] = presetKey;
  apply(ctx, { ...config, createDelegate });
  /** What the model would see for one assembly. */
  const describeFor = (scope = agentKey) => executor.describe(definitionsFor(scope));
  return { registered, sections, logs, effects, ctx, presetKey, agentKey, executor, describeFor, definitionsFor, forwarded };
}

/** The names the current request would carry. */
function catalogFor(result) {
  return result.schemas.map((schema) => schema.name);
}

test('apply registers the discovery tools plus one transport, each with a valid definition', () => {
  const { registered } = harness();
  assert.deepEqual(registered.map((tool) => tool.name), [
    'code_tools_list',
    'code_tools_search',
    'code_tools_describe',
    'code_debug',
    'code_run',
  ]);
  for (const tool of registered) {
    assert.ok(tool.description.length > 0);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.output.schema.additionalProperties, true);
    assert.equal(typeof tool.execute, 'function');
  }
});

test('the transport never claims the reserved run_code name', () => {
  const { registered } = harness();
  assert.ok(!registered.some((tool) => tool.name === 'run_code'));
});

test('apply installs exactly one executor, which is the request surface', () => {
  const { executor } = harness();
  assert.ok(executor, 'apply must install a ToolExecutor');
  assert.equal(typeof executor.describe, 'function');
  assert.equal(typeof executor.execute, 'function');
});

test('describe() masks everything outside the preset and keeps the composition plus the transport', () => {
  const { describeFor, logs } = harness();
  const result = describeFor();
  assert.deepEqual(catalogFor(result), ['pwsh', 'code_run']);

  // 4 masked: 3 MCP-named tools plus the global plugin bundle `mcp_probe`.
  // `spawn_teammate` is the agent layer and is masked too, hence plugin=2.
  const maskLogs = logs.filter(([level, message]) => level === 'info' && message.includes('masked'));
  assert.equal(maskLogs.length, 1);
  assert.match(maskLogs[0][1], /masked 5 non-standard tool\(s\) \(fake=3, plugin=2\)/);
  assert.match(maskLogs[0][1], /request tools: pwsh, code_run/);
});

test('the executor supplies the Code Mode section in place of the generated SDK', () => {
  const { executor, definitionsFor } = harness();
  assert.equal(executor.sections.length, 1);
  const [section] = executor.sections;
  assert.equal(section.name, 'tools:sdk');
  assert.equal(section.interpolate, false);
  // Resolve the text the way the registry does: after describe() has run, so
  // the masked-tool counts are the ones this assembly saw.
  executor.describe(definitionsFor());
  const text = section.text();
  assert.match(text, /## Code Mode/);
  assert.match(text, /`code_run`/);
  assert.match(text, /`fake` \(MCP server\) — 3 tool\(s\)/);
  assert.match(text, /`plugin` \(contributed by plugins outside this preset\) — 2 tool\(s\)/);
  // No hidden tool's own name leaks into the request surface.
  assert.doesNotMatch(text, /mcp__fake__get_ticker/);
});

test('the section reports the masking counts from the last describe()', () => {
  const { executor, definitionsFor } = harness();
  executor.describe(definitionsFor());
  const text = executor.sections[0].text();
  assert.match(text, /5 tool\(s\) are outside this preset/);
});

test('nativeTools pins a foreign tool back into the request, hiddenTools does the reverse', () => {
  const { describeFor } = harness({ nativeTools: ['spawn_teammate', 'mcp_probe'], hiddenTools: ['pwsh'] });
  const names = catalogFor(describeFor());
  assert.ok(!names.includes('pwsh'), 'hiddenTools removes a preset-owned tool');
  assert.ok(names.includes('mcp_probe'), 'nativeTools pins a global tool');
  assert.ok(names.includes('spawn_teammate'), 'nativeTools pins an agent-layer tool');
  assert.ok(names.includes('code_run'));
});

test('the transports stay native even when listed in hiddenTools', () => {
  const { describeFor } = harness({ hiddenTools: ['code_run'] });
  const names = catalogFor(describeFor());
  assert.ok(names.includes('code_run'), 'the transport is never hidden, whatever the config says');
});

test('nativeScope false keeps deployment-level tools native', () => {
  const { describeFor } = harness({ nativeScope: false });
  const names = catalogFor(describeFor());
  assert.ok(names.includes('mcp_probe'));
  assert.ok(names.includes('spawn_teammate'));
  assert.ok(names.includes('pwsh'));
});

test('a host-level mount has no scope tag: the scope rule degrades to name rules', () => {
  const { describeFor, logs } = harness({}, { globalScope: true });
  const names = catalogFor(describeFor());
  // Without a scope tag only the name rules apply: agent-layer and
  // deployment-bundle tools are not MCP-prefixed, so they stay in the request.
  assert.ok(names.includes('spawn_teammate'));
  assert.ok(names.includes('mcp_probe'));
  // The `mcp__` prefix rule still hides MCP tools.
  assert.ok(!names.includes('mcp__fake__get_ticker'));
  assert.ok(logs.some(([level, message]) => level === 'warn' && message.includes('no registry scope tag')));
});

test('apply owns a plugin-scope effect that disposes the retention registry', async () => {
  const { effects } = harness();
  const retentionEffect = effects.find((entry) => entry.label === 'dsh-codemode retained environments');
  assert.ok(retentionEffect, 'unloading the plugin must release retained environments');
  await retentionEffect.disposer?.();
});

test('execute() denies a model-direct call to a masked tool and forwards the rest', async () => {
  const { executor } = harness();
  const denied = await executor.execute({
    calls: [{ id: 'call-1', name: 'mcp__fake__get_ticker', arguments: '{}' }],
    agent: {},
    signal: new AbortController().signal,
  });
  const result = denied.results[0].result;
  assert.equal(result.isError, true);
  assert.match(result.error.message, /code_tools_search/);
  assert.match(result.error.message, /code_run/);

  // An agent-layer tool is denied the same way.
  const agentDenied = await executor.execute({
    calls: [{ id: 'call-1b', name: 'spawn_teammate', arguments: '{}' }],
    agent: {},
    signal: new AbortController().signal,
  });
  assert.equal(agentDenied.results[0].result.isError, true);
});

test('execute() lets a program sub-call through, marked on the signal or by call id', async () => {
  const { executor, forwarded } = harness();
  // A marked signal is what the transport hands the registry.
  const marked = markNested(new AbortController().signal);
  await executor.execute({
    calls: [{ id: 'call-1', name: 'mcp__fake__get_ticker', arguments: '{}' }],
    agent: {},
    signal: marked,
  });
  assert.deepEqual(forwarded, ['mcp__fake__get_ticker'], 'a marked signal marks the call as program-nested');

  // The `:ptc:` call-id suffix is the second, belt-and-braces signal.
  forwarded.length = 0;
  await executor.execute({
    calls: [{ id: 'call-1:ptc:1', name: 'mcp__fake__get_ticker', arguments: '{}' }],
    agent: {},
    signal: new AbortController().signal,
  });
  assert.deepEqual(forwarded, ['mcp__fake__get_ticker']);
});

test('execute() forwards a batch of preset-owned tools untouched', async () => {
  const { executor, forwarded } = harness();
  const result = await executor.execute({
    calls: [{ id: 'call-1', name: 'pwsh', arguments: '{}' }],
    agent: {},
    signal: new AbortController().signal,
  });
  assert.deepEqual(forwarded, ['pwsh']);
  assert.equal(result.results[0].result.isError, false);
});

test('guard false skips the denial, sdkSection false drops the section', async () => {
  const { executor, describeFor, forwarded } = harness({ guard: false, sdkSection: false, debug: false });
  assert.equal(executor.sections.length, 0);

  // With the denial off, a masked name reaches the delegate.
  await executor.execute({
    calls: [{ id: 'call-1', name: 'mcp__fake__get_ticker', arguments: '{}' }],
    agent: {},
    signal: new AbortController().signal,
  });
  assert.deepEqual(forwarded, ['mcp__fake__get_ticker']);

  // The catalog is still masked: the executor is the only catalog provider.
  assert.deepEqual(catalogFor(describeFor()), ['pwsh', 'code_run']);
});

test('a custom runToolName reaches the denial, the section text and the registered tool', async () => {
  const { registered, executor, describeFor, definitionsFor } = harness({ runToolName: 'my_run' });
  assert.ok(registered.some((tool) => tool.name === 'my_run'));
  const names = catalogFor(describeFor());
  assert.ok(names.includes('my_run'));

  executor.describe(definitionsFor());
  assert.match(executor.sections[0].text(), /`my_run`/);

  const denied = await executor.execute({
    calls: [{ id: 'c', name: 'mcp__fake__get_ticker', arguments: '{}' }],
    agent: {},
    signal: new AbortController().signal,
  });
  assert.match(denied.results[0].result.error.message, /my_run/);
});

test('a retained runtime switches the section to REPL syntax', () => {
  const { executor, definitionsFor } = harness({}, { runtime: { programFormat: 'repl' } });
  executor.describe(definitionsFor());
  const text = executor.sections[0].text();
  assert.match(text, /retained TypeScript REPL/);
  assert.doesNotMatch(text, /run as the body of an async function/);
});

test('debug false drops the debug tool but keeps the other three', () => {
  const { registered } = harness({ debug: false });
  assert.deepEqual(registered.map((tool) => tool.name), [
    'code_tools_list',
    'code_tools_search',
    'code_tools_describe',
    'code_run',
  ]);
});

test('code_debug reports the executor decisions, which proves masking ran', async () => {
  const { registered, executor, definitionsFor } = harness();
  executor.describe(definitionsFor());
  const debug = registered.find((tool) => tool.name === 'code_debug');
  const value = await debug.execute({}, { agent: undefined });
  assert.equal(value.assemblies, 1);
  assert.equal(value.recent[0].hidden.total, 5);
});

