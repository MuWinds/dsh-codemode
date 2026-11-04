/**
 * The plugin-owned PTC transport.
 *
 * DSH 0.2.1-alpha.5 removed the `both` presentation mode, so "native tools plus
 * the reserved `run_code`" is no longer composable from configuration. This
 * module rebuilds that surface out of public API instead of reaching into the
 * registry:
 *
 *   - the preset presents natively, so the standard tools stay directly
 *     callable and this package's discovery tools stay in the registry;
 *   - this tool is the only extra schema the model sees;
 *   - its sub-calls go through the registry's public `execute()`, so they keep
 *     the full built-in pipeline — pre-policy, guards, allow/deny/ask and
 *     approval, around-dispatch, and post-execute — and are marked as nested by
 *     the public `parent` token, the same way the built-in transport marks them.
 *     They are NOT durably recorded, though: `execute()` only emits the
 *     `tools/result` event, and the `tool/result` session entry is appended by
 *     the agent loop for the calls it scheduled itself, not by the registry.
 *     The built-in transport writes `tool/ptc-dispatch` events of its own; this
 *     one does not (see the README's limitations); and
 *   - the program's deadline is enforced by the runtime, which clamps
 *     `timeoutMs` against its configured default and maximum.
 *
 * Program-level `sandbox_permissions` escalation is deliberately not offered:
 * the built-in approval helper is module-private, and omitting the parameters
 * keeps every program on the standing policy while each individual sub-call
 * still runs its own built-in approval.
 *
 * @module dsh-codemode/transport
 */

import { markNested } from './executor.js';
import { createPool, normalizeMaxParallel } from './pool.js';

/** Permissive canonical output: the transport returns a JSON object. */
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true };

/** Raised when the program itself failed; the message carries the runtime's taxonomy. */
export class ProgramFailedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProgramFailedError';
  }
}

/**
 * Raised when a sub-call the program made failed. Carries the tool name so a
 * program's `catch` can tell which call it was, matching the contract the
 * built-in transport exposes through `ToolCallError`.
 */
export class ToolCallFailedError extends Error {
  constructor(message, toolName) {
    super(message);
    this.name = 'ToolCallError';
    this.toolName = toolName;
  }
}

/**
 * Serialize one program sub-call's arguments.
 *
 * The registry's batch input carries the model-facing JSON text, not a value:
 * it parses and validates it in its own pipeline, which is exactly the path a
 * program sub-call must take so it keeps validation, policy and approval.
 */
function stringifyArguments(rawArgs) {
  if (typeof rawArgs === 'string') return rawArgs;
  if (rawArgs === undefined || rawArgs === null) return '{}';
  return JSON.stringify(rawArgs);
}

/**
 * The signal a program sub-call runs under.
 *
 * A fresh controller, because the nesting marker has to be an object this
 * plugin created — forwarding the outer `exec.signal` directly would mean
 * marking a signal the caller owns. Cancellation is chained instead: aborting
 * the outer call aborts every sub-call, which is the behaviour the built-in
 * transport gets for free by passing its own signal through.
 *
 * @param outer - the enclosing execution's signal, when there is one.
 * @returns the signal to hand the registry.
 */
