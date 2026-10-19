/**
 * Pure rules for the codemode preset: which tools are hidden from the model's
 * request surface, how the generated `tools:sdk` section is rewritten, and the
 * ranking used by the discovery tools.
 *
 * Nothing here touches a Cordis context, so every function is unit-testable
 * offline.
 * @module dsh-codemode/rules
 */

/** Tool-name prefixes hidden from the model's request surface. */
export const DEFAULT_HIDDEN_PREFIXES = ['mcp__'];

/** Discovery tools this plugin registers; hidden like everything else it hides. */
export const DEFAULT_META_TOOLS = ['code_tools_list', 'code_tools_search', 'code_tools_describe', 'code_debug'];

/**
 * Name of DSH's own PTC transport. It is presentation infrastructure, not a
 * capability: whenever a deployment presents it, it is the model's way into a
 * program and must never be masked away.
 */
export const RESERVED_RUN_TOOL = 'run_code';

/** Namespace bucket for a masked tool that is not an MCP tool. */
export const PLUGIN_NAMESPACE = 'plugin';

/** Shared empty set, so an absent view field costs no allocation. */
const EMPTY_NAMES = new Set();

/** `mcp__<server>__<tool>`, the public name `dsh-mcp-client` pins per tool. */
const MCP_NAME = /^mcp__(.+?)__(.*)$/;

/**
 * Name of this package's own PTC transport tool.
 *
 * DSH reserves `run_code` for its built-in transport — `tools.register()`
 * throws on that exact name — so a plugin-owned transport must present under
 * its own name. The preset presents natively, which is why this tool can be
 * model-visible while the built-in one cannot.
 */
export const DEFAULT_RUN_TOOL_NAME = 'code_run';

/**
 * The marker name that proves an assembled request belongs to this preset: the
 * discovery tools only ever register inside the codemode preset scope, so their
 * presence in an assembly is an exact discriminator. Standard sessions (no
 * `run_code`) and other PTC presets (no marker) are never touched, which makes
 * the hook correct even if Cordis scope filtering behaves unexpectedly.
 */
export const MARKER_TOOL = DEFAULT_META_TOOLS[0];

/** Prompt section own by dsh-tools that renders the generated PTC SDK. */
export const SDK_SECTION_NAME = 'tools:sdk';

const DEFAULTS = {
  hiddenPrefixes: DEFAULT_HIDDEN_PREFIXES,
  metaTools: DEFAULT_META_TOOLS,
  runToolName: DEFAULT_RUN_TOOL_NAME,
  guard: true,
  sdkSection: true,
  debug: true,
  searchLimit: 8,
  maxDescriptionChars: 240,
  maxParallelSubCalls: 10,
  nativeScope: true,
  nativeTools: [],
  hiddenTools: [],
  semanticWeight: 1,
  semanticRescueFloor: 0.35,
};

/** Normalize a string list, dropping non-strings and duplicates. */
function stringList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (name.length > 0) seen.add(name);
  }
  return [...seen];
}

