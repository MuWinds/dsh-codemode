/**
 * Registry-scope attribution: which of this session's tools belong to the
 * preset this package is mounted in, and which arrive from somewhere else.
 *
 * The registry resolves a tool from a layer chain, and the *scope* a tool was
 * registered in is the only durable answer to "did this preset's own
 * composition put it there?" — a deployment can register MCP tools, profile
 * bundles, and even per-agent tool sets without any name convention to key on:
 *
 *   - global layer      — `dsh-mcp-client` rows and every deployment-level
 *                         bundle (profile plugins, experimental tool sets);
 *   - preset layer      — the preset's own plugin rows, which is exactly the
 *                         standard composition this package mirrors;
 *   - agent layer       — tools a plugin registers through `agent.ctx`, e.g.
 *                         the Team and schedule tool sets.
 *
 * Everything here reads the registry's *public* `get(name, scope)`: a tool
 * resolves inside the preset's scope and nowhere in the global view exactly
 * when the preset owns it. The one piece of DSH-internal knowledge is the
 * scope tag `@deepseek-ai/dsh-scope` writes onto a scoped context; it is read
 * by symbol description rather than by importing that package, because a
 * profile plugin has no resolvable dependency on DSH's own packages. When the
 * tag is absent (this package mounted at the host level instead of inside a
 * preset) the attribution is inert and the name-only rules apply.
 * @module dsh-codemode/scope
 */

import { isAlwaysNativeName } from './rules.js';

/** Description of the context tag a DSH scope writes; see `dsh-scope#createScope`. */
const SCOPE_TAG_DESCRIPTION = 'dsh.scope';

/** A view with no scope facts: every scope-based rule treats it as inert. */
export function disabledView() {
  return { enabled: false, globalNames: new Set(), presetNames: new Set(), agentNames: new Set() };
}

/**
 * The scope key this plugin's own context is tagged with.
 *
 * `createScope()` mints a context through `ctx.extend({ [symbol]: key })`, so
 * the tag is an own symbol property on an ancestor of this plugin's context and
 * is reachable by walking the prototype chain. The tag is matched by its
 * symbol description, not by identity: the symbol is module-private to
 * `dsh-scope`, but its description is stable across the copies of the module a
 * deployment may load.
 *
 * @param ctx - this plugin's context.
 * @returns the enclosing scope key, or `undefined` when the context has none.
 */
export function findScopeKey(ctx) {
  try {
    for (let cursor = ctx; cursor !== null && cursor !== undefined; cursor = Object.getPrototypeOf(cursor)) {
      for (const symbol of Object.getOwnPropertySymbols(cursor)) {
        if (symbol.description === SCOPE_TAG_DESCRIPTION) return ctx[symbol];
      }
    }
  } catch {
    /* a context shape without introspectable symbols simply has no scope */
  }
  return undefined;
}

/**
 * Resolve the name sets the scope rule needs, once per assembly.
 *
 * Three views, each a documented `get(name, scope)` read:
 *   - global — no scope: the layer every session shares;
 *   - preset — the preset's scope: the global layer plus the preset's own rows;
 *   - agent  — the calling session's scope: everything it can actually call.
 *
 * A preset-owned tool is in the preset view and not the global one. A tool that
 * exists only in the agent view was registered below the preset (a per-agent
 * tool set). A tool no view resolves is attributed to nobody, and the rules
 * leave it alone.
 *
 * @param ctx - this plugin's context.
 * @param scopeKey - the preset's scope key, or `undefined`.
 * @param names - every tool name the caller needs judged.
 * @param agentScope - the calling session's scope, when the caller knows it.
 * @returns a view for the pure rules in `rules.js`.
 */
export function resolveScopeView(ctx, scopeKey, names, agentScope) {
  if (scopeKey === undefined) return disabledView();
  const get = ctx?.tools?.get;
  if (typeof get !== 'function') return disabledView();
  const globalNames = new Set();
  const presetNames = new Set();
  const agentNames = new Set();
  try {
    for (const name of names ?? []) {
      if (typeof name !== 'string' || name.length === 0) continue;
      const inGlobal = ctx.tools.get(name) !== undefined;
      const inPreset = ctx.tools.get(name, scopeKey) !== undefined;
      if (inGlobal) globalNames.add(name);
      if (inPreset) presetNames.add(name);
      // Without a calling scope, "what the session can call" is what the two
      // resolved views already prove; nothing is attributed beyond them.
      const inAgent = agentScope === undefined
        ? inGlobal || inPreset
        : ctx.tools.get(name, agentScope) !== undefined;
      if (inAgent) agentNames.add(name);
    }
  } catch {
    /* An unresolvable registry read must never hide the wrong half of a catalog. */
    return disabledView();
  }
  return { enabled: true, globalNames, presetNames, agentNames };
}

/**
 * Single-name form of {@link resolveScopeView}, for decision points that have
 * no assembly (the monotonic guard, which sees every model-direct call).
 *
 * The agent scope narrows the answer to names that exist at all: a name the
 * registry cannot resolve in the calling agent's own view is not ours to judge,
 * and the registry's own `UNKNOWN_TOOL` path answers it instead.
 *
 * @param ctx - this plugin's context.
 * @param scopeKey - the preset's scope key, or `undefined`.
 * @param name - the tool name being called.
 * @param options - normalized plugin config.
 * @param agentScope - the calling agent, when the caller knows it.
 * @returns whether the name is foreign to this preset.
 */
export function isForeignAtCall(ctx, scopeKey, name, options, agentScope) {
  if (options?.nativeScope === false) return false;
  if (scopeKey === undefined) return false;
  if (typeof name !== 'string' || name.length === 0) return false;
  if (options.metaTools.includes(name)) return false;
  if (isAlwaysNativeName(name, options)) return false;
  if (typeof ctx?.tools?.get !== 'function') return false;
  try {
    const inAgentView = agentScope === undefined
      ? ctx.tools.get(name)
      : ctx.tools.get(name, agentScope);
    if (inAgentView === undefined) return false;
    if (ctx.tools.get(name) !== undefined) return true;
    return ctx.tools.get(name, scopeKey) === undefined;
  } catch {
    return false;
  }
}
