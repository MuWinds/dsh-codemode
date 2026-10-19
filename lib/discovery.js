/**
 * The three discovery tools registered inside the codemode preset scope.
 *
 * They are ordinary tools on the DSH registry, which buys three things at once:
 * they exist only for sessions on this preset, they automatically become
 * bindings inside the program transport (`tools.code_tools_search(...)`), and every call
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
  DEFAULT_RUN_TOOL_NAME,
  isMaskedName,
  namespaceOf,
  rankTools,
  summarizeHidden,
  truncate,
} from './rules.js';
import { resolveScopeView } from './scope.js';

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
 * Resolve the tools one call may see, through the registry's public surface.
 *
 * `schemas(scope)` is the documented projection, but it carries only the
 * model-facing fields (`name`, `description`, `parameters`) — the output schema
 * the discovery tools report lives on the definition, so each name is resolved
 * again through the public `get(name, scope)`. The registry's `view()` would
 * return whole definitions in one call, but it is declared `private` in
 * `dsh-tools`, and a plugin has no business depending on it.
 *
 * `exec.agent` is the calling agent, so a preset-scoped registration resolves
 * exactly the set the model's request was assembled from — including the tools
 * hidden from that request.
 */
export function visibleDefinitions(ctx, exec) {
  const scope = exec?.agent;
  try {
    const schemas = ctx?.tools?.schemas?.(scope);
    if (!Array.isArray(schemas)) return [];
    const rows = [];
    for (const schema of schemas) {
      if (schema === null || typeof schema !== 'object' || typeof schema.name !== 'string') continue;
      let definition;
      try {
        definition = ctx.tools.get?.(schema.name, scope);
      } catch {
        definition = undefined;
      }
      // Fall back to the projection when a definition cannot be resolved, so a
      // listing still shows the tool even without its output schema.
      rows.push(definition ?? schema);
    }
    return rows;
  } catch {
    /* no enumerable registry surface at all */
    return [];
  }
}

/**
 * Scope facts for one listing: the same attribution the request masking used,
 * so a row's `hidden` flag and the model's own tool list never disagree.
 * @returns the resolved view, or an inert one when the caller supplied no scope.
 */
function listingView(ctx, extras, definitions, exec) {
  return resolveScopeView(ctx, extras?.scopeKey, definitions.map((definition) => definition.name), exec?.agent);
}

/** One listing row: name, truncated description, namespace, hidden flag. */
function listingRow(definition, options, view) {
  const hidden = isMaskedName(definition.name, options, view);
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
 * @param runToolName - this package's transport tool name, excluded from listings.
 * @param extras - `getDebug()` supplies the masking history for the optional debug tool;
 *   `scopeKey` is the preset scope {@link resolveScopeView} attributes tools by.
 */
export function createDiscoveryTools(ctx, options, runToolName = DEFAULT_RUN_TOOL_NAME, extras = {}, embedder = null) {
  const [listName, searchName, describeName, debugName] = options.metaTools;

  const definitions = [
    {
      name: listName,
      description:
        `List every tool this session can call from inside ${runToolName}, including the ones masked out of the `
        + 'model context (MCP tools, tools contributed by plugins outside this preset). Returns name, truncated '
        + 'description, namespace and a hidden flag — no schemas. Use the search tool to obtain parameter schemas.',
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
          .filter((definition) => definition.name !== runToolName)
          .slice(0, MAX_ROWS);
        const view = listingView(ctx, extras, definitions, exec);
        const rows = definitions
          .map((definition) => listingRow(definition, options, view))
          .filter((row) => namespace === undefined || namespace === '' || row.namespace === namespace);
        return {
          total: rows.length,
          hidden: rows.filter((row) => row.hidden).length,
          namespaces: summarizeHidden(definitions.map((definition) => definition.name), options, view).namespaces,
          tools: rows,
        };
      },
    },
    {
      name: searchName,
      description:
        'Rank the callable tools against a query and return the best matches WITH their full JSON parameter '
        + `schemas. This is the intended first step before calling a tool the model cannot see from inside ${runToolName}.`,
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
          .filter((definition) => definition.name !== runToolName);
        const view = listingView(ctx, extras, definitions, exec);
        const rows = definitions.map((definition) => ({
          name: definition.name,
          description: definition.description,
          definition,
        }));
        // Hybrid ranking: when embeddings are on and the provider is reachable,
        // fuse a cosine signal into rankTools. Any failure leaves `semantic`
        // empty, which is byte-for-byte the upstream lexical path.
        let semantic = {};
        if (embedder !== null && embedder.options.enabled) {
          const texts = [query, ...rows.map((row) => `${row.name} ${row.description ?? ''}`)];
          const getVector = await embedder.ensure(texts);
          const queryVector = getVector(query);
          if (queryVector !== undefined) {
            semantic = {
              weight: options.semanticWeight,
              rescueFloor: options.semanticRescueFloor,
              cosine: embedder.cosine,
              getQueryVector: () => queryVector,
              getVector: (entry) => getVector(`${entry.name} ${entry.description ?? ''}`),
            };
          }
        }
        const ranked = rankTools(query, rows, limit, namespace, semantic);
        const result = {
          query,
          count: ranked.length,
          semantic: semantic.weight !== undefined ? 'on' : 'off',
          tools: ranked.map((row) => ({
            name: row.name,
            description: truncate(row.description, options.maxDescriptionChars * 2),
            namespace: isMaskedName(row.name, options, view) ? namespaceOf(row.name) : 'native',
            hidden: isMaskedName(row.name, options, view),
            parameters: row.definition.parameters ?? { type: 'object', additionalProperties: true },
            output: row.definition.output?.schema,
          })),
        };
        if (ranked.length === 0) {
          result.hint = 'No lexical or semantic match. Do not rephrase-and-retry blindly: call the list tool and browse by namespace, or describe by exact name if you know it.';
        }
        return result;
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
        const definitions = visibleDefinitions(ctx, exec);
        const view = listingView(ctx, extras, definitions, exec);
        const definition = definitions.find((row) => row.name === name);
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
          namespace: isMaskedName(name, options, view) ? namespaceOf(name) : 'native',
          hidden: isMaskedName(name, options, view),
          parameters: definition.parameters ?? { type: 'object', additionalProperties: true },
          output: definition.output?.schema,
        };
      },
    },
  ];

  // Troubleshooting surface: what this preset keeps out of the request, with
  // tool NAMES and counts only. Registered like the others, so it is hidden from
  // the model's tool list and reachable only from inside the program transport.
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
          .filter((definition) => definition.name !== runToolName)
          .map((definition) => definition.name);
        const view = resolveScopeView(ctx, extras?.scopeKey, names, exec?.agent);
        return {
          hiddenPrefixes: options.hiddenPrefixes,
          nativeScope: options.nativeScope,
          nativeTools: options.nativeTools,
          hiddenTools: options.hiddenTools,
          discoveryTools: options.metaTools,
          hidden: summarizeHidden(names, options, view),
          assemblies: state.assemblies,
          recent: state.entries.slice(-limit),
        };
      },
    });
  }

  return definitions;
}
