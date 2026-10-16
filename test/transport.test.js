import assert from 'node:assert/strict';
import test from 'node:test';

import { createTransportTool, parameterSchema, ProgramFailedError } from '../lib/transport.js';
import { normalizeConfig } from '../lib/rules.js';

/** Let queued pool work start and settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const VISIBLE = [
  { name: 'pwsh', description: 'Run commands' },
  { name: 'mcp__fake__get_ticker', description: 'Get a ticker' },
  { name: 'code_tools_search', description: 'Search tools' },
];

/** A runtime stub recording what the transport resolved and ran. */
function fakeRuntime({ timeout, programFormat = 'function-body', outcome } = {}) {
  const runs = [];
  return {
    timeout,
    programFormat,
    runs,
    resolve: (request) => ({ ...request, resolved: true }),
    async run(spec) {
      runs.push(spec);
      return outcome ?? { logs: ['hello'], value: { ok: true } };
    },
    async release() {},
  };
}

/**
 * Build the transport over a fake ctx. `seams` overrides individual services so
 * each test states only what it cares about.
 */
function build({ runtime = fakeRuntime(), retention, schemas = VISIBLE, execute, modes = {}, services = {}, config = {} } = {}) {
  const executed = [];
  const ctx = {
    get(name) {
      if (name === 'ptcRuntime') return runtime;
      if (Object.hasOwn(services, name)) return services[name];
      return undefined;
    },
    tools: {
      schemas: () => schemas,
      executionMode: (input) => ({ kind: modes[input.name] ?? 'exclusive' }),
      execute: async (input) => {
        executed.push(input);
        return execute ? execute(input) : { isError: false, value: `ran ${input.name}` };
      },
    },
  };
  const tool = createTransportTool(ctx, normalizeConfig(config), { retention });
  return { tool, executed, runtime };
}

/** The one sub-call program the tests drive. */
const PROGRAM = { code: 'return 1', description: 'do a thing' };

const CALL = { callId: 'call-1', rootCallId: 'call-1', token: { t: 1 } };

test('the transport registers under the configured name, not the reserved one', () => {
  assert.equal(build().tool.name, 'code_run');

  const custom = createTransportTool({ get: () => undefined, tools: {} }, normalizeConfig({ runToolName: 'my_run' }));
  assert.equal(custom.name, 'my_run');
});

test('the transport name defaults to code_run because run_code is reserved', () => {
  assert.equal(normalizeConfig({}).runToolName, 'code_run');
});

test('parameterSchema advertises timeoutMs only when the runtime reports a descriptor', () => {
  const without = parameterSchema({ programFormat: 'function-body' });
  assert.deepEqual(Object.keys(without.properties).sort(), ['code', 'description']);

  const withTimeout = parameterSchema({ programFormat: 'function-body', timeout: { defaultMs: 120000, maxMs: 600000 } });
  assert.equal(withTimeout.properties.timeoutMs.type, 'number');
  assert.match(withTimeout.properties.timeoutMs.description, /Default 120000; capped at 600000/);
});

test('parameterSchema describes the syntax the runtime actually supports', () => {
  const body = parameterSchema({ programFormat: 'function-body' });
  assert.match(body.properties.code.description, /BODY of an async TypeScript function/);

  const repl = parameterSchema({ programFormat: 'repl' });
  assert.match(repl.properties.code.description, /REPL/);
  assert.doesNotMatch(repl.properties.code.description, /BODY of an async/);
});

test('the parameters getter reads the mounted runtime lazily', () => {
  let mounted;
  const tool = createTransportTool(
    { get: (name) => (name === 'ptcRuntime' ? mounted : undefined), tools: {} },
    normalizeConfig({}),
  );
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['code', 'description']);

  mounted = { programFormat: 'function-body', timeout: { defaultMs: 1000, maxMs: 2000 } };
  assert.ok(Object.hasOwn(tool.parameters.properties, 'timeoutMs'), 'the descriptor must be read per projection');
});

test('execute forwards the program and returns logs and value', async () => {
  const { tool, runtime } = build();
  const value = await tool.execute(PROGRAM, CALL);

  assert.deepEqual(value, { logs: ['hello'], result: { ok: true } });
  assert.equal(runtime.runs.length, 1);
  assert.equal(runtime.runs[0].program, 'return 1');
  assert.equal(runtime.runs[0].resolved, true, 'the request must go through runtime.resolve()');
});