function nestedSignal(outer) {
  const controller = new AbortController();
  if (outer !== undefined && outer !== null) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Classify one sub-call's scheduling mode through the registry.
 *
 * DSH 0.2.2 removed `tools.executionMode()`; the classifier now lives on the
 * per-executor pipeline. A plugin-owned transport has no pipeline of its own,
 * so the mode is derived from the tool definition the registry resolves —
 * which is the same predicate (`isConcurrencySafe`) the pipeline would read.
 *
 * @returns `'parallel'` or `'exclusive'`; unknown or throwing classifiers fail
 *   closed to exclusive, matching the pipeline's own contract.
 */
function classify(ctx, name, agent) {
  try {
    const definition = ctx.tools.get?.(name, agent);
    if (definition === undefined || typeof definition.isConcurrencySafe !== 'function') return 'exclusive';
    return definition.isConcurrencySafe({}) === true ? 'parallel' : 'exclusive';
  } catch {
    return 'exclusive';
  }
}

/** Render a JSON value as one text block. */
function renderJson(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

/**
 * The `code` parameter text, which is the one place the program syntax is
 * visible besides the prompt section. A retained REPL has no top-level
 * `return`, so advertising "the body of an async function" there would be
 * wrong — the runtime reports which one it is through `programFormat`.
 */
function codeParameter(programFormat) {
  return programFormat === 'repl'
    ? {
      type: 'string',
      description: 'The program to execute: a TypeScript REPL program. Top-level declarations, `await`, and a final expression are supported; a top-level `return` is not.',
    }
    : {
      type: 'string',
      description: 'The BODY of an async TypeScript function: erasable syntax only, with top-level `await` and `return` supported.',
    };
}

/**
 * Build the tool's parameter schema. `timeoutMs` is advertised only when the
 * runtime reports a descriptor, mirroring how the built-in tool derives its
 * control parameters, so the model is never offered a knob the runtime cannot
 * honour.
 */
export function parameterSchema(runtime) {
  const timeout = runtime?.timeout;
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: codeParameter(runtime?.programFormat),
      description: {
        type: 'string',
        description: 'Clear, concise description of what this program does, 5-10 words (shown in the UI).',
      },
      ...timeout === undefined ? {} : {
        timeoutMs: {
          type: 'number',
          description: `Positive elapsed-time budget in milliseconds, including nested tool and approval waits. Default ${timeout.defaultMs}; capped at ${timeout.maxMs}.`,
        },
      },
    },
    required: ['code', 'description'],
  };
}

/** Resolve the agent's working directory through the host service, as the built-in transport does. */
async function resolveWorkingDirectory(ctx, agent, signal) {
  if (agent === undefined) return undefined;
  const directories = ctx.get?.('workingDirectory');
  if (directories === undefined) {
    throw new Error('dsh-codemode: code execution for an agent requires the workingDirectory service (composed by @deepseek-ai/dsh-tool-fs)');
  }
  return directories.ensure(agent, signal);
}

/** Resolve the standing file policy for the program, when the deployment has one. */
function resolveSandboxPolicy(ctx, agent) {
  const policy = ctx.get?.('sandboxPolicy');
  if (policy === undefined) return undefined;
  return policy.resolve(agent === undefined ? {} : { session: agent.session });
}

/**
 * Build the transport tool definition.
 * @param ctx - the plugin's scoped context.
 * @param options - normalized plugin config.
 * @param hooks - `retention` owns the retained-environment lifecycle; `code` names the tool in messages.
 * @returns a registry-ready tool definition.
 */
