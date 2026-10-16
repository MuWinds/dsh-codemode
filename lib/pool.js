/**
 * The sub-dispatch scheduler for one program run.
 *
 * `dsh-tools` runs `run_code` sub-calls through the agent loop's own
 * scheduler; a plugin-owned transport has no access to that (it is behind a
 * private symbol), so it reproduces the *observable contract* instead, from
 * the registry's public classifier `ctx.tools.executionMode()`:
 *
 *   - a call classified `parallel` may overlap with its siblings, up to the
 *     configured cap; and
 *   - a call classified `exclusive` runs alone, in submission order — it waits
 *     for everything already in flight and blocks everything queued behind it.
 *
 * This is a deliberate re-implementation, not the loop's scheduler: it orders
 * sub-calls only relative to each other, never relative to other tool calls in
 * the same step. That difference is documented in the README.
 *
 * @module dsh-codemode/pool
 */

/** Concurrent sub-calls allowed for one program when the config omits a cap. */
export const DEFAULT_MAX_PARALLEL = 10;

/** Rejection raised for a sub-call that the ended program can no longer make. */
export const ABANDONED_MESSAGE = 'the program ended before this sub-call was dispatched';

/** Normalize a configured cap into a positive integer. */
export function normalizeMaxParallel(value) {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_MAX_PARALLEL;
}

/**
 * Create the ordered pool for one program run.
 * @param maxParallel - concurrent `parallel` sub-calls; `exclusive` calls always wait.
 * @returns `run(task, kind)` submits in call order, `abandon()` stops admitting
 *   work once the program ends, and `drain()` resolves when nothing is left.
 */
export function createPool(maxParallel = DEFAULT_MAX_PARALLEL) {
  const limit = normalizeMaxParallel(maxParallel);
  /** Entries in submission order; each is `{ task, kind, resolve, reject }`. */
  const queue = [];
  const idle = [];
  let active = 0;
  let exclusiveActive = false;
  let abandoned = false;

  /** Resolve every `drain()` waiter once the queue and the in-flight set are empty. */
  function settleIdle() {
    if (queue.length > 0 || active > 0) return;
    while (idle.length > 0) idle.shift()();
  }

  /** Start one entry and release its slot when it settles. */
  function start(entry, onSettle) {
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        active -= 1;
        onSettle();
        pump();
      });
  }

  /**
   * The single ordered lane: start what the slot rules admit, head first, and
   * stop at the first entry that must wait. Exclusivity is a barrier in both
   * directions, which is what makes a mutating call run alone and in order.
   */
  function pump() {
    // Once abandoned, nothing new starts — but in-flight entries still settle
    // and must be able to wake a waiting drain().
    if (!abandoned) {
      while (queue.length > 0) {
        const head = queue[0];
        if (head.kind === 'exclusive') {
          if (active > 0) break;
          queue.shift();
          exclusiveActive = true;
          active += 1;
          start(head, () => {
            exclusiveActive = false;
          });
          continue;
        }
        if (exclusiveActive || active >= limit) break;
        queue.shift();
        active += 1;
        start(head, () => {});
      }
    }
    settleIdle();
  }

  /**
   * Submit one sub-dispatch.
   * @param task - the work, started only when the pool admits it.
   * @param kind - `executionMode(exec).kind` from the registry.
   * @returns the task's own result, or its rejection.
   */
  function run(task, kind) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A program may fire a sub-call without awaiting it, so a rejection this
    // pool produces must not surface as an unhandled one. The returned promise
    // still rejects for a caller that does await it.
    promise.catch(() => {});
    if (abandoned) {
      // The program is over. Reaching here means it kept a binding alive past
      // its own return, which the built-in transport refuses the same way.
      reject(new Error(ABANDONED_MESSAGE));
      return promise;
    }
    queue.push({ task, kind: kind === 'parallel' ? 'parallel' : 'exclusive', resolve, reject });
    pump();
    return promise;
  }

  /**
   * Stop admitting queued work: entries that have not started are rejected
   * instead of dispatched, while anything already in flight runs to completion
   * and is still awaited by {@link drain}. Called when the program has ended,
   * so a sub-call the program never reached cannot mutate the workspace after
   * the run it belonged to is over.
   * @returns how many entries were abandoned.
   */
  function abandon() {
    abandoned = true;
    const dropped = queue.splice(0, queue.length);
    for (const entry of dropped) {
      entry.reject(new Error(ABANDONED_MESSAGE));
    }
    settleIdle();
    return dropped.length;
  }

  /** Resolve when every submitted sub-dispatch has settled. */
  function drain() {
    if (queue.length === 0 && active === 0) return Promise.resolve();
    return new Promise((resolve) => {
      idle.push(resolve);
    });
  }

  return {
    run,
    drain,
    abandon,
    /** Observable state, for tests and the debug tool. */
    stats: () => ({ active, queued: queue.length, exclusive: exclusiveActive, abandoned }),
  };
}
