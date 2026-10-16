import assert from 'node:assert/strict';
import test from 'node:test';

import { createRetention, rootProvider } from '../lib/retention.js';

/** The well-known symbol cordis publishes the unwrapped service under. */
const ORIGINAL = Symbol.for('cordis.original');

/**
 * A minimal agent whose scoped effects can be disposed, which is the lifetime
 * the retention registry binds its cleanup to.
 */
function fakeAgent(id = 'agent-1') {
  const effects = [];
  return {
    id,
    ctx: {
      effect: (factory) => {
        const entry = { disposer: factory(), label: null, active: true };
        effects.push(entry);
        return () => {
          if (!entry.active) return undefined;
          entry.active = false;
          effects.splice(effects.indexOf(entry), 1);
          return entry.disposer?.();
        };
      },
    },
    /** Run every registered disposer, as disposing the agent would. */
    async dispose() {
      const pending = effects.splice(0, effects.length);
      return Promise.all(pending.map((entry) => {
        entry.active = false;
        return entry.disposer?.();
      }));
    },
    liveEffects: () => effects.length,
  };
}

/** A runtime provider that records every release. */
function fakeRuntime() {
  const released = [];
  return {
    released,
    async release(owner) {
      released.push(owner);
    },
  };
}

test('rootProvider unwraps a chain of cordis service proxies', () => {
  const root = { release() {} };
  const middle = { [ORIGINAL]: root };
  const proxy = { [ORIGINAL]: middle };

  assert.equal(rootProvider(proxy), root);
  assert.equal(rootProvider(root), root, 'a non-proxy resolves to itself');
  assert.equal(rootProvider(undefined), undefined);
});

test('rootProvider tolerates a self-referential proxy instead of looping', () => {
  const self = {};
  self[ORIGINAL] = self;
  assert.equal(rootProvider(self), self);
});

test('ownerFor declines retention when it cannot guarantee a release', () => {
  const retention = createRetention();
  const runtime = fakeRuntime();
  const agent = fakeAgent();

  assert.equal(retention.ownerFor(undefined, runtime), undefined, 'no agent');
  assert.equal(retention.ownerFor(agent, { release: undefined }), undefined, 'no release()');
  assert.equal(retention.ownerFor(agent, undefined), undefined, 'no runtime');
  assert.equal(retention.ownerFor({ id: 'bare' }, runtime), undefined, 'no agent-scoped effect');
  assert.equal(retention.size(), 0, 'a declined retention must not be tracked');
});

test('ownerFor returns the agent and registers exactly one cleanup per agent', () => {
  const retention = createRetention();
  const runtime = fakeRuntime();
  const agent = fakeAgent();

  for (let call = 0; call < 25; call += 1) {
    assert.equal(retention.ownerFor(agent, runtime), agent, 'the owner is the agent object itself');
  }
  assert.equal(agent.liveEffects(), 1, 'repeated runs must not accumulate disposers');
  assert.equal(retention.size(), 1);
});

test('a different provider under the same agent gets its own cleanup and its own release', async () => {
  const retention = createRetention();
  const agent = fakeAgent();
  const first = fakeRuntime();
  const second = fakeRuntime();

  retention.ownerFor(agent, first);
  retention.ownerFor(agent, second);
  assert.equal(agent.liveEffects(), 2, 'one effect per (agent, provider) pair');
  assert.equal(retention.size(), 2, 'each provider holds its own environment');

  // A runtime reload makes the second provider current while the first still
  // holds a kernel; releasing only the current one would strand it.
  await retention.releaseAll();
  assert.deepEqual(first.released, [agent]);
  assert.deepEqual(second.released, [agent]);
  assert.equal(retention.size(), 0);
});

test('proxies of the same provider share one cleanup', () => {
  const retention = createRetention();
  const agent = fakeAgent();
  const root = fakeRuntime();
  const proxy = { [ORIGINAL]: root };

  retention.ownerFor(agent, root);
  retention.ownerFor(agent, proxy);
  assert.equal(agent.liveEffects(), 1, 'the proxy must not be treated as a second provider');
});

test('disposing the agent releases its environment', async () => {
  const retention = createRetention();
  const runtime = fakeRuntime();
  const agent = fakeAgent();

  retention.ownerFor(agent, runtime);
  assert.equal(retention.size(), 1);

  await agent.dispose();
  assert.deepEqual(runtime.released, [agent]);
  assert.equal(retention.size(), 0, 'the live registry must not keep a released agent');
});

test('releaseAll releases outstanding environments and shrinks the registry', async () => {
  const retention = createRetention();
  const first = fakeRuntime();
  const second = fakeRuntime();
  const a = fakeAgent('a');
  const b = fakeAgent('b');

  retention.ownerFor(a, first);
  retention.ownerFor(b, second);
  assert.equal(retention.size(), 2);

  await retention.releaseAll();
  assert.deepEqual(first.released, [a]);
  assert.deepEqual(second.released, [b]);
  assert.equal(retention.size(), 0);
  assert.equal(a.liveEffects(), 1, 'the agent-scoped effect stays registered for a later disposal');
});

test('dispose unregisters the agent effects, releases, and then declines new owners', async () => {
  const retention = createRetention();
  const runtime = fakeRuntime();
  const agent = fakeAgent();

  retention.ownerFor(agent, runtime);
  await retention.dispose();

  assert.deepEqual(runtime.released, [agent]);
  assert.equal(agent.liveEffects(), 0, 'dispose must unregister its own effects');
  assert.equal(retention.size(), 0);
  assert.equal(retention.ownerFor(agent, runtime), undefined, 'a disposed registry never retains again');
});

test('a later agent disposal after releaseAll is a harmless no-op', async () => {
  const retention = createRetention();
  const runtime = fakeRuntime();
  const agent = fakeAgent();

  retention.ownerFor(agent, runtime);
  await retention.releaseAll();
  await agent.dispose();

  // The provider's own release is idempotent, so the second call is expected;
  // what matters is that nothing throws and the registry stays empty.
  assert.equal(runtime.released.length, 2);
  assert.equal(retention.size(), 0);
});