/** Normalize plugin config into the frozen shape the rest of the module reads. */
export function normalizeConfig(config = {}) {
  const hiddenPrefixes = Array.isArray(config.hiddenPrefixes) && config.hiddenPrefixes.length > 0
    ? config.hiddenPrefixes.map(String)
    : DEFAULTS.hiddenPrefixes;
  // The guard message and the Code Mode section both address a list tool and a
  // search tool, so a shorter list is replaced wholesale rather than honoured
  // halfway and surfacing as "tools.undefined(...)" in a denial.
  const metaTools = Array.isArray(config.metaTools) && config.metaTools.length >= 2
    ? config.metaTools.map(String)
    : DEFAULTS.metaTools;
  const searchLimit = Number.isFinite(config.searchLimit) && config.searchLimit > 0
    ? Math.floor(config.searchLimit)
    : DEFAULTS.searchLimit;
  const maxDescriptionChars = Number.isFinite(config.maxDescriptionChars) && config.maxDescriptionChars > 0
    ? Math.floor(config.maxDescriptionChars)
    : DEFAULTS.maxDescriptionChars;
  const runToolName = typeof config.runToolName === 'string' && config.runToolName.trim().length > 0
    ? config.runToolName.trim()
    : DEFAULTS.runToolName;
  const maxParallelSubCalls = Number.isFinite(config.maxParallelSubCalls) && config.maxParallelSubCalls >= 1
    ? Math.floor(config.maxParallelSubCalls)
    : DEFAULTS.maxParallelSubCalls;
  const semanticWeight = Number.isFinite(config.semanticWeight) && config.semanticWeight >= 0
    ? config.semanticWeight
    : DEFAULTS.semanticWeight;
  const semanticRescueFloor = Number.isFinite(config.semanticRescueFloor)
    && config.semanticRescueFloor >= 0 && config.semanticRescueFloor <= 1
    ? config.semanticRescueFloor
    : DEFAULTS.semanticRescueFloor;
  return {
    semanticWeight,
    semanticRescueFloor,
    hiddenPrefixes,
    metaTools,
    markerTool: metaTools[0],
    runToolName,
    guard: config.guard !== false,
    sdkSection: config.sdkSection !== false,
    debug: config.debug !== false,
    searchLimit,
    maxDescriptionChars,
    maxParallelSubCalls,
    nativeScope: config.nativeScope !== false,
    nativeTools: stringList(config.nativeTools),
    hiddenTools: stringList(config.hiddenTools),
  };
}

/**
 * Whether a name is exempt from every hiding rule: the reserved PTC transport,
 * this package's own transport, or an explicitly listed native tool. A name
 * listed in `metaTools` is never exempt — the discovery tools stay hidden even
 * if a deployment lists them here by mistake.
 */
export function isAlwaysNativeName(name, options) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === RESERVED_RUN_TOOL) return true;
  if (name === options?.runToolName) return true;
  return (options?.nativeTools ?? []).includes(name);
}

/**
 * Whether the name-only rules hide a tool from the model's request surface:
 * the discovery tools, `hiddenTools`, `nativeTools`-exempt names, then the
 * configured name prefixes (MCP by default).
 */
export function isHiddenName(name, options) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (options.metaTools.includes(name)) return true;
  if (isAlwaysNativeName(name, options)) return false;
  if ((options.hiddenTools ?? []).includes(name)) return true;
  return options.hiddenPrefixes.some((prefix) => name.startsWith(prefix));
}

/**
 * Whether a tool is *foreign* to this preset: the registry resolves it from
 * outside the scope this package is mounted in — the global layer (MCP servers,
 * profile-level plugin bundles) or a scope below the preset (tools a plugin
 * registers through `agent.ctx`, e.g. the Team and schedule tool sets).
 *
 * The facts come from the view `lib/scope.js` resolves through the registry's
 * public `get(name, scope)`: a preset-owned tool resolves inside the preset's
 * scope, and a global one resolves with no scope at all. A name the calling
 * agent's own view does not resolve either is *not* attributed by anyone — a
 * schema another prompt provider contributed, or a fixture — and is left alone,
 * because hiding what cannot be attributed is how a plugin silently swallows a
 * tool it never owned. When no view is available the rule is inert, so a
 * deployment that cannot be attributed falls back to the name-only rules
 * instead of hiding the wrong half of the catalog.
 */
export function isForeignName(name, options, view) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (options?.nativeScope === false) return false;
  if (view?.enabled !== true) return false;
  if (options.metaTools.includes(name)) return false;
  if (isAlwaysNativeName(name, options)) return false;
  const globalNames = view.globalNames ?? EMPTY_NAMES;
  const presetNames = view.presetNames ?? EMPTY_NAMES;
  const agentNames = view.agentNames ?? new Set([...globalNames, ...presetNames]);
  if (!agentNames.has(name)) return false;
  if (globalNames.has(name)) return true;
  return !presetNames.has(name);
}

/** Whether either rule set hides this name. */
export function isMaskedName(name, options, view) {
  return isHiddenName(name, options) || isForeignName(name, options, view);
}

