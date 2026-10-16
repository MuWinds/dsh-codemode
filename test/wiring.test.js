import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../lib/index.js';

/** The tag `@deepseek-ai/dsh-scope` writes onto a preset-scoped context. */
const SCOPE_TAG = Symbol('dsh.scope');

/** Fixture layer assignment: the layer each tool is registered in. */
const LAYERS = {
  // The preset's own composition: its standard rows plus this package.
  preset: ['pwsh', 'code_run', 'code_tools_list', 'code_tools_search', 'code_tools_describe', 'code_debug'],
  // The global layer: MCP client tools and other deployment-level bundles.
  global: ['run_code', 'mcp_probe', 'mcp__fake__get_ticker', 'mcp__fake__place_order', 'mcp__fake__account_balance'],
  // The agent layer: tools a plugin registers through `agent.ctx`.
  agent: ['spawn_teammate'],
};

const definitions = new Map([
  ['run_code', { name: 'run_code', description: 'PTC transport' }],
  ['pwsh', { name: 'pwsh', description: 'Run commands in a PowerShell shell' }],
  ['code_run', { name: 'code_run', description: 'Program transport' }],
  ['mcp_probe', { name: 'mcp_probe', description: 'Probe an MCP server' }],
  ['spawn_teammate', { name: 'spawn_teammate', description: 'Create a teammate' }],
  ['mcp__fake__get_ticker', { name: 'mcp__fake__get_ticker', description: 'Get the latest ticker' }],
  ['mcp__fake__place_order', { name: 'mcp__fake__place_order', description: 'Place an order' }],
  ['mcp__fake__account_balance', { name: 'mcp__fake__account_balance', description: 'Read the balance' }],
  ['code_tools_list', { name: 'code_tools_list', description: 'List tools' }],
  ['code_tools_search', { name: 'code_tools_search', description: 'Search tools' }],
  ['code_tools_describe', { name: 'code_tools_describe', description: 'Describe a tool' }],
  ['code_debug', { name: 'code_debug', description: 'Report masking' }],
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
 * `get(name, scopeKey)` adds the preset's own layer (and, for an agent scope,
 * the agent layer on top).
 */
function harness(config = {}, { runtime, globalScope = false } = {}) {
  const registered = [];
  const guards = [];
  const listeners = [];
  const effects = [];
  const logs = [];
  const presetKey = {};
  const agentKey = {};
  const visibleFor = (scope) => {
    if (scope === undefined) return ['global'];
    if (scope === agentKey) return ['global', 'preset', 'agent'];
    if (scope === presetKey) return ['global', 'preset'];
    return ['global'];
  };
  const ctx = {
    logger: {
      info: (message) => logs.push(['info', String(message)]),
      warn: (message) => logs.push(['warn', String(message)]),
      debug: (message) => logs.push(['debug', String(message)]),
    },
    get: (name) => (name === 'ptcRuntime' ? runtime : undefined),
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
        return () => {};
      },
      guard: (guard) => {
        guards.push(guard);
        return () => {};
      },
      schemas: (scope) => visibleFor(scope).flatMap((layer) => LAYERS[layer]).map((name) => definitions.get(name)),
      get: (name, scope) => resolve(name, visibleFor(scope)),
      view: () => ({ visible: definitions, knownNames: new Set(definitions.keys()), restrictableNames: new Set(definitions.keys()) }),
      executionMode: () => ({ kind: 'exclusive' }),
      execute: async () => ({ isError: false, value: null }),
    },
    on: (event, listener, options) => {
      listeners.push({ event, listener, options });
      return () => {};
    },
  };
  // Mounted inside the preset: the context inherits the preset's scope tag.
  // Mounted at the host level (`globalScope: true`) there is no tag at all.
  if (!globalScope) ctx[SCOPE_TAG] = presetKey;
  apply(ctx, config);
  // The context dsh-agent-loop hands `systemPrompt.assemble()`: the calling
  // session's scope plus the agent identity.
  return { registered, guards, listeners, logs, effects, ctx, presetKey, agentKey, context: { scope: agentKey, agent: { id: 'agent-1' } } };
}

/** A request as a native presentation assembles it inside this preset. */
function codemodeAssembly() {
  return {
    tools: [
      { name: 'pwsh' },
      { name: 'run_code' },
      { name: 'code_run' },
      { name: 'mcp_probe' },
      { name: 'spawn_teammate' },
      { name: 'mcp__fake__get_ticker' },
      { name: 'mcp__fake__place_order' },
      { name: 'mcp__fake__account_balance' },
      { name: 'code_tools_list' },
      { name: 'code_tools_search' },
      { name: 'code_tools_describe' },
    ],
    sections: [
      { name: 'deployment:persona-prefix', text: 'persona' },
      { name: 'tools:sdk', text: 'OLD GENERATED SDK', interpolate: false },
    ],
    contexts: [{ name: 'sandbox', text: 'policy' }],
  };
}