export function createTransportTool(ctx, options, hooks = {}) {
  const runToolName = options.runToolName;
  const maxParallel = normalizeMaxParallel(options.maxParallelSubCalls);

  const definition = {
    name: runToolName,
    description:
      `Execute a TypeScript program against this session's tools. Takes two required arguments: \`code\` and `
      + '`description`. Call tools as `await tools.name(args)` — quoted access for exotic names: `tools["my-tool"](args)`. '
      + 'A failed tool call rejects with `ToolCallError`, whose `toolName` identifies the tool and whose `message` is '
      + 'human-readable. Only what the program prints or returns becomes program output; other intermediate results stay '
      + 'out of the conversation.',
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderJson(value) },
    // Programs mutate state and are ordered as a unit, so they never overlap
    // with a sibling call in the same model step.
    isConcurrencySafe: () => false,

    async execute(args, exec) {
      if (typeof args?.code !== 'string' || args.code.trim().length === 0) {
        throw new Error(`invalid code: ${runToolName} expects a non-empty program`);
      }
      if (typeof args?.description !== 'string' || args.description.trim().length === 0) {
        throw new Error('invalid description: expected a non-empty string');
      }
      if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
        throw new Error('invalid timeoutMs: expected a positive finite number');
      }

      const runtime = ctx.get?.('ptcRuntime');
      if (runtime === undefined) {
        throw new Error(`dsh-codemode: ${runToolName} requires a PTC runtime service (compose @deepseek-ai/dsh-ptc-runtime-node)`);
      }
      // Mirror the built-in: never forward a deadline a runtime cannot honour.
      // This package registers a raw definition, so the registry does no schema
      // validation of its own and this check is load-bearing.
      if (args.timeoutMs !== undefined && runtime.timeout === undefined) {
        throw new Error('timeoutMs is not available for this PTC runtime');
      }

      const agent = exec?.agent;
      const cwd = await resolveWorkingDirectory(ctx, agent, exec?.signal);
      const sandboxPolicy = resolveSandboxPolicy(ctx, agent);
      // The ONLY place a stateOwner is produced; see lib/retention.js. An
      // agentless call is checked here as well as there: with no agent there is
      // no lifetime to bind a retained environment to, so the decision must not
      // depend on the registry's own discipline.
      const owner = agent === undefined ? undefined : hooks.retention?.ownerFor(agent, runtime);

      const pool = createPool(maxParallel);
      let dispatches = 0;

      /**
       * Dispatch one program sub-call through the registry's public batch entry
       * point.
       *
       * DSH 0.2.2 takes a batch (`{ calls, agent, signal }`) and mints execution
       * tokens inside its own pipeline, so a plugin-owned transport cannot pass
       * an opaque `parent`. The sub-call is therefore marked on the `signal`
       * instead — an object the model cannot fabricate — which is what both the
       * executor's denial check and the pool's classifier read. The `:ptc:`
       * call id is kept as the second, belt-and-braces signal.
       */
      const dispatch = async (name, schema, rawArgs) => {
        const callId = `${String(exec.callId)}:ptc:${++dispatches}`;
        const call = {
          id: callId,
          name,
          schema,
          type: 'tool-call',
          arguments: stringifyArguments(rawArgs),
        };
        const outcome = await ctx.tools.execute({
          calls: [call],
          ...(agent === undefined ? {} : { agent }),
          signal: markNested(nestedSignal(exec.signal)),
        });
        const settled = outcome?.results?.[0]?.result;
        if (settled === undefined) {
          throw new Error(`tool "${name}" produced no result`);
        }
        if (settled.isError) {
          throw new ToolCallFailedError(`tool "${name}" failed: ${settled.error?.message ?? 'unknown error'}`, name);
        }
        return settled.value;
      };

      const functions = Object.create(null);
      for (const schema of ctx.tools.schemas?.(agent) ?? []) {
        if (schema?.name === undefined || schema.name === runToolName) continue;
        Object.defineProperty(functions, schema.name, {
          enumerable: true,
          value: (rawArgs) => {
            // Classify through the registry so the pool reproduces the same
            // parallel/exclusive contract the loop's scheduler would apply.
            const kind = classify(ctx, schema.name, agent);
            return pool.run(() => dispatch(schema.name, schema, rawArgs), kind);
          },
        });
      }

      try {
        const result = await runtime.run(runtime.resolve({
          program: args.code,
          ...(owner === undefined ? {} : { stateOwner: owner }),
          bindings: [{
            global: 'tools',
            functions,
            errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
          }],
          signal: exec.signal,
          ...(cwd === undefined ? {} : { cwd }),
          ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        }));

        if (result.error) {
          const logsText = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join('\n')}` : '';
          throw new ProgramFailedError(`code run failed (${result.error.kind}): ${result.error.message}${logsText}`);
        }
        return {
          logs: result.logs,
          ...result.sandbox === undefined ? {} : { sandbox: result.sandbox },
          ...result.value === undefined ? {} : { result: result.value },
        };
      } finally {
        // The program is over: a sub-call it queued but never reached must not
        // run after the fact. In-flight calls still finish, and the outer
        // result only leaves once they have.
        pool.abandon();
        await pool.drain();
      }
    },
  };

  // The parameter schema depends on the mounted runtime, which is resolved at
  // use time and never injected (a static inject would hold the whole tool
  // registry hostage to a PTC runtime existing). The getter mirrors the
  // built-in transport so the descriptor is read fresh per projection.
  Object.defineProperty(definition, 'parameters', {
    enumerable: true,
    get: () => parameterSchema(ctx.get?.('ptcRuntime')),
  });

  return definition;
}
