import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../lib/index.js';

const definitions = new Map([
  ['run_code', { name: 'run_code', description: 'PTC transport' }],
  ['pwsh', { name: 'pwsh', description: 'Run commands in a PowerShell shell' }],
  ['mcp__fake__get_ticker', { name: 'mcp__fake__get_ticker', description: 'Get the latest ticker' }],
  ['mcp__fake__place_order', { name: 'mcp__fake__place_order', description: 'Place an order' }],
  ['mcp__fake__account_balance', { name: 'mcp__fake__account_balance', description: 'Read the balance' }],
]);

/** Minimal Cordis-shaped context that captures everything apply() wires. */
function harness() {
  const registered = [];
  const guards = [];
  const listeners = [];
  const logs = [];
  const ctx = {
    logger: {
      info: (message) => logs.push(['info', String(message)]),
      warn: (message) => logs.push(['warn', String(message)]),
      debug: (message) => logs.push(['debug', String(message)]),
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
      view: () => ({ visible: definitions, knownNames: new Set(definitions.keys()), restrictableNames: new Set(definitions.keys()) }),
    },
    on: (event, listener, options) => {
      listeners.push({ event, listener, options });
      return () => {};
    },
  };
  apply(ctx, {});
  return { registered, guards, listeners, logs };
}

/** A request as dsh-tools assembles it under `mode: both` inside this preset. */
function codemodeAssembly() {
  return {
    tools: [
      { name: 'pwsh' },
      { name: 'run_code' },
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

test('apply registers exactly the discovery tools, each with a valid definition', () => {
  const { registered } = harness();
  assert.deepEqual(registered.map((tool) => tool.name), [
    'code_tools_list',
    'code_tools_search',
    'code_tools_describe',
    'code_debug',
  ]);
  for (const tool of registered) {
    assert.ok(tool.description.length > 0);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.output.schema.additionalProperties, true);
    assert.equal(typeof tool.execute, 'function');
  }
});

test('apply installs one monotonic guard that only blocks model-direct hidden calls', () => {
  const { guards } = harness();
  assert.equal(guards.length, 1);
  const guard = guards[0];

  // Model-direct call to a hidden MCP tool: denied with a self-healing hint.
  const denial = guard({ name: 'mcp__fake__get_ticker', callId: 'call-1' });
  assert.equal(typeof denial, 'string');
  assert.match(denial, /code_tools_search/);
  assert.match(denial, /run_code/);

  // Inside run_code: the sub-call carries a parent token or a `:ptc:` id.
  assert.equal(guard({ name: 'mcp__fake__get_ticker', parent: { token: true }, callId: 'call-1' }), undefined);
  assert.equal(guard({ name: 'mcp__fake__get_ticker', callId: 'call-1:ptc:1' }), undefined);

  // Visibility of a hidden discovery tool is guarded the same way.
  assert.equal(typeof guard({ name: 'code_tools_search', callId: 'call-2' }), 'string');

  // Everything the model can legitimately call passes.
  assert.equal(guard({ name: 'pwsh', callId: 'call-3' }), undefined);
  assert.equal(guard({ name: 'run_code', callId: 'call-4' }), undefined);
  assert.equal(guard(undefined), undefined);
});

test('the assemble hook masks MCP tools and replaces the generated SDK section', async () => {
  const { listeners, logs } = harness();
  assert.equal(listeners.length, 1);
  const { event, listener, options } = listeners[0];
  assert.equal(event, 'system-prompt/assemble');
  assert.deepEqual(options, { prepend: true });

  const assembly = codemodeAssembly();
  const result = await listener(assembly, { agent: { id: 'agent-1' } }, async () => assembly);

  assert.deepEqual(result.tools.map((tool) => tool.name), ['pwsh', 'run_code']);
  assert.equal(result.sections[0].text, 'persona');
  assert.equal(result.sections[1].name, 'tools:sdk');
  assert.match(result.sections[1].text, /## Code Mode/);
  assert.equal(result.sections[1].interpolate, false);
  assert.doesNotMatch(result.sections[1].text, /OLD GENERATED SDK/);
  assert.match(result.sections[1].text, /`fake` — 3 tool\(s\)/);
  // Contexts and every other section are untouched.
  assert.deepEqual(result.contexts, assembly.contexts);
  const maskLogs = logs.filter(([level, message]) => level === 'info' && message.includes('masked'));
  assert.equal(maskLogs.length, 1);
  assert.match(maskLogs[0][1], /masked 3 hidden tool\(s\) \(fake=3\); request tools: pwsh, run_code/);
});

test('a standard assembly (no marker tool) is returned byte-for-byte unchanged', async () => {
  const { listeners, logs } = harness();
  const { listener } = listeners[0];
  const assembly = {
    tools: [{ name: 'pwsh' }, { name: 'mcp__fake__get_ticker' }],
    sections: [{ name: 'tools:sdk', text: 'native has no sdk section on purpose', interpolate: false }],
    contexts: [],
  };
  const result = await listener(assembly, { agent: { id: 'agent-1' } }, async () => assembly);
  assert.equal(result, assembly);
  assert.equal(result.tools.length, 2);
  assert.equal(logs.filter(([, message]) => message.includes('masked')).length, 0);
});

test('another PTC preset (run_code, no marker tool) is left alone', async () => {
  const { listeners } = harness();
  const { listener } = listeners[0];
  const assembly = {
    tools: [{ name: 'run_code' }, { name: 'mcp__fake__get_ticker' }],
    sections: [{ name: 'tools:sdk', text: 'SDK OF THE OTHER PRESET', interpolate: false }],
    contexts: [],
  };
  const result = await listener(assembly, { agent: { id: 'agent-1' } }, async () => assembly);
  assert.equal(result, assembly);
  assert.equal(result.sections[0].text, 'SDK OF THE OTHER PRESET');
});

test('a malformed assembly never breaks a turn', async () => {
  const { listeners } = harness();
  const { listener } = listeners[0];
  const assembly = { tools: [{ name: 'code_tools_list' }], get sections() { throw new Error('boom'); } };
  const result = await listener(assembly, {}, async () => assembly);
  assert.equal(result, assembly);
});

test('the mdast of configurations: guard false skips the guard, sdkSection false keeps the SDK', async () => {
  const registered = [];
  const guards = [];
  const listeners = [];
  const ctx = {
    logger: {},
    tools: {
      register: (definition) => registered.push(definition),
      guard: (guard) => guards.push(guard),
      view: () => ({ visible: definitions }),
    },
    on: (event, listener) => listeners.push({ event, listener }),
  };
  apply(ctx, { guard: false, sdkSection: false, debug: false });
  assert.equal(guards.length, 0);
  const assembly = codemodeAssembly();
  const result = await listeners[0].listener(assembly, {}, async () => assembly);
  assert.deepEqual(result.tools.map((tool) => tool.name), ['pwsh', 'run_code']);
  assert.equal(result.sections[1].text, 'OLD GENERATED SDK');
});
