/**
 * The three discovery tools registered inside the codemode preset scope.
 *
 * They are ordinary tools on the DSH registry, which buys three things at once:
 * they exist only for sessions on this preset, they automatically become
 * bindings inside `run_code` (`tools.code_tools_search(...)`), and every call
 * runs through the normal pipeline (validation, policy, guards, timeouts,
 * session logging) instead of a private shortcut.
 *
 * Definitions are written as plain objects on purpose: this package has no
 * runtime dependency on any `@deepseek-ai/*` package, so `defineTool` is not
 * importable from a profile plugin. Argument and output shapes are therefore
 * validated here, by hand.
 * @module dsh-codemode/discovery
 */

import {
  isHiddenName,
  namespaceOf,
  rankTools,
  summarizeHidden,
  truncate,
} from './rules.js';

/** Permissive canonical output: every discovery tool returns a JSON object. */
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true };

/** Upper bound on rows a single call materializes, so a 300-tool server cannot blow up a program. */
const MAX_ROWS = 2000;

/** Render a JSON value as one text block. */
function renderJson(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return [{ type: 'text', text }];
}

/**
 * Resolve the tools one call may see, through the registry's scope-aware view.
 * `exec.agent` is the calling agent, so a preset-scoped registration resolves
 * exactly the set the model's request was assembled from — including the tools
 * hidden from that request.
 */
export function visibleDefinitions(ctx, exec) {
  const scope = exec?.agent;
  try {
    const view = ctx?.tools?.view?.(scope);
    if (view?.visible instanceof Map) {
      return [...view.visible.values()].filter((definition) => definition && typeof definition.name === 'string');
    }
  } catch {
    /* fall through to the schema projection below */
  }
  try {
    const schemas = ctx?.tools?.schemas?.(scope);
    if (Array.isArray(schemas)) return schemas.filter((row) => row && typeof row.name === 'string');
  } catch {
    /* no enumerable view at all */
  }
  return [];
}

/** One listing row: name, truncated description, namespace, hidden flag. */
function listingRow(definition, options, runCodeName) {
  const hidden = isHiddenName(definition.name, options);
  return {
    name: definition.name,
    description: truncate(definition.description, options.maxDescriptionChars),
    namespace: hidden ? namespaceOf(definition.name) : 'native',
    hidden,
  };
}

/** A non-empty string argument, or a thrown error naming the tool that wanted it. */
function requireString(args, key, toolName) {
  const value = args?.[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${toolName}: "${key}" must be a non-empty string`);
  }
  return value;
}

/**
 * Build the discovery tool definitions.
 * @param ctx - the plugin's scoped context.
 * @param options - normalized plugin config.
 * @param runCodeName - the reserved PTC transport name, excluded from listings.
 * @param extras - `getDebug()` supplies the masking history for the optional debug tool.
 */
export function createDiscoveryTools(ctx, options, runCodeName = 'run_code', extras = {}) {
  const [listName, searchName, describeName, debugName] = options.metaTools;

  const definitions = [
    {
      name: listName,
      description:
        'List every tool this session can call from inside run_code, including the ones hidden from the '
        + 'model context (MCP tools). Returns name, truncated description, namespace and a hidden flag — '
        + 'no schemas. Use the search tool to obtain parameter schemas.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          namespace: {
            type: 'string',
            description: 'Optional namespace filter, e.g. an MCP server name or "native" for the built-in tools.',
          },
        },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const namespace = typeof args?.namespace === 'string' ? args.namespace : undefined;
        const definitions = visibleDefinitions(ctx, exec)
          .filter((definition) => definition.name !== runCodeName)
          .slice(0, MAX_ROWS);
        const rows = definitions
          .map((definition) => listingRow(definition, options, runCodeName))
          .filter((row) => namespace === undefined || namespace === '' || row.namespace === namespace);
        return {
          total: rows.length,
          hidden: rows.filter((row) => row.hidden).length,
          namespaces: summarizeHidden(definitions.map((definition) => definition.name), options).namespaces,
          tools: rows,
        };
      },
    },
    {
      name: searchName,
      description:
        'Rank the callable tools against a query and return the best matches WITH their full JSON parameter '
        + 'schemas. This is the intended first step before calling a hidden (MCP) tool from inside run_code.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'What you need the tool to do, in natural language or by tool-name fragment.' },
          limit: { type: 'number', description: `Maximum rows to return. Default ${options.searchLimit}.` },
          namespace: { type: 'string', description: 'Optional namespace filter, e.g. one MCP server name.' },
        },
        required: ['query'],
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const query = requireString(args, 'query', searchName);
        const limit = Number.isFinite(args?.limit) && args.limit > 0 ? Math.min(Math.floor(args.limit), 50) : options.searchLimit;
        const namespace = typeof args?.namespace === 'string' ? args.namespace : undefined;
        const definitions = visibleDefinitions(ctx, exec)
          .filter((definition) => definition.name !== runCodeName);
        const ranked = rankTools(
          query,
          definitions.map((definition) => ({ name: definition.name, description: definition.description, definition })),
          limit,
          namespace,
        );
        return {
          query,
          count: ranked.length,
          tools: ranked.map((row) => ({
            name: row.name,
            description: truncate(row.description, options.maxDescriptionChars * 2),
            namespace: isHiddenName(row.name, options) ? namespaceOf(row.name) : 'native',
            hidden: isHiddenName(row.name, options),
            parameters: row.definition.parameters ?? { type: 'object', additionalProperties: true },
            output: row.definition.output?.schema,
          })),
        };
      },
    },
    {
      name: describeName,
      description:
        'Return one callable tool\'s description and complete JSON parameter schema by exact name. '
        + 'Use it after the search tool, or when you already know the exact tool name.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'The exact tool name, e.g. "mcp__okx__market_get_ticker".' },
        },
        required: ['name'],
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const name = requireString(args, 'name', describeName);
        const definition = visibleDefinitions(ctx, exec)
          .find((row) => row.name === name);
        if (definition === undefined) {
          return {
            found: false,
            name,
            hint: `No tool named "${name}" is callable here. List them with tools.${listName}({}).`,
          };
        }
        return {
          found: true,
          name: definition.name,
          description: definition.description,
          namespace: isHiddenName(name, options) ? namespaceOf(name) : 'native',
          hidden: isHiddenName(name, options),
          parameters: definition.parameters ?? { type: 'object', additionalProperties: true },
          output: definition.output?.schema,
        };
      },
    },
  ];

  // Troubleshooting surface: what this preset keeps out of the request, with
  // tool NAMES and counts only. Registered like the others, so it is hidden from
  // the model's tool list and reachable only from inside run_code.
  if (options.debug && debugName !== undefined && typeof extras.getDebug === 'function') {
    definitions.push({
      name: debugName,
      description:
        'Report what Code Mode keeps out of this session\'s request surface: the hidden tool namespaces with counts, '
        + 'the tools dropped from the last assembled request, and the tools that request did carry. For troubleshooting.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'number', description: 'How many recent assembly decisions to return. Default 5.' },
        },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const limit = Number.isFinite(args?.limit) && args.limit > 0 ? Math.min(Math.floor(args.limit), 50) : 5;
        const state = extras.getDebug();
        const names = visibleDefinitions(ctx, exec)
          .filter((definition) => definition.name !== runCodeName)
          .map((definition) => definition.name);
        return {
          hiddenPrefixes: options.hiddenPrefixes,
          discoveryTools: options.metaTools,
          hidden: summarizeHidden(names, options),
          assemblies: state.assemblies,
          recent: state.entries.slice(-limit),
        };
      },
    });
  }

  return definitions;
}
