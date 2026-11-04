/**
 * dsh-codemode — Code Mode preset for DeepSeek Harness.
 *
 * Mounted as a row inside the `codemode` agent preset (see cordis.patch.yml).
 * Under DSH 0.2.2 the preset presents its tools natively and this package
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
 * 3. install a scope-scoped `ToolExecutor` whose `describe()` masks every tool
 *    the preset does not own and whose `execute()` rejects a model-direct call
 *    to a masked name, so a guessed name cannot bypass discovery; and
 * 4. supply the Code Mode instructions as that executor's `tools:sdk` section,
 *    replacing the SDK text a PTC executor would otherwise contribute.
 *
 * "Masked" is two rules. The name-only rule takes the discovery tools, the
 * configured prefixes (`mcp__` by default), and any explicit `hiddenTools` /
 * `nativeTools` entries. The scope rule (`nativeScope`, on by default) takes
 * every tool the registry resolves from outside this preset's own scope — MCP
 * servers and deployment-level bundles in the global layer, per-agent tool sets
 * in the agent layer — so the request carries exactly the standard composition
 * plus `code_run`, and everything else is reached from inside a program.
 * `lib/scope.js` owns that attribution.
 *
 * Why an executor rather than a `system-prompt/assemble` listener: DSH 0.2.2
 * stopped passing `tools` into that waterfall and re-attaches them from the
 * provider afterwards, so a listener can no longer influence the tool list. The
 * registry now asks the selected executor instead, which is a strictly better
 * seam — it is the documented owner of the model-facing catalog.
 *
 * The registry is never touched, which is why the same hidden tools remain
 * fully callable from inside a program: the transport dispatches them through
 * the registry's public `execute()` with a marked signal, exactly the way the
 * built-in transport marks nested calls.
 *
 * @module dsh-codemode
 */

import { createDiscoveryTools } from './discovery.js';
import { createCodemodeExecutor } from './executor.js';
import { createRetention } from './retention.js';
import {
  buildCodemodeSectionText,
  normalizeConfig,
  summarizeHidden,
} from './rules.js';
import { findScopeKey, resolveCatalogView, resolveScopeView } from './scope.js';
import { createTransportTool } from './transport.js';

export const name = 'dsh-codemode';
export const inject = ['tools', 'systemPrompt'];

/** How many executor decisions the debug ring keeps. */
const DEBUG_RING = 50;

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

  // 0. retained-environment lifecycle
  // Created first so the transport can take a stateOwner from it, and disposed
  // last so unloading this package releases every environment it opened.
  const retention = createRetention();
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => retention.dispose(), 'dsh-codemode retained environments');
  }

  // 1. discovery tools
  // The decision history exists before registration because the debug tool
  // reads it lazily, and the executor below appends to it.
  const debugRing = [];
  const remember = (entry) => {
    debugRing.push(entry);
    while (debugRing.length > DEBUG_RING) debugRing.shift();
  };

  /**
   * Masked-tool summary from the last `describe()`, for the section text.
   */
  let lastHidden = { total: 0, namespaces: [] };
  /**
   * Names the last catalog carried, so a model-direct denial can classify one
   * name with the same view the catalog used. `resolveScopeView` needs the
   * agent view to attribute a name, and the executor's `describe()` is the only
   * place that view is available — see `resolveCatalogView`.
   */
  let lastCatalogNames = [];
  let firstDescribeLogged = false;

  const hooks = {
    /**
     * Attribution view for a whole catalog.
     *
     * The executor's `describe()` receives the viewing agent's visible
     * definitions but not that agent's scope, so the input set IS the agent
     * view — see `resolveCatalogView`.
     */
    view: (definitions) => {
      lastCatalogNames = (definitions ?? []).map((definition) => definition?.name);
      return resolveCatalogView(ctx, scopeKey, lastCatalogNames);
    },
    /**
     * Attribution view for a single name, for the model-direct denial path.
     *
     * A name the last catalog carried is classified with the same view that
     * built it, so the denial and the catalog can never disagree. A name the
     * catalog never carried still has to be judged — a model can guess before
     * the first assembly — so it is classified on its own: the two resolved
     * views prove a global or preset owner, and a name neither resolves is
     * either registered below the preset or not registered at all.
     */
    viewForName: (toolName) => {
      if (lastCatalogNames.includes(toolName)) {
        return resolveCatalogView(ctx, scopeKey, lastCatalogNames);
      }
      const view = resolveScopeView(ctx, scopeKey, [toolName], undefined);
      // `resolveScopeView` without an agent scope treats "unattributable" as
      // "not in the agent view", which is right for an assembly and wrong for a
      // denial: a guessed name must still be judged, so it is added to the agent
      // set and the rules decide from the global/preset facts alone.
      if (view.enabled === true && !view.agentNames.has(toolName)) {
        return { ...view, agentNames: new Set([...view.agentNames, toolName]) };
      }
      return view;
    },
    /** The Code Mode instructions, rebuilt per catalog from live counts. */
    sectionText: () => buildCodemodeSectionText({
      runToolName,
      metaTools: options.metaTools,
      hidden: lastHidden,
      searchLimit: options.searchLimit,
      programFormat: ctx.get?.('ptcRuntime')?.programFormat,
    }),
    onDescribe: (decision) => {
      const hidden = summarizeHidden(decision.masked, options, decision.view);
      lastHidden = hidden;
      remember({
        at: new Date().toISOString(),
        agentId: null,
        hidden,
        visibleTools: decision.visible,
      });
      const namespaces = hidden.namespaces.map((entry) => `${entry.namespace}=${entry.count}`).join(', ');
      const line = `[dsh-codemode] masked ${hidden.total} non-standard tool(s)${namespaces === '' ? '' : ` (${namespaces})`}`
        + `; request tools: ${decision.visible.join(', ')}`;
      // One info line per process proves the masking happened; later steps of
      // the same process stay at debug so a long session is not noisy.
      if (!firstDescribeLogged) {
        firstDescribeLogged = true;
        log('info', line);
      } else {
        log('debug', line);
      }
    },
  };

  for (const definition of createDiscoveryTools(ctx, options, runToolName, {
    getDebug: () => ({ assemblies: debugRing.length, entries: debugRing }),
    scopeKey,
  })) {
    ctx.tools.register(definition);
  }

  // 2. program transport
  ctx.tools.register(createTransportTool(ctx, options, { retention }));

  // 3. + 4. the executor: catalog, denial, and the Code Mode section
  if (typeof ctx.tools.setExecutor === 'function') {
    ctx.tools.setExecutor(createCodemodeExecutor(ctx, options, {
      ...hooks,
      createDelegate: config?.createDelegate,
    }));
  } else {
    log('warn', '[dsh-codemode] this DSH build has no ctx.tools.setExecutor(); cannot mask the request surface. '
      + 'dsh-codemode requires DSH 0.2.2 or later.');
  }

  const scopeNote = options.nativeScope && scopeKey !== undefined
    ? ', everything outside this preset scope'
    : '';
  log('info', `[dsh-codemode] active: hiding [${options.hiddenPrefixes.join(', ')}]${scopeNote}, transport [${runToolName}], discovery tools [${options.metaTools.join(', ')}]`);
}

export { isNestedCall, markNested, NESTED_MARK } from './executor.js';
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
export { disabledView, findScopeKey, isForeignAtCall, resolveCatalogView, resolveScopeView } from './scope.js';
export { createTransportTool, parameterSchema, ProgramFailedError } from './transport.js';
export { createRetention, rootProvider } from './retention.js';
export { createPool, normalizeMaxParallel } from './pool.js';