/** Drop every masked tool from an assembled request's tool list. */
export function filterAssemblyTools(tools, options, view) {
  if (!Array.isArray(tools)) return tools;
  return tools.filter((tool) => !isMaskedName(tool?.name, options, view));
}

/**
 * Namespace of a masked tool name: the MCP server for `mcp__<server>__<tool>`,
 * else the shared {@link PLUGIN_NAMESPACE} bucket.
 *
 * dsh-mcp-client pins the public name as a pure function of (serverName,
 * rawName); a server name containing a literal `__` is the only ambiguous case
 * and degrades to the `mcp` bucket, which is fine for a hint.
 */
export function namespaceOf(name) {
  const match = MCP_NAME.exec(String(name ?? ''));
  return match === null ? PLUGIN_NAMESPACE : match[1];
}

/** Whether a tool name is an MCP tool name. */
export function isMcpToolName(name) {
  return MCP_NAME.test(String(name ?? ''));
}

/**
 * Summarize the masked half of a tool list as counts per namespace. Only names
 * and numbers leave this function — never a masked tool's schema, description,
 * or parameters.
 */
export function summarizeHidden(names, options, view) {
  const buckets = new Map();
  let total = 0;
  for (const name of names ?? []) {
    if (!isMaskedName(name, options, view)) continue;
    if (options.metaTools.includes(name)) continue;
    total += 1;
    const namespace = namespaceOf(name);
    const entry = buckets.get(namespace) ?? { namespace, count: 0, kind: isMcpToolName(name) ? 'mcp' : 'plugin' };
    entry.count += 1;
    buckets.set(namespace, entry);
  }
  const namespaces = [...buckets.values()]
    .sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0));
  return { total, namespaces };
}

/** Truncate a tool description for a listing row. */
export function truncate(text, maxChars) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * Tokenize for ranking: latin words split on `_`/`-` as well as whitespace (MCP
 * tool names are long underscore-joined identifiers, so splitting them is what
 * lets "ticker" find `mcp__okx__market_get_ticker`), and CJK runs into 1- and
 * 2-grams as a compact stand-in for word segmentation. Mirrors the community
 * `dsh-tool-search` approach so Chinese queries rank sensibly.
 */
export function tokenize(text) {
  const value = String(text ?? '').toLowerCase();
  const tokens = [];
  for (const word of value.match(/[a-z0-9]+/g) ?? []) tokens.push(word);
  for (const run of value.match(new RegExp(`${CJK.source}+`, 'g')) ?? []) {
    if (run.length === 1) tokens.push(run);
    for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2));
  }
  return tokens;
}

/**
 * Rank tool entries against a query. Deterministic, dependency-free BM25-lite:
 * name hits weigh more than description hits, and an exact or prefix name match
 * outranks everything.
 *
 * Hybrid extension: when a `semantic` bundle is supplied (vectors from the
 * embeddings module), each row also gets a cosine score, and the two signals
 * fuse. The fusion is deliberately asymmetric - a purely semantic hit is CAPPED
 * below the score of a single lexical name-token hit, so embeddings only ever
 * RESCUE rows the lexical pass discarded (the "docx vs markitdown" gap) and can
 * never outrank a real token match. Without the bundle, behavior is byte-for-
 * byte the upstream lexical ranking.
 * @param query - free text; empty returns the first `limit` entries in order.
 * @param entries - `{ name, description }` rows.
 * @param limit - maximum rows to return.
 * @param namespace - optional namespace filter (an MCP server name).
 * @param semantic - optional `{ weight, rescueFloor, cosine, getQueryVector, getVector }`.
 */
