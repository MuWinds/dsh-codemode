#!/usr/bin/env node
/**
 * Assembly harness: run this package's `apply()` against the REAL DSH core.
 *
 * The unit tests drive `apply()` with a hand-written fake context; this script
 * instead composes cordis + `dsh-system-prompt` + `dsh-tools` + `dsh-scope` the
 * way a deployment does — a global layer, a preset scope holding this package as
 * one of its rows, an agent scope bound under the preset — and then runs one
 * real `systemPrompt.assemble()` plus real `ctx.tools.execute()` calls. It is
 * the check that keeps `lib/scope.js` honest after a DSH upgrade, because scope
 * attribution is the one thing the fakes cannot prove.
 *
 * The 0.1 line targets DSH `0.2.0-rc.2`, whose `dsh-tools` still has the
 * `mode: both` presentation: the harness mounts `ToolRuntime` with that mode and
 * with a stub `ctx.ptcRuntime`, so the request carries the harness's own
 * reserved `run_code` transport next to the native tools — exactly what the
 * `codemode` preset selects through `@deepseek-ai/dsh-agent-tool-presentation`.
 * This package registers no transport of its own and nothing may be named
 * `code_run`.
 *
 * It must be executed from a directory from which DSH's own packages resolve,
 * since it imports `@deepseek-ai/*` directly. The practical recipe: copy it next
 * to the packages of the DSH build under test, e.g. into
 *   <app>/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-tools/
 * and run:
 *   <node> verify-assembly.mjs <this-checkout>/lib/index.js
 *
 * @param argv[2] - absolute path to this package's `lib/index.js`.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Context } from '@deepseek-ai/cordis';
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';

const PLUGIN = resolve(process.argv[2] ?? new URL('../lib/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (!existsSync(PLUGIN)) {
  console.error(`verify-assembly: no plugin entry at ${PLUGIN}`);
  process.exit(2);
}

const failures = [];
const check = (label, actual, expected) => {
  const okValue = JSON.stringify(actual) === JSON.stringify(expected);
  if (!okValue) failures.push(`${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  console.log(`${okValue ? 'ok  ' : 'FAIL'} ${label}`);
};

function tool(name) {
  return defineTool({
    name,
    description: `fixture tool ${name}`,
    parameters: { query: { type: 'string' } },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'string', required: true } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() { return { ok: name }; },
  });
}

function registerIn(ctx, names) {
  return new Promise((done, fail) => {
    ctx.inject(['tools'], (injected) => {
      try {
        for (const name of names) injected.tools.register(tool(name));
        done();
      } catch (error) {
        fail(error);
      }
    });
  });
}

const root = new Context();
root.plugin(SystemPrompt, {});
// `mode: both` is DSH 0.2.0-rc.2's native-tools-plus-run_code presentation.
await root.plugin(ToolRuntime, { mode: 'both' });
// This package never registers a transport; the harness's `run_code` needs a
// PTC runtime service to assemble, so a stub stands in for the real backend.
root.plugin({
  name: 'verify-ptc-runtime',
  apply(ctx) {
    ctx.provide('ptcRuntime', { language: 'typescript' });
  },
});
const tools = root.get('tools', false);
const systemPrompt = root.get('systemPrompt', false);

// Global layer: an MCP server's tools, a deployment-level bundle, and the
// harness's reserved run_code transport (registered by ToolRuntime itself,
// outside the filterable layers).
await registerIn(root, ['mcp__fake__ping', 'mcp_probe', 'load_workspace_dependencies']);

// The codemode preset: one scope, with this package mounted as one of its rows.
const presetKey = {};
const preset = createScope(root, presetKey);
await preset.ctx.extend({ baseUrl: 'file:///preset-row/' })
  .plugin({ name: 'dsh-codemode', inject: ['tools', 'systemPrompt'], apply: (await import(pathToFileURL(PLUGIN).href)).apply }, {});

// Agent layer: what the Team and schedule bundles register through `agent.ctx`.
const agentKey = {};
const agent = createScope(root, agentKey);
bindScopeParent(agentKey, presetKey);
await registerIn(agent.ctx, ['spawn_teammate', 'schedule_create']);

// Standard rows of the preset, registered like any other row.
await registerIn(preset.ctx, ['read', 'pwsh', 'todo_write']);

// A schema contributed by a prompt provider rather than the registry: no layer
// attributes it, so the scope rule must leave it in the request.
systemPrompt.tools(() => ({
  schemas: [{
    name: 'provider_tool',
    description: 'contributed by another provider',
    parameters: { type: 'object', additionalProperties: true },
  }],
}));

const assembly = await systemPrompt.assemble({ scope: agentKey, agent: { id: 'verify-agent' } });
const section = assembly.sections.find((entry) => entry.name === 'tools:sdk')?.text ?? '';

check(
  'the request carries only the preset composition, the reserved run_code transport, and unattributable schemas',
  assembly.tools.map((entry) => entry.name).sort(),
  ['provider_tool', 'pwsh', 'read', 'run_code', 'todo_write'],
);
check(
  'no tool of this package shadows the reserved run_code name',
  assembly.tools.some((entry) => entry.name === 'code_run'),
  false,
);
check('the MCP server is reported as its own namespace', section.includes('`fake` (MCP server) — 1 tool(s)'), true);
check('out-of-preset plugins are reported as the plugin bucket', section.includes('`plugin` (contributed by plugins outside this preset) — 4 tool(s)'), true);

const call = (name, extra = {}) => tools.execute({
  name,
  callId: `verify-${name}`,
  arguments: {},
  agent: agentKey,
  signal: new AbortController().signal,
  ...extra,
});
const maskedGlobal = await call('mcp_probe');
const maskedAgent = await call('spawn_teammate');
const owned = await call('pwsh');
check('a model-direct call to a global-layer tool is denied', maskedGlobal.isError, true);
check('a model-direct call to an agent-layer tool is denied', maskedAgent.isError, true);
check('a model-direct call to a preset-owned tool runs', owned.isError, false);

const listing = (await call('code_tools_list', { parent: { token: 'run_code' } })).value;
check('the listing agrees with the request masking', [
  listing.tools.find((row) => row.name === 'spawn_teammate')?.hidden,
  listing.tools.find((row) => row.name === 'pwsh')?.hidden,
  listing.tools.some((row) => row.name === 'run_code'),
  listing.namespaces,
], [true, false, false, [{ namespace: 'fake', count: 1, kind: 'mcp' }, { namespace: 'plugin', count: 4, kind: 'plugin' }]]);

if (failures.length > 0) {
  console.error(`\nverify-assembly: ${failures.length} check(s) failed\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nverify-assembly: all checks passed');