test('execute rejects malformed arguments before touching the runtime', async () => {
  const { tool, runtime } = build();
  await assert.rejects(tool.execute({ code: '  ', description: 'x' }, CALL), /non-empty program/);
  await assert.rejects(tool.execute({ code: 'x', description: '' }, CALL), /non-empty string/);
  await assert.rejects(tool.execute({ code: 'x', description: 'd', timeoutMs: -1 }, CALL), /positive finite number/);
  assert.equal(runtime.runs.length, 0);
});

test('program bindings cover every visible tool except the transport itself', async () => {
  const { tool, runtime } = build({ schemas: [...VISIBLE, { name: 'code_run', description: 'self' }] });
  await tool.execute(PROGRAM, CALL);

  const bindings = runtime.runs[0].bindings[0].functions;
  assert.deepEqual(Object.keys(bindings).sort(), ['code_tools_search', 'mcp__fake__get_ticker', 'pwsh']);
  assert.equal(runtime.runs[0].bindings[0].global, 'tools');
});

test('sub-calls go through the public registry execute() with the nested marker', async () => {
  const results = [];
  const runtime = fakeRuntime();
  runtime.run = async (spec) => {
    runtime.runs.push(spec);
    const bindings = spec.bindings[0].functions;
    results.push(await bindings.pwsh({ command: 'pwd' }));
    results.push(await bindings.mcp__fake__get_ticker({}));
    return { logs: [], value: null };
  };
  const { tool, executed } = build({ runtime });
  await tool.execute(PROGRAM, CALL);

  assert.deepEqual(results, ['ran pwsh', 'ran mcp__fake__get_ticker']);
  assert.equal(executed.length, 2, 'exactly the calls the program made must dispatch');
  assert.equal(executed[0].name, 'pwsh');
  assert.equal(executed[0].callId, 'call-1:ptc:1');
  assert.deepEqual(executed[0].parent, { t: 1 }, 'the outer execution token is the nested marker');
  assert.equal(executed[0].rootCallId, 'call-1');
  assert.equal(executed[1].callId, 'call-1:ptc:2');
});

test('a binding reached after the program ended is refused', async () => {
  let escaped;
  const runtime = fakeRuntime();
  runtime.run = async (spec) => {
    runtime.runs.push(spec);
    escaped = spec.bindings[0].functions.pwsh;
    return { logs: [], value: null };
  };
  const { tool, executed } = build({ runtime });
  await tool.execute(PROGRAM, CALL);

  await assert.rejects(escaped({}), /program ended before this sub-call was dispatched/);
  assert.equal(executed.length, 0, 'a post-run call must not reach the registry');
});

test('a failing sub-call rejects its binding with the tool error message', async () => {
  let rejection;
  const runtime = fakeRuntime();
  runtime.run = async (spec) => {
    runtime.runs.push(spec);
    try {
      await spec.bindings[0].functions.pwsh({});
    } catch (error) {
      rejection = error;
    }
    return { logs: [], value: null };
  };
  const { tool } = build({
    runtime,
    execute: async () => ({ isError: true, error: { message: 'nope' }, content: [] }),
  });
  await tool.execute(PROGRAM, CALL);

  assert.ok(rejection, 'the binding must reject');
  assert.match(rejection.message, /nope/);
});

test('sub-calls classified exclusive never overlap', async () => {
  const order = [];
  let releaseFirst;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const runtime = fakeRuntime();
  runtime.run = async (spec) => {
    runtime.runs.push(spec);
    const bindings = spec.bindings[0].functions;
    const first = bindings.pwsh({});
    const second = bindings.edit({});
    await flush();
    assert.deepEqual(order, ['start:pwsh'], 'the second exclusive call must wait');
    releaseFirst();
    await Promise.all([first, second]);
    return { logs: [], value: null };
  };

  const { tool } = build({
    runtime,
    modes: { pwsh: 'exclusive', edit: 'exclusive' },
    schemas: [{ name: 'pwsh' }, { name: 'edit' }],
    execute: async (input) => {
      order.push(`start:${input.name}`);
      if (input.name === 'pwsh') await gate;
      order.push(`end:${input.name}`);
      return { isError: false, value: null };
    },
  });
  await tool.execute(PROGRAM, CALL);

  assert.deepEqual(order, ['start:pwsh', 'end:pwsh', 'start:edit', 'end:edit']);
});

test('a host-level call passes no stateOwner even when retention is wired', async () => {
  const retention = { ownerFor: () => 'SHOULD-NOT-BE-USED' };
  const { tool, runtime } = build({ retention });
  await tool.execute(PROGRAM, CALL);
  assert.ok(!Object.hasOwn(runtime.runs[0], 'stateOwner'));
});

