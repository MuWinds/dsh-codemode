/**
 * dsh-codemode — Code Mode preset for DeepSeek Harness.
 *
 * Mounted inside the `codemode` agent preset (see cordis.patch.yml). Under DSH
 * 0.2.1-alpha.5 the preset presents its tools **natively**, and this package
 * supplies the one extra tool plus the masking that keeps every tool the preset
 * does not own out of the request. Four jobs, all scoped to sessions joined to
 * that preset:
 *
 * 1. register the discovery tools (list / search / describe) — ordinary tools,
 *    so they exist only here, become bindings inside the program transport, and
 *    run through the normal execution pipeline;
 * 2. register this package's PTC transport (`code_run` by default). The
 *    reserved name `run_code` belongs to `dsh-tools` and cannot be registered,
 *    so a plugin-owned transport presents under its own name;
 * 3. install a monotonic guard that rejects a model-direct call to a masked
 *    tool, so a guessed name cannot bypass discovery; and
 * 4. mask the request at `system-prompt/assemble`: masked tools leave the
 *    assembly's tool list and the generated `tools:sdk` section — when the
 *    deployment registers one — is replaced by the Code Mode instructions,
 *    with our own section appended when it does not.
 *
 * "Masked" is two rules. The name-only rule takes the discovery tools, the
 * configured prefixes (`mcp__` by default), and any explicit `hiddenTools` /
 * `nativeTools` entries. The scope rule (`nativeScope`, on by default) takes
 * every tool the registry resolves from outside this preset's own scope — MCP
 * servers and deployment-level bundles in the global layer, per-agent tool sets
 * in the agent layer — so the request carries exactly the standard composition
 * plus `code_run`, and everything else is reached from inside a program.
 * `lib/scope.js` owns that attribution and documents why it reads the registry
 * the way it does.
 *
 * The registry is never touched, which is why the same hidden tools remain
 * fully callable from inside a program: the transport dispatches them through
 * the registry's public `execute()` with a `parent` token, exactly the way the
 * built-in transport does.
 *
 * @module dsh-codemode
 */

import { createDiscoveryTools } from './discovery.js';
import { createRetention } from './retention.js';
import {
  buildCodemodeSectionText,
  filterAssemblyTools,
  isMaskedName,
  normalizeConfig,
  SDK_SECTION_NAME,
  summarizeHidden,
} from './rules.js';
import { findScopeKey, isForeignAtCall, resolveScopeView } from './scope.js';
import { createTransportTool } from './transport.js';

export const name = 'dsh-codemode';
export const inject = ['tools', 'systemPrompt'];

/** How many assembly decisions the debug ring keeps. */
const DEBUG_RING = 50;

/** @returns whether an execution came from inside a program. */
function isNestedCall(exec) {
  if (exec === undefined || exec === null) return false;
  if (exec.parent !== undefined) return true;
  // Sub-call ids are `${rootCallId}:ptc:${n}`; the suffix is the second,
  // belt-and-braces signal that this dispatch is not model-direct.
  return String(exec.callId ?? '').includes(':ptc:');
}

