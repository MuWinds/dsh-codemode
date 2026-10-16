import assert from 'node:assert/strict';
import test from 'node:test';

import { createPool, normalizeMaxParallel, DEFAULT_MAX_PARALLEL } from '../lib/pool.js';

/** Let every already-scheduled microtask and one macrotask turn run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A promise with an external settle handle. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('normalizeMaxParallel accepts a positive number and otherwise falls back', () => {
  assert.equal(normalizeMaxParallel(4), 4);
  assert.equal(normalizeMaxParallel(2.7), 2);
  assert.equal(normalizeMaxParallel(0), DEFAULT_MAX_PARALLEL);
  assert.equal(normalizeMaxParallel(-1), DEFAULT_MAX_PARALLEL);
  assert.equal(normalizeMaxParallel(undefined), DEFAULT_MAX_PARALLEL);
  assert.equal(normalizeMaxParallel(Number.NaN), DEFAULT_MAX_PARALLEL);
});

test('parallel calls overlap only up to the cap, and a freed slot admits the next', async () => {
  const pool = createPool(2);
  const events = [];
  const gates = [deferred(), deferred(), deferred()];
  const runs = gates.map((gate, index) => pool.run(async () => {
    events.push(`start${index}`);
    await gate.promise;
    events.push(`end${index}`);
  }, 'parallel'));

  await flush();
  assert.deepEqual(events, ['start0', 'start1'], 'the third call must wait for a slot');

  gates[0].resolve();
  await flush();
  assert.deepEqual(events, ['start0', 'start1', 'end0', 'start2']);

  gates[1].resolve();
  gates[2].resolve();
  await Promise.all(runs);
  assert.deepEqual(events, ['start0', 'start1', 'end0', 'start2', 'end1', 'end2']);
});

test('an exclusive call waits for everything in flight and blocks what is queued behind it', async () => {
  const pool = createPool(10);
  const events = [];
  const gate = deferred();
  const first = pool.run(async () => {
    events.push('a-start');
    await gate.promise;
    events.push('a-end');
  }, 'parallel');
  const exclusive = pool.run(async () => {
    events.push('x');
  }, 'exclusive');
  const behind = pool.run(async () => {
    events.push('b');
  }, 'parallel');

  await flush();
  assert.deepEqual(events, ['a-start'], 'the exclusive call must not start beside the in-flight one');

  gate.resolve();
  await Promise.all([first, exclusive, behind]);
  assert.deepEqual(events, ['a-start', 'a-end', 'x', 'b']);
});

test('exclusive calls run in submission order', async () => {
  const pool = createPool(10);
  const order = [];
  await Promise.all([
    pool.run(async () => { order.push(1); }, 'exclusive'),
    pool.run(async () => { order.push(2); }, 'exclusive'),
    pool.run(async () => { order.push(3); }, 'exclusive'),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
});

test('an unknown classification is treated as exclusive', async () => {
  const pool = createPool(10);
  const events = [];
  const gate = deferred();
  const running = pool.run(async () => {
    events.push('a-start');
    await gate.promise;
  }, 'parallel');
  const unclassified = pool.run(async () => { events.push('u'); }, undefined);

  await flush();
  assert.deepEqual(events, ['a-start'], 'an unclassified call must not overlap');

  gate.resolve();
  await Promise.all([running, unclassified]);
  assert.deepEqual(events, ['a-start', 'u']);
});

test('a rejected task still frees its slot and surfaces its own error', async () => {
  const pool = createPool(1);
  const boom = new Error('boom');
  const failed = pool.run(async () => {
    throw boom;
  }, 'parallel');
  const after = pool.run(async () => 'ok', 'parallel');

  await assert.rejects(failed, /boom/);
  assert.equal(await after, 'ok');
});

test('drain waits for every submitted call, whether queued or in flight', async () => {
  const pool = createPool(1);
  const gate = deferred();
  const running = pool.run(async () => {
    await gate.promise;
  }, 'parallel');

  let drained = false;
  const drainedPromise = pool.drain().then(() => {
    drained = true;
  });

  await flush();
  assert.equal(drained, false);

  gate.resolve();
  await running;
  await drainedPromise;
  assert.equal(drained, true);
});

test('drain resolves immediately when nothing was submitted', async () => {
  const pool = createPool(3);
  await pool.drain();
  assert.deepEqual(pool.stats(), { active: 0, queued: 0, exclusive: false, abandoned: false });
});

test('abandon rejects queued entries instead of dispatching them', async () => {
  const pool = createPool(1);
  const gate = deferred();
  const started = [];
  const running = pool.run(async () => {
    started.push('first');
    await gate.promise;
  }, 'parallel');
  const queued = pool.run(async () => {
    started.push('second');
  }, 'parallel');

  await flush();
  assert.deepEqual(started, ['first'], 'the second entry is still queued');

  assert.equal(pool.abandon(), 1);
  await assert.rejects(queued, /the program ended before this sub-call was dispatched/);

  gate.resolve();
  await running;
  assert.deepEqual(started, ['first'], 'an abandoned entry must never run');
});

test('abandon leaves work already in flight to finish, and drain still waits for it', async () => {
  const pool = createPool(2);
  const gate = deferred();
  let finished = false;
  const running = pool.run(async () => {
    await gate.promise;
    finished = true;
  }, 'parallel');

  await flush();
  pool.abandon();
  let drained = false;
  const drainedPromise = pool.drain().then(() => {
    drained = true;
  });
  await flush();
  assert.equal(drained, false, 'drain must wait for the in-flight call');

  gate.resolve();
  await running;
  await drainedPromise;
  assert.equal(finished, true);
});

test('abandon does not reject a call that already completed', async () => {
  const pool = createPool(1);
  const done = await pool.run(async () => 'value', 'parallel');
  assert.equal(done, 'value');
  assert.equal(pool.abandon(), 0);
});

test('a later submission is refused once the pool is abandoned', async () => {
  const pool = createPool(1);
  pool.abandon();
  const late = pool.run(async () => 'never', 'parallel');
  await assert.rejects(late, /the program ended before this sub-call was dispatched/);
});
