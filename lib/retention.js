/**
 * Retained PTC environment lifecycle.
 *
 * When the deployment selects `executionMode: persistent-in-memory` on
 * `@deepseek-ai/dsh-ptc-runtime-node`, the provider keeps one in-memory REPL
 * per `stateOwner` so a program's top-level variables survive into the next
 * program of the same agent. Its bookkeeping has an asymmetry that matters
 * here:
 *
 *   - the owner key lives in a `WeakMap`, so dropping the owner drops the key;
 *   - every live environment also sits in a strong `Set` that only
 *     `release(owner)` — or the provider unmounting — ever removes.
 *
 * A caller that passes `stateOwner` and never releases therefore loses the
 * only handle to the kernel (the weak key is gone) while the runtime still
 * holds it strongly: the child process stays alive for the rest of the
 * process's life, and there is no idle timeout that would reclaim it.
 *
 * This module makes that leak unrepresentable. {@link createRetention}'s
 * `ownerFor` is the *only* place a `stateOwner` is produced, and it registers
 * the matching release in the same step, so no call path can obtain an owner
 * without also owning its cleanup.
 *
 * Bookkeeping is keyed by `(agent, provider)`, not by agent alone: a runtime
 * that is reloaded leaves a new provider current for a still-live agent, and
 * the previous provider's kernel is a separate environment that must still be
 * released.
 *
 * Two cleanup layers are installed, because they cover different deaths:
 *
 *   1. an effect on the **agent's** scope, so disposing the agent releases its
 *      environments even if this plugin was already unloaded; and
 *   2. a **plugin-scope** teardown, so unloading or reloading this package
 *      releases whatever is still outstanding.
 *
 * The live registry deliberately holds its owners *strongly*. A `WeakRef`
 * would be the intuitive choice and is exactly wrong here: once the owner is
 * collected the runtime can no longer be asked to release it, so the kernel
 * becomes unreachable-but-retained — a permanent leak rather than an avoided
 * one. Strong references are bounded instead by the first cleanup layer, which
 * removes each agent as it disposes.
 *
 * @module dsh-codemode/retention
 */

/**
 * Cordis publishes the unwrapped service under this globally registered
 * symbol, so a dependency-free package can walk its own service proxies.
 * @see `@deepseek-ai/cordis` `symbols.original`
 */
const ORIGINAL = Symbol.for('cordis.original');

/** Depth guard for the proxy walk; a cycle must not hang the turn. */
const MAX_UNWRAP_DEPTH = 32;

/**
 * Walk cordis service proxies down to the object that owns the state.
 *
 * Dedup keyed on the proxy would still be correct — `release` is idempotent —
 * but it would register one cleanup effect per reload. Keying on the root
 * provider keeps that at one per agent per underlying runtime.
 * @param runtime - the value resolved from `ctx.ptcRuntime`.
 * @returns the underlying provider, or `runtime` itself when it is not a proxy.
 */
export function rootProvider(runtime) {
  let provider = runtime;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    const original = provider?.[ORIGINAL];
    if (original === undefined || original === provider) return provider;
    provider = original;
  }
  return provider;
}

/**
 * Create one retention registry. A plugin instance owns exactly one.
 * @returns the registry.
 */
export function createRetention() {
  /** Agent -> providers already wired. Weak: an agent is never kept alive here. */
  const wired = new WeakMap();
  /** Agent -> provider -> the disposer that releases that environment. Strong on purpose. */
  const live = new Map();
  let disposed = false;

  /** Count the individual environments still outstanding. */
  function count() {
    let total = 0;
    for (const entries of live.values()) total += entries.size;
    return total;
  }

  /**
   * The single place a `stateOwner` is produced.
   *
   * Returns `undefined` — meaning "run in a temporary environment" — whenever
   * retention would be unsafe: no agent, no release-capable provider, no
   * agent-scoped effect to bind the cleanup to, or a disposed registry. Every
   * one of those degrades to the unretained behaviour rather than to a leak.
   * @param agent - the calling agent, or `undefined` for a host-level call.
   * @param runtime - the mounted `ctx.ptcRuntime`.
   * @returns the owner to pass as `stateOwner`, or `undefined`.
   */
  function ownerFor(agent, runtime) {
    if (disposed || agent === undefined || agent === null) return undefined;
    const effect = agent.ctx?.effect;
    if (typeof effect !== 'function') return undefined;
    const provider = rootProvider(runtime);
    if (provider === undefined || provider === null || typeof provider.release !== 'function') return undefined;

    let providers = wired.get(agent);
    if (providers === undefined) {
      providers = new WeakSet();
      wired.set(agent, providers);
    }
    if (providers.has(provider)) return agent;

    providers.add(provider);
    let entries = live.get(agent);
    if (entries === undefined) {
      entries = new Map();
      live.set(agent, entries);
    }
    // Bound to the AGENT's scope, not this plugin's: disposing the agent
    // releases its environments even when this package is already gone.
    entries.set(provider, effect(() => () => {
      const current = live.get(agent);
      current?.delete(provider);
      if (current !== undefined && current.size === 0) live.delete(agent);
      return provider.release(agent);
    }, 'dsh-codemode retained environment'));
    return agent;
  }

  /** Every `(owner, provider)` pair still outstanding. */
  function outstanding() {
    const pairs = [];
    for (const [owner, entries] of live) {
      for (const provider of entries.keys()) pairs.push([owner, provider]);
    }
    return pairs;
  }

  /**
   * Release every environment still outstanding, without unregistering the
   * agent-scoped effects (a later agent disposal then finds nothing to do —
   * `release` is idempotent).
   * @returns settled results; a failing release never rejects the caller.
   */
  function releaseAll() {
    const pairs = outstanding();
    live.clear();
    return Promise.allSettled(pairs.map(([owner, provider]) => provider.release(owner)));
  }

  /**
   * Unregister the agent-scoped effects and release what they cover. Called
   * from the plugin's own scope so unloading or reloading this package does
   * not strand a child process.
   * @returns settled results.
   */
  async function dispose() {
    disposed = true;
    const pending = [];
    for (const entries of live.values()) {
      for (const disposer of entries.values()) {
        // A disposer runs the release; contain its rejection so one failing
        // environment cannot skip releasing the rest.
        pending.push(Promise.resolve().then(disposer).catch(() => {}));
      }
    }
    await Promise.allSettled(pending);
    return releaseAll();
  }

  return {
    ownerFor,
    releaseAll,
    dispose,
    /** How many environments currently stand retained. Used by tests and the debug tool. */
    size: count,
  };
}