test('apply registers the discovery tools plus one transport, each with a valid definition', () => {
  const { registered , context } = harness();
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
  const { registered , context } = harness();
  assert.ok(!registered.some((tool) => tool.name === 'run_code'));
});

test('apply installs one monotonic guard that only blocks model-direct masked calls', () => {
  const { guards, agentKey , context } = harness();
  assert.equal(guards.length, 1);
  const guard = guards[0];

  // Model-direct call to a masked MCP tool: denied with a self-healing hint.
  const denial = guard({ name: 'mcp__fake__get_ticker', agent: agentKey, callId: 'call-1' });
  assert.equal(typeof denial, 'string');
  assert.match(denial, /code_tools_search/);
  assert.match(denial, /code_run/);

  // A deployment-level bundle and an agent-scope tool are masked the same way.
  assert.equal(typeof guard({ name: 'mcp_probe', agent: agentKey, callId: 'call-1b' }), 'string');
  assert.equal(typeof guard({ name: 'spawn_teammate', agent: agentKey, callId: 'call-1c' }), 'string');

  // Inside a program: the sub-call carries a parent token or a `:ptc:` id.
  assert.equal(guard({ name: 'mcp__fake__get_ticker', agent: agentKey, parent: { token: true }, callId: 'call-1' }), undefined);
  assert.equal(guard({ name: 'mcp__fake__get_ticker', agent: agentKey, callId: 'call-1:ptc:1' }), undefined);

  // Visibility of a masked discovery tool is guarded the same way.
  assert.equal(typeof guard({ name: 'code_tools_search', agent: agentKey, callId: 'call-2' }), 'string');

  // Everything the model can legitimately call passes, including both transports.
  assert.equal(guard({ name: 'pwsh', agent: agentKey, callId: 'call-3' }), undefined);
  assert.equal(guard({ name: 'code_run', agent: agentKey, callId: 'call-4' }), undefined);
  assert.equal(guard({ name: 'run_code', agent: agentKey, callId: 'call-5' }), undefined);
  // A name the registry cannot resolve is left to the registry's own UNKNOWN_TOOL.
  assert.equal(guard({ name: 'unknown_tool', agent: agentKey, callId: 'call-6' }), undefined);
  assert.equal(guard(undefined), undefined);
});

test('a host-level mount has no scope tag: the scope rule degrades to name rules', async () => {
  const { guards, listeners, logs , context } = harness({}, { globalScope: true });
  // Without a scope tag only the name rules apply: `spawn_teammate` is not an
  // MCP-prefixed name, so it stays callable and stays in the request.
  assert.equal(guards[0]({ name: 'spawn_teammate', callId: 'c' }), undefined);
  assert.equal(typeof guards[0]({ name: 'mcp__fake__get_ticker', callId: 'c' }), 'string');
  assert.ok(logs.some(([level, message]) => level === 'warn' && message.includes('no registry scope tag')));

  const assembly = codemodeAssembly();
  const result = await listeners[0].listener(assembly, context, async () => assembly);
  assert.deepEqual(result.tools.map((tool) => tool.name), [
    'pwsh',
    'run_code',
    'code_run',
    'mcp_probe',
    'spawn_teammate',
  ]);
});

test('apply owns a plugin-scope effect that disposes the retention registry', async () => {
  const { effects , context } = harness();
  const retentionEffect = effects.find((entry) => entry.label === 'dsh-codemode retained environments');
  assert.ok(retentionEffect, 'unloading the plugin must release retained environments');
  await retentionEffect.disposer?.();
});

