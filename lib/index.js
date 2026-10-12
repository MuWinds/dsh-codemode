/**
 * dsh-codemode — Code Mode preset for DeepSeek Harness.
 *
 * Mounted inside the `codemode` agent preset (see cordis.patch.yml). Three
 * jobs, all scoped to sessions joined to that preset:
 *
 * 1. register the discovery tools (list / search / describe) — ordinary tools,
 *    so they exist only here, become `run_code` bindings automatically, and run
 *    through the normal execution pipeline;
 * 2. install a monotonic guard that rejects a model-direct call to a hidden
 *    tool, so a guessed name cannot bypass discovery;
 * 3. mask the request at `system-prompt/assemble`: hidden tools leave the
 *    assembly's tool list and the generated `tools:sdk` section is replaced by
 *    the Code Mode instructions. The registry is never touched, which is why
 *    the same hidden tools remain fully callable from inside `run_code`.
 *
 * @module dsh-codemode
 */

import { createDiscoveryTools } from './discovery.js';
import {
  buildCodemodeSectionText,
  filterAssemblyTools,
  isHiddenName,
  normalizeConfig,
  SDK_SECTION_NAME,
  summarizeHidden,
} from './rules.js';

export const name = 'dsh-codemode';
export const inject = ['tools', 'systemPrompt'];

/** How many assembly decisions the debug ring keeps. */
const DEBUG_RING = 50;

/** Reserved PTC transport name; it is the one tool that may never be hidden. */
const RUN_CODE_NAME = 'run_code';

/** @returns whether an execution came from inside a run_code program. */
function isNestedCall(exec) {
  if (exec === undefined || exec === null) return false;
  if (exec.parent !== undefined) return true;
  // Sub-call ids are `${rootCallId}:ptc:${n}`; the suffix is the second,
  // belt-and-braces signal that this dispatch is not model-direct.
  return String(exec.callId ?? '').includes(':ptc:');
}

export function apply(ctx, config = {}) {
  const options = normalizeConfig(config);
  const logger = ctx.logger ?? {};
  const log = (level, message) => {
    try {
      logger[level]?.(message);
    } catch {
      /* logging must never fail a turn */
    }
  };

  // ── 1. discovery tools ────────────────────────────────────────────────────
  // ── 1. discovery tools ────────────────────────────────────────────────────
  // The masking history exists before registration because the debug tool reads
  // it lazily, and the assemble hook below appends to it.
  const debugRing = [];
  for (const definition of createDiscoveryTools(ctx, options, RUN_CODE_NAME, {
    getDebug: () => ({ assemblies: debugRing.length, entries: debugRing }),
  })) {
    ctx.tools.register(definition);
  }

  // ── 2. monotonic guard: no guessed direct calls to hidden tools ───────────
  if (options.guard && typeof ctx.tools.guard === 'function') {
    ctx.tools.guard((exec) => {
      try {
        if (isNestedCall(exec)) return undefined;
        if (!isHiddenName(exec?.name, options)) return undefined;
        const [, searchTool] = options.metaTools;
        return `"${exec.name}" is not part of this session's tool list. In Code Mode, MCP tools are reachable `
          + `only from inside ${RUN_CODE_NAME}: call tools.${searchTool}({ query: "..." }) there to discover it, `
          + `then call it by exact name.`;
      } catch {
        return undefined;
      }
    });
  }

  // ── 3. request masking + generated-SDK replacement ───────────────────────
  let firstMaskLogged = false;

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next();
    try {
      if (!assembled || !Array.isArray(assembled.tools)) return assembled;

      // Exact discriminator: the discovery tools only exist in this preset's
      // scope, so their presence proves this assembly belongs to codemode.
      // Standard sessions (no run_code) and other PTC presets (no marker) are
      // returned untouched even if scope filtering were to misbehave.
      const applied = assembled.tools.some((tool) => tool?.name === options.markerTool);
      if (!applied) return assembled;

      const names = assembled.tools.map((tool) => tool?.name).filter((value) => typeof value === 'string');
      const hidden = summarizeHidden(names, options);
      const masked = filterAssemblyTools(assembled.tools, options);
      let sections = assembled.sections;
      if (options.sdkSection && Array.isArray(assembled.sections)) {
        sections = assembled.sections.map((section) => (
          section?.name === SDK_SECTION_NAME
            ? { ...section, text: buildCodemodeSectionText({ runCodeName: RUN_CODE_NAME, metaTools: options.metaTools, hidden, searchLimit: options.searchLimit }), interpolate: false }
            : section
        ));
      }

      remember(debugRing, {
        at: new Date().toISOString(),
        applied: true,
        agentId: context?.agent?.id ?? null,
        hidden,
        droppedTools: names.filter((toolName) => isHiddenName(toolName, options) && !options.metaTools.includes(toolName)),
        visibleTools: masked.map((tool) => tool?.name),
        sdkSectionReplaced: options.sdkSection,
      });
      const namespaces = hidden.namespaces.map((entry) => `${entry.namespace}=${entry.count}`).join(', ');
      const line = `[dsh-codemode] masked ${hidden.total} hidden tool(s)${namespaces === '' ? '' : ` (${namespaces})`}`
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

  log('info', `[dsh-codemode] active: hiding [${options.hiddenPrefixes.join(', ')}], discovery tools [${options.metaTools.join(', ')}]`);
}

/** Append to the debug ring, keeping the newest {@link DEBUG_RING} entries. */
function remember(ring, entry) {
  ring.push(entry);
  while (ring.length > DEBUG_RING) ring.shift();
}

export { buildCodemodeSectionText, filterAssemblyTools, isHiddenName, normalizeConfig, summarizeHidden } from './rules.js';
export { createDiscoveryTools, visibleDefinitions } from './discovery.js';
