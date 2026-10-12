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
  guard: true,
  sdkSection: true,
  debug: true,
  searchLimit: 8,
  maxDescriptionChars: 240,
};

/** Normalize plugin config into the frozen shape the rest of the module reads. */
export function normalizeConfig(config = {}) {
  const hiddenPrefixes = Array.isArray(config.hiddenPrefixes) && config.hiddenPrefixes.length > 0
    ? config.hiddenPrefixes.map(String)
    : DEFAULTS.hiddenPrefixes;
  const metaTools = Array.isArray(config.metaTools) && config.metaTools.length > 0
    ? config.metaTools.map(String)
    : DEFAULTS.metaTools;
  const searchLimit = Number.isFinite(config.searchLimit) && config.searchLimit > 0
    ? Math.floor(config.searchLimit)
    : DEFAULTS.searchLimit;
  const maxDescriptionChars = Number.isFinite(config.maxDescriptionChars) && config.maxDescriptionChars > 0
    ? Math.floor(config.maxDescriptionChars)
    : DEFAULTS.maxDescriptionChars;
  return {
    hiddenPrefixes,
    metaTools,
    markerTool: metaTools[0],
    guard: config.guard !== false,
    sdkSection: config.sdkSection !== false,
    debug: config.debug !== false,
    searchLimit,
    maxDescriptionChars,
  };
}

/** Whether a tool name is hidden from the model's request surface. */
export function isHiddenName(name, options) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (options.metaTools.includes(name)) return true;
  return options.hiddenPrefixes.some((prefix) => name.startsWith(prefix));
}

/** Drop every hidden tool from an assembled request's tool list. */
export function filterAssemblyTools(tools, options) {
  if (!Array.isArray(tools)) return tools;
  return tools.filter((tool) => !isHiddenName(tool?.name, options));
}

/**
 * Best-effort namespace of an MCP tool name (`mcp__<server>__<tool>`).
 * dsh-mcp-client pins the public name as a pure function of (serverName,
 * rawName); a server name containing a literal `__` is the only ambiguous case
 * and degrades to the `mcp` bucket, which is fine for a hint.
 */
export function namespaceOf(name) {
  const match = /^mcp__(.+?)__(.*)$/.exec(String(name ?? ''));
  return match === null ? 'mcp' : match[1];
}

/**
 * Summarize the hidden half of a tool list as counts per namespace. Only names
 * and numbers leave this function — never a hidden tool's schema, description,
 * or parameters.
 */
export function summarizeHidden(names, options) {
  const servers = new Map();
  let total = 0;
  for (const name of names ?? []) {
    if (!isHiddenName(name, options)) continue;
    if (options.metaTools.includes(name)) continue;
    total += 1;
    const namespace = namespaceOf(name);
    servers.set(namespace, (servers.get(namespace) ?? 0) + 1);
  }
  const namespaces = [...servers.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([namespace, count]) => ({ namespace, count }));
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
 * @param query - free text; empty returns the first `limit` entries in order.
 * @param entries - `{ name, description }` rows.
 * @param limit - maximum rows to return.
 * @param namespace - optional namespace filter (an MCP server name).
 */
export function rankTools(query, entries, limit, namespace) {
  const rows = (entries ?? []).filter((entry) => {
    if (namespace === undefined || namespace === '') return true;
    return namespaceOf(entry.name) === namespace;
  });
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return rows.slice(0, limit);
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
    if (score === 0) continue;
    if (name === String(query ?? '').toLowerCase()) score += 50;
    else if (name.includes(String(query ?? '').toLowerCase().trim()) && String(query ?? '').trim().length > 1) score += 12;
    score -= nameTokens.length * 0.01;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.entry.name < b.entry.name ? -1 : 1));
  return scored.slice(0, limit).map((row) => row.entry);
}

/**
 * Build the replacement text for the `tools:sdk` prompt section.
 *
 * It documents the run_code contract, the discovery tools, and how many hidden
 * tools exist per namespace — and deliberately carries no hidden tool's name or
 * schema, so the request surface stays constant as MCP servers connect.
 */