export function apply(ctx, config = {}) {
  const options = normalizeConfig(config);
  const runToolName = options.runToolName;
  const logger = ctx.logger ?? {};
  const log = (level, message) => {
    try {
      logger[level]?.(message);
    } catch {
      /* logging must never fail a turn */
    }
  };

  // The scope this package is mounted in. Inside the codemode preset this is
  // the preset's own scope key, which is what makes "belongs to this preset"
  // answerable through the registry's public `get(name, scope)`; mounted at the
  // host level there is no such tag and the scope rule stays inert.
  const scopeKey = findScopeKey(ctx);
  if (options.nativeScope && scopeKey === undefined) {
    log('warn', '[dsh-codemode] no registry scope tag on this context: masking falls back to name rules only '
      + `([${options.hiddenPrefixes.join(', ')}]). Mount this package as a row inside an agent preset to hide every tool the preset does not own.`);
  }

  // One classifier for every surface: the assemble hook and the discovery
  // tools must agree on what "masked" means, or the model sees a listing that
  // contradicts its own tool list. Both build the same scope view over their
  // own name set; the guard below uses the single-name form.
  const isMaskedAtCall = (name, agent) => isMaskedName(name, options, undefined)
    || isForeignAtCall(ctx, scopeKey, name, options, agent);

  // 0. retained-environment lifecycle
  // Created first so the transport can take a stateOwner from it, and disposed
  // last so unloading this package releases every environment it opened.
  const retention = createRetention();
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => retention.dispose(), 'dsh-codemode retained environments');
  }

  // 1. discovery tools
  // The masking history exists before registration because the debug tool reads
  // it lazily, and the assemble hook below appends to it.
  const debugRing = [];
  for (const definition of createDiscoveryTools(ctx, options, runToolName, {
    getDebug: () => ({ assemblies: debugRing.length, entries: debugRing }),
    scopeKey,
  })) {
    ctx.tools.register(definition);
  }

  // 2. program transport
  ctx.tools.register(createTransportTool(ctx, options, { retention }));

  // 3. monotonic guard: no guessed direct calls to masked tools
  if (options.guard && typeof ctx.tools.guard === 'function') {
    ctx.tools.guard((exec) => {
      try {
        if (isNestedCall(exec)) return undefined;
        if (!isMaskedAtCall(exec?.name, exec?.agent)) return undefined;
        const searchTool = options.metaTools[1] ?? options.metaTools[0];
        return `"${exec.name}" is not part of this session's tool list. In Code Mode, tools this preset does not own `
          + `(MCP servers, plugins outside the preset) are reachable only from inside ${runToolName}: call `
          + `tools.${searchTool}({ query: "..." }) there to discover it, then call it by exact name.`;
      } catch {
        return undefined;
      }
    });
  }

  // 4. request masking + generated-SDK replacement
  let firstMaskLogged = false;

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next();
    try {
      if (!assembled || !Array.isArray(assembled.tools)) return assembled;

      // Exact discriminator: the discovery tools only exist in this preset's
      // scope, so their presence proves this assembly belongs to codemode.
      // Standard sessions (no transport) and other presets (no marker) are
      // returned untouched even if scope filtering were to misbehave.
      const applied = assembled.tools.some((tool) => tool?.name === options.markerTool);
      if (!applied) return assembled;

      const names = assembled.tools.map((tool) => tool?.name).filter((value) => typeof value === 'string');
      // Scope facts for this exact request: which of these names the registry
      // resolves globally, inside this preset's scope, and in the calling
      // session's own scope.
      const view = resolveScopeView(ctx, scopeKey, names, context?.scope);
      const hidden = summarizeHidden(names, options, view);
      const masked = filterAssemblyTools(assembled.tools, options, view);
      let sections = assembled.sections;
      if (options.sdkSection && Array.isArray(assembled.sections)) {
        const text = buildCodemodeSectionText({
          runToolName,
          metaTools: options.metaTools,
          hidden,
          searchLimit: options.searchLimit,
          programFormat: ctx.get?.('ptcRuntime')?.programFormat,
        });
        const replaced = assembled.sections.map((section) => (
          section?.name === SDK_SECTION_NAME ? { ...section, text, interpolate: false } : section
        ));
        // A native presentation does not register `tools:sdk` at all, so there
        // is nothing to replace; append our own contribution instead.
        const present = assembled.sections.some((section) => section?.name === SDK_SECTION_NAME);
        sections = present ? replaced : [...replaced, { name: SDK_SECTION_NAME, text, interpolate: false }];
      }

      remember(debugRing, {
        at: new Date().toISOString(),
        applied: true,
        agentId: context?.agent?.id ?? null,
        hidden,
        droppedTools: names.filter((toolName) => isMaskedName(toolName, options, view) && !options.metaTools.includes(toolName)),
        visibleTools: masked.map((tool) => tool?.name),
        sdkSectionReplaced: options.sdkSection,
      });
      const namespaces = hidden.namespaces.map((entry) => `${entry.namespace}=${entry.count}`).join(', ');
      const line = `[dsh-codemode] masked ${hidden.total} non-standard tool(s)${namespaces === '' ? '' : ` (${namespaces})`}`
        + `; request tools: ${masked.map((tool) => tool?.name).join(', ')}`;
      // One info line per process proves the masking happened; later steps of
      // the same process stay at debug so a long session is not noisy.
      if (!firstMaskLogged) {
        firstMaskLogged = true;
        log('info', line);
      } else {
        log('debug', line);
      }
      return { ...assembled, tools: masked, sections };
    } catch (error) {
      log('warn', `[dsh-codemode] assemble hook failed, leaving the request unchanged: ${String(error)}`);
      try {
        remember(debugRing, { at: new Date().toISOString(), applied: false, error: String(error) });
      } catch {
        /* ignore */
      }
      return assembled;
    }
  }, { prepend: true });

  const scopeNote = options.nativeScope && scopeKey !== undefined
    ? ', everything outside this preset scope'
    : '';
  log('info', `[dsh-codemode] active: hiding [${options.hiddenPrefixes.join(', ')}]${scopeNote}, transport [${runToolName}], discovery tools [${options.metaTools.join(', ')}]`);
}

/** Append to the debug ring, keeping the newest {@link DEBUG_RING} entries. */
function remember(ring, entry) {
  ring.push(entry);
  while (ring.length > DEBUG_RING) ring.shift();
}

export {
  buildCodemodeSectionText,
  filterAssemblyTools,
  isForeignName,
  isHiddenName,
  isMaskedName,
  normalizeConfig,
  summarizeHidden,
} from './rules.js';
export { createDiscoveryTools, visibleDefinitions } from './discovery.js';
export { disabledView, findScopeKey, isForeignAtCall, resolveScopeView } from './scope.js';
export { createTransportTool, parameterSchema, ProgramFailedError } from './transport.js';
export { createRetention, rootProvider } from './retention.js';
export { createPool, normalizeMaxParallel } from './pool.js';