export function rankTools(query, entries, limit, namespace, semantic = {}) {
  const rows = (entries ?? []).filter((entry) => {
    if (namespace === undefined || namespace === '') return true;
    return namespaceOf(entry.name) === namespace;
  });
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return rows.slice(0, limit);
  const weight = Number.isFinite(semantic.weight) && semantic.weight > 0 ? semantic.weight : 0;
  const rescueFloor = Number.isFinite(semantic.rescueFloor) ? semantic.rescueFloor : 0.35;
  const queryVector = weight > 0
    && typeof semantic.cosine === 'function'
    && typeof semantic.getQueryVector === 'function'
    && typeof semantic.getVector === 'function'
    ? semantic.getQueryVector()
    : undefined;
  const scored = [];
  for (const entry of rows) {
    const name = String(entry.name ?? '').toLowerCase();
    const description = String(entry.description ?? '').toLowerCase();
    const nameTokens = tokenize(name);
    const descriptionTokens = tokenize(description);
    let score = 0;
    for (const term of terms) {
      const inName = nameTokens.filter((token) => token === term).length;
      const inDescription = descriptionTokens.filter((token) => token === term).length;
      if (inName > 0) score += 6 + inName;
      if (inDescription > 0) score += 1 + Math.min(inDescription, 3) * 0.5;
    }
    let semanticScore = 0;
    if (queryVector !== undefined) {
      const vector = semantic.getVector(entry);
      if (vector !== undefined) {
        const similarity = semantic.cosine(queryVector, vector);
        if (similarity >= rescueFloor) {
          semanticScore = weight * Math.min(1, Math.max(0, (similarity - rescueFloor) / (1 - rescueFloor)));
        }
      }
    }
    if (score === 0 && semanticScore === 0) continue;
    if (score === 0) {
      // Rescue only: strictly below one lexical name-token hit (6 + >=1 >= 7).
      score = semanticScore * 7.5;
    } else {
      // Boost only: at most +8, never enough to flip an exact (+50) or
      // prefix (+12) name match, and rarely enough to flip one extra
      // name-token hit - but it reorders the noisy middle of the list.
      score += semanticScore * 8;
    }
    if (name === String(query ?? '').toLowerCase()) score += 50;
    else if (name.includes(String(query ?? '').toLowerCase().trim()) && String(query ?? '').trim().length > 1) score += 12;
    score -= nameTokens.length * 0.01;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.entry.name < b.entry.name ? -1 : 1));
  // Namespace diversity: cap how many rows from one namespace may sit in the
  // top, pushing overflow rows behind other namespaces. A single MCP server
  // with many near-identical tools otherwise monopolizes every query.
  const cap = Math.max(3, Math.ceil(limit / 2));
  const perNamespace = new Map();
  const primary = [];
  const overflow = [];
  for (const row of scored) {
    const bucket = namespaceOf(row.entry.name);
    const used = perNamespace.get(bucket) ?? 0;
    if (primary.length < limit && used < cap) {
      perNamespace.set(bucket, used + 1);
      primary.push(row);
    } else {
      overflow.push(row);
    }
  }
  return [...primary, ...overflow].slice(0, limit).map((row) => row.entry);
}

/**
 * Build the text this package injects in place of the generated `tools:sdk`
 * section.
 *
 * It documents the transport contract, the discovery tools, and how many hidden
 * tools exist per namespace — and deliberately carries no hidden tool's name or
 * schema, so the request surface stays constant as MCP servers connect. The
 * standard tools are *not* summarized here: they stay natively callable, so the
 * model already has their schemas.
 *
 * `programFormat` comes from the mounted runtime: a retained REPL (the
 * `persistent-in-memory` execution mode) has no top-level `return`, and saying
 * otherwise would advertise syntax the program cannot use.
 */