export function buildCodemodeSectionText(input) {
  const {
    runCodeName = 'run_code',
    metaTools = DEFAULT_META_TOOLS,
    hidden = { total: 0, namespaces: [] },
    searchLimit = 8,
  } = input ?? {};
  const [listTool, searchTool, describeTool] = metaTools;
  const lines = [];

  lines.push('## Code Mode');
  lines.push('');
  lines.push(`This session runs in Code Mode. Tools listed in your tool list are called directly, as usual. A second, larger set of tools — every MCP tool — is deliberately **not** in your context and is reachable only from inside \`${runCodeName}\`.`);
  lines.push('');
  lines.push('### Calling tools from a program');
  lines.push('');
  lines.push('```js');
  lines.push(`// standard tools and hidden MCP tools alike`);
  lines.push('const files = await tools.glob({ pattern: "src/**/*.ts" })');
  lines.push('const rows = await Promise.all(files.map((f) => tools.read({ file_path: f })))');
  lines.push('return rows.filter((r) => r.includes("TODO")).map((r) => r.split("\\n")[0])');
  lines.push('```');
  lines.push('');
  lines.push('- Erasable TypeScript, run as the body of an async function: top-level `await` and `return` work.');
  lines.push('- Only what you `return` or `console.log` reaches the conversation; every intermediate result stays in the program, so filter and aggregate there instead of returning raw payloads.');
  lines.push('- Independent read-only calls may overlap under `Promise.all`; mutating calls run alone, in submission order.');
  lines.push('- A failed sub-call rejects; `try/catch` or `Promise.allSettled` it to keep the calls that succeeded. Completed calls are real side effects and are not rolled back.');
  lines.push('');
  if (hidden.total > 0) {
    lines.push('### Hidden tools');
    lines.push('');
    lines.push(`${hidden.total} tool(s) are hidden from your context, by namespace:`);
    lines.push('');
    for (const entry of hidden.namespaces) {
      lines.push(`- \`${entry.namespace}\` — ${entry.count} tool(s), callable as \`tools.mcp__${entry.namespace}__<tool>({...})\``);
    }
    lines.push('');
    lines.push('Discover them from inside a program, then call them by exact name:');
    lines.push('');
    lines.push('```js');
    lines.push(`const { tools: hits } = await tools.${searchTool}({ query: "what you need", limit: ${searchLimit} })`);
    lines.push('// hits[0].name, hits[0].description, hits[0].parameters (full JSON Schema)');
    lines.push('return await tools[hits[0].name]({ /* arguments matching hits[0].parameters */ })');
    lines.push('```');
  } else {
    lines.push('### Hidden tools');
    lines.push('');
    lines.push('No hidden tools are connected right now. If MCP servers are added later they appear here automatically and are reachable the same way.');
  }
  lines.push('');
  lines.push('### Discovery API (all callable from inside a program)');
  lines.push('');
  lines.push(`- \`tools.${listTool}({ namespace? })\` — every callable tool as \`{ name, description, namespace, hidden }\`, hidden ones included.`);
  lines.push(`- \`tools.${searchTool}({ query, limit?, namespace? })\` — ranked matches with their full parameter schemas; this is the intended first step.`);
  lines.push(`- \`tools.${describeTool}({ name })\` — one tool's description and complete parameter schema.`);
  if (metaTools.length > 3) {
    lines.push(`- \`tools.${metaTools[3]}({ limit? })\` — what Code Mode hid from this session's request surface, for troubleshooting.`);
  }
  lines.push('');
  lines.push('### Hard rules');
  lines.push('');
  lines.push(`- Never guess a hidden tool's name or arguments. Call \`${searchTool}\` first, read \`parameters\`, then call it inside the same or a later \`${runCodeName}\` program.`);
  lines.push('- A direct call to a hidden tool — one that does not come from inside a program — is rejected by the harness.');
  lines.push(`- The discovery tools are themselves only callable from inside \`${runCodeName}\`; they are not part of your tool list.`);
  return lines.join('\n');
}