test('an agent-scoped call carries the owner retention produced, plus cwd and policy', async () => {
  const agent = { id: 'a1' };
  const { tool, runtime } = build({
    schemas: [],
    retention: { ownerFor: (seen) => (seen === agent ? agent : undefined) },
    services: {
      workingDirectory: { ensure: async (owner) => `/work/${owner.id}` },
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    },
  });

  await tool.execute(PROGRAM, { ...CALL, agent, signal: new AbortController().signal });
  const spec = runtime.runs[0];
  assert.equal(spec.stateOwner, agent);
  assert.equal(spec.cwd, '/work/a1');
  assert.deepEqual(spec.sandboxPolicy, { mode: 'workspace-write' });
});

test('an agent-scoped call without the workingDirectory service fails loudly', async () => {
  const agent = { id: 'a1' };
  const { tool, runtime } = build({ schemas: [] });
  await assert.rejects(
    tool.execute(PROGRAM, { ...CALL, agent, signal: new AbortController().signal }),
    /requires the workingDirectory service/,
  );
  assert.equal(runtime.runs.length, 0);
});

test('timeoutMs is forwarded only when the program supplied one', async () => {
  const timeout = { defaultMs: 120000, maxMs: 600000 };
  const withTimeout = build({ runtime: fakeRuntime({ timeout }) });
  await withTimeout.tool.execute({ ...PROGRAM, timeoutMs: 5000 }, CALL);
  assert.equal(withTimeout.runtime.runs[0].timeoutMs, 5000);

  const without = build({ runtime: fakeRuntime({ timeout }) });
  await without.tool.execute(PROGRAM, CALL);
  assert.ok(!Object.hasOwn(without.runtime.runs[0], 'timeoutMs'));
});

test('a runtime with no deadline descriptor refuses timeoutMs instead of forwarding it', async () => {
  const { tool, runtime } = build({ runtime: fakeRuntime() });
  await assert.rejects(
    tool.execute({ ...PROGRAM, timeoutMs: 5000 }, CALL),
    /timeoutMs is not available for this PTC runtime/,
  );
  assert.equal(runtime.runs.length, 0);
});

test('a failed program raises ProgramFailedError carrying the taxonomy and logs', async () => {
  const { tool } = build({
    runtime: fakeRuntime({ outcome: { logs: ['partial'], error: { kind: 'timeout', message: 'deadline expired' } } }),
  });

  await assert.rejects(tool.execute(PROGRAM, CALL), (error) => {
    assert.ok(error instanceof ProgramFailedError);
    assert.match(error.message, /code run failed \(timeout\): deadline expired/);
    assert.match(error.message, /Captured output:\npartial/);
    return true;
  });
});

test('a missing PTC runtime fails loudly instead of running unconfined', async () => {
  const tool = createTransportTool({ get: () => undefined, tools: {} }, normalizeConfig({}));
  await assert.rejects(tool.execute(PROGRAM, CALL), /requires a PTC runtime service/);
});

test('the pool is drained before the result leaves', async () => {
  let settled = false;
  const runtime = fakeRuntime();
  // A program that leaves a sub-call in flight and returns without awaiting it.
  runtime.run = async (spec) => {
    runtime.runs.push(spec);
    void spec.bindings[0].functions.pwsh({});
    return { logs: [], value: null };
  };
  const { tool } = build({
    runtime,
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      settled = true;
      return { isError: false, value: null };
    },
  });

  await tool.execute(PROGRAM, CALL);
  assert.equal(settled, true, 'the outer result must not leave while a sub-call is running');
});

test('a sub-call the program queued but never reached is abandoned, not executed', async () => {
  const started = [];
  const runtime = fakeRuntime();
  // Fire two calls; with a cap of 1 the second stays queued when the program returns.
  runtime.run = async (spec) => {
    runtime.runs.push(spec);
    const bindings = spec.bindings[0].functions;
    void bindings.pwsh({ id: 1 });
    void bindings.pwsh({ id: 2 });
    return { logs: [], value: null };
  };
  const { tool } = build({
    runtime,
    config: { maxParallelSubCalls: 1 },
    modes: { pwsh: 'parallel' },
    execute: async (input) => {
      started.push(input.arguments.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { isError: false, value: null };
    },
  });

  await tool.execute(PROGRAM, CALL);
  assert.deepEqual(started, [1], 'a queued sub-call must not run after the program ended');
});