export function buildCodemodeSectionText(input) {
  const {
    runToolName = DEFAULT_RUN_TOOL_NAME,
    metaTools = DEFAULT_META_TOOLS,
    hidden = { total: 0, namespaces: [] },
    searchLimit = 8,
    programFormat,
  } = input ?? {};
  const retained = programFormat === 'repl';
  const [listTool, searchTool, describeTool] = metaTools;
  const lines = [];

  lines.push('## Code Mode');
  lines.push('');
  lines.push(`This session runs in Code Mode. Tools listed in your tool list are called directly, as usual. A second, larger set of tools — every tool this preset does not own, including every MCP tool and every tool contributed by a plugin outside the preset — is deliberately **not** in your context and is reachable only from inside \`${runToolName}\`.`);
  lines.push('');
  lines.push('### Calling tools from a program');
  lines.push('');
  lines.push('```js');
  lines.push(`// standard tools and every masked tool alike`);
  lines.push('const files = await tools.glob({ pattern: "src/**/*.ts" })');
  lines.push('const rows = await Promise.all(files.map((f) => tools.read({ file_path: f })))');
  lines.push(retained
    ? 'rows.filter((r) => r.includes("TODO")).map((r) => r.split("\\n")[0])'
    : 'return rows.filter((r) => r.includes("TODO")).map((r) => r.split("\\n")[0])');
  lines.push('```');
  lines.push('');
  if (retained) {
    lines.push('- A retained TypeScript REPL: top-level declarations, `await`, and a final expression. This program shares its variables, functions, and imported modules with your later programs in this session.');
    lines.push('- Only printed values and the final expression become program output; every intermediate result stays in the program, so filter and aggregate there instead of emitting raw payloads.');
  } else {
    lines.push('- Erasable TypeScript, run as the body of an async function: top-level `await` and `return` work.');
    lines.push('- Only what you `return` or `console.log` reaches the conversation; every intermediate result stays in the program, so filter and aggregate there instead of returning raw payloads.');
  }
  lines.push('- Independent read-only calls may overlap under `Promise.all`; mutating calls run alone, in submission order.');
  lines.push('- A failed sub-call rejects; `try/catch` or `Promise.allSettled` it to keep the calls that succeeded. Completed calls are real side effects and are not rolled back.');
  lines.push('');
  if (hidden.total > 0) {
    lines.push('### Masked tools');
    lines.push('');
    lines.push(`${hidden.total} tool(s) are outside this preset's standard composition and are hidden from your context, by namespace:`);
    lines.push('');
    for (const entry of hidden.namespaces) {
      lines.push(entry.kind === 'mcp'
        ? `- \`${entry.namespace}\` (MCP server) — ${entry.count} tool(s), callable as \`tools.mcp__${entry.namespace}__<tool>({...})\``
        : `- \`${entry.namespace}\` (contributed by plugins outside this preset) — ${entry.count} tool(s), callable by exact name as \`tools.<name>({...})\``);
    }
    lines.push('');
    lines.push('Discover them from inside a program, then call them by exact name:');
    lines.push('');
    lines.push('```js');
    lines.push(`const { tools: hits } = await tools.${searchTool}({ query: "what you need", limit: ${searchLimit} })`);
    lines.push('// hits[0].name, hits[0].description, hits[0].parameters (full JSON Schema)');
    lines.push(retained
      ? 'await tools[hits[0].name]({ /* arguments matching hits[0].parameters */ })'
      : 'return await tools[hits[0].name]({ /* arguments matching hits[0].parameters */ })');
    lines.push('```');
  } else {
    lines.push('### Masked tools');
    lines.push('');
    lines.push('No masked tools are connected right now. If an MCP server or an out-of-preset plugin contributes one later, it appears here automatically and is reachable the same way.');
  }
  lines.push('');
  lines.push('### Discovery API (all callable from inside a program)');
  lines.push('');
  lines.push(`- \`tools.${listTool}({ namespace? })\` — every callable tool as \`{ name, description, namespace, hidden }\`, masked ones included.`);
  lines.push(`- \`tools.${searchTool}({ query, limit?, namespace? })\` — ranked matches with their full parameter schemas; this is the intended first step.`);
  lines.push(`- \`tools.${describeTool}({ name })\` — one tool's description and complete parameter schema.`);
  if (metaTools.length > 3) {
    lines.push(`- \`tools.${metaTools[3]}({ limit? })\` — what Code Mode masked out of this session's request surface, for troubleshooting.`);
  }
  lines.push('');
  lines.push('### Hard rules');
  lines.push('');
  lines.push(`- Never guess a masked tool's name or arguments. Call \`${searchTool}\` first, read \`parameters\`, then call it inside the same or a later \`${runToolName}\` program.`);
  lines.push('- A direct call to a masked tool — one that does not come from inside a program — is rejected by the harness.');
  lines.push(`- The discovery tools are themselves only callable from inside \`${runToolName}\`; they are not part of your tool list.`);
  return lines.join('\n');
}