test('the assemble hook masks everything outside the preset and replaces the generated SDK section', async () => {
  const { listeners, logs , context } = harness();
  assert.equal(listeners.length, 1);
  const { event, listener, options } = listeners[0];
  assert.equal(event, 'system-prompt/assemble');
  assert.deepEqual(options, { prepend: true });

  const assembly = codemodeAssembly();
  const result = await listener(assembly, context, async () => assembly);

  assert.deepEqual(result.tools.map((tool) => tool.name), ['pwsh', 'run_code', 'code_run']);
  assert.equal(result.sections[0].text, 'persona');
  assert.equal(result.sections[1].name, 'tools:sdk');
  assert.match(result.sections[1].text, /## Code Mode/);
  assert.match(result.sections[1].text, /`code_run`/);
  assert.equal(result.sections[1].interpolate, false);
  assert.doesNotMatch(result.sections[1].text, /OLD GENERATED SDK/);
  assert.match(result.sections[1].text, /`fake` \(MCP server\) — 3 tool\(s\)/);
  assert.match(result.sections[1].text, /`plugin` \(contributed by plugins outside this preset\) — 2 tool\(s\)/);
  // Contexts and every other section are untouched.
  assert.deepEqual(result.contexts, assembly.contexts);
  const maskLogs = logs.filter(([level, message]) => level === 'info' && message.includes('masked'));
  assert.equal(maskLogs.length, 1);
  assert.match(maskLogs[0][1], /masked 5 non-standard tool\(s\) \(fake=3, plugin=2\)/);
  assert.match(maskLogs[0][1], /request tools: pwsh, run_code, code_run/);
});

test('nativeTools pins a foreign tool back into the request, hiddenTools does the reverse', async () => {
  const { listeners , context } = harness({ nativeTools: ['spawn_teammate', 'mcp_probe'], hiddenTools: ['pwsh'] });
  const assembly = codemodeAssembly();
  const result = await listeners[0].listener(assembly, context, async () => assembly);
  assert.deepEqual(result.tools.map((tool) => tool.name), ['run_code', 'code_run', 'mcp_probe', 'spawn_teammate']);
});

test('the transports stay native even when listed in hiddenTools', async () => {
  const { listeners , context } = harness({ hiddenTools: ['code_run', 'run_code'] });
  const assembly = codemodeAssembly();
  const result = await listeners[0].listener(assembly, context, async () => assembly);
  assert.deepEqual(result.tools.map((tool) => tool.name), ['pwsh', 'run_code', 'code_run']);
});

test('nativeScope false keeps deployment-level tools native', async () => {
  const { listeners , context } = harness({ nativeScope: false });
  const assembly = codemodeAssembly();
  const result = await listeners[0].listener(assembly, context, async () => assembly);
  assert.deepEqual(result.tools.map((tool) => tool.name), ['pwsh', 'run_code', 'code_run', 'mcp_probe', 'spawn_teammate']);
});

test('a native presentation has no tools:sdk to replace, so the hook appends one', async () => {
  const { listeners , context } = harness();
  const { listener } = listeners[0];
  const assembly = {
    ...codemodeAssembly(),
    sections: [{ name: 'deployment:persona-prefix', text: 'persona' }],
  };

  const result = await listener(assembly, context, async () => assembly);
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[0].text, 'persona');
  assert.equal(result.sections[1].name, 'tools:sdk');
  assert.equal(result.sections[1].interpolate, false);
  assert.match(result.sections[1].text, /## Code Mode/);
  assert.deepEqual(result.tools.map((tool) => tool.name), ['pwsh', 'run_code', 'code_run']);
});

test('a retained runtime switches the section to REPL syntax', async () => {
  const { listeners , context } = harness({}, { runtime: { programFormat: 'repl' } });
  const { listener } = listeners[0];
  const assembly = codemodeAssembly();

  const result = await listener(assembly, context, async () => assembly);
  assert.match(result.sections[1].text, /retained TypeScript REPL/);
  assert.doesNotMatch(result.sections[1].text, /run as the body of an async function/);
});

test('a standard assembly (no marker tool) is returned byte-for-byte unchanged', async () => {
  const { listeners, logs , context } = harness();
  const { listener } = listeners[0];
  const assembly = {
    tools: [{ name: 'pwsh' }, { name: 'mcp__fake__get_ticker' }],
    sections: [{ name: 'tools:sdk', text: 'native has no sdk section on purpose', interpolate: false }],
    contexts: [],
  };
  const result = await listener(assembly, context, async () => assembly);
  assert.equal(result, assembly);
  assert.equal(result.tools.length, 2);
  assert.equal(logs.filter(([, message]) => message.includes('masked')).length, 0);
});

test('another PTC preset (run_code, no marker tool) is left alone', async () => {
  const { listeners , context } = harness();
  const { listener } = listeners[0];
  const assembly = {
    tools: [{ name: 'run_code' }, { name: 'mcp__fake__get_ticker' }],
    sections: [{ name: 'tools:sdk', text: 'SDK OF THE OTHER PRESET', interpolate: false }],
    contexts: [],
  };
  const result = await listener(assembly, context, async () => assembly);
  assert.equal(result, assembly);
  assert.equal(result.sections[0].text, 'SDK OF THE OTHER PRESET');
});

test('a malformed assembly never breaks a turn', async () => {
  const { listeners , context } = harness();
  const { listener } = listeners[0];
  const assembly = { tools: [{ name: 'code_tools_list' }], get sections() { throw new Error('boom'); } };
  const result = await listener(assembly, {}, async () => assembly);
  assert.equal(result, assembly);
});

test('guard false skips the guard, sdkSection false keeps the SDK', async () => {
  const { guards, listeners , context } = harness({ guard: false, sdkSection: false, debug: false });
  assert.equal(guards.length, 0);

  const assembly = codemodeAssembly();
  const result = await listeners[0].listener(assembly, context, async () => assembly);
  assert.deepEqual(result.tools.map((tool) => tool.name), ['pwsh', 'run_code', 'code_run']);
  assert.equal(result.sections[1].text, 'OLD GENERATED SDK');
});

test('a custom runToolName reaches the guard, the section text and the registered tool', async () => {
  const { registered, guards, listeners , context } = harness({ runToolName: 'my_run' });
  assert.ok(registered.some((tool) => tool.name === 'my_run'));
  assert.match(guards[0]({ name: 'mcp__fake__get_ticker', callId: 'c' }), /my_run/);

  const assembly = codemodeAssembly();
  const result = await listeners[0].listener(assembly, context, async () => assembly);
  assert.match(result.sections[1].text, /`my_run`/);
});
