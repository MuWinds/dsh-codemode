/**
 * END-TO-END: mount the ported plugin on the REAL DSH 0.2.2-alpha.3 kernel and
 * check every promise it makes.
 */
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { createScope, bindScopeParent } from '@deepseek-ai/dsh-scope';
import { apply as codemodeApply } from '../lib/index.js';

const out = (...a) => console.log(...a);
const results = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ ok, label, actual, expected });
  out(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
};

function tool(name) {
  return defineTool({
    name, description: `fixture ${name}`,
    parameters: { query: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args) { return { ok: name, echo: args }; },
  });
}
function registerIn(ctx, names) {
  return new Promise((done, fail) => {
    ctx.inject(['tools'], (inj) => {
      try { for (const n of names) inj.tools.register(tool(n)); done(); } catch (e) { fail(e); }
    });
  });
}

// ── a deployment-shaped composition ──
const root = new Context();
root.provide('workingDirectory', { ensure: async () => process.cwd() });
root.provide('ptcRuntime', {
  programFormat: 'function-body',
  timeout: { defaultMs: 60000, maxMs: 120000 },
  resolve: (request) => request,
  async run(spec) {
    // Drive the program's bindings the way a real runtime would.
    const binding = spec.bindings?.[0];
    const fns = binding?.functions ?? {};
    if (typeof fns.mcp_probe === 'function') await fns.mcp_probe({ query: 'hi' });
    return { logs: [], value: 'program-result' };
  },
});
await root.plugin(SystemPrompt, {});
await root.plugin(ToolRuntime, {});
await root.plugin(NativeExecutor, {});

// global layer: an MCP server + a profile-level plugin bundle
await registerIn(root, ['mcp__fake__ping', 'mcp_probe', 'load_workspace_dependencies']);

// the codemode preset
const presetKey = {};
const preset = createScope(root, presetKey);
await preset.ctx.plugin(
  { name: 'dsh-codemode', inject: ['tools', 'systemPrompt'], apply: codemodeApply },
  {},
);
await registerIn(preset.ctx, ['read', 'pwsh', 'todo_write']);

// agent layer: the Team / schedule tool sets
const agentKey = {};
const agent = createScope(root, agentKey);
bindScopeParent(agentKey, presetKey);
await registerIn(agent.ctx, ['spawn_teammate', 'schedule_create']);

// ── 1. the request surface ──
const asm = await root.get('systemPrompt', false).assemble({ scope: agentKey, agent: { id: 'e2e' } });
const names = asm.tools.map((t) => t.name).sort();
out('\ncatalog:', names.join(', '), '\n');
check('masking: MCP tools are absent', names.filter((n) => n.startsWith('mcp__')), []);
check('masking: the profile bundle tool is absent', names.includes('mcp_probe'), false);
check('masking: the agent-layer tools are absent', [names.includes('spawn_teammate'), names.includes('schedule_create')], [false, false]);
check('masking: the discovery tools are absent', names.filter((n) => n.startsWith('code_tools_') || n === 'code_debug'), []);
check('masking: the preset composition survives', names.filter((n) => ['read', 'pwsh', 'todo_write'].includes(n)), ['pwsh', 'read', 'todo_write']);
check('masking: the transport is present', names.includes('code_run'), true);

// ── 2. the Code Mode section ──
const sdk = asm.sections.find((s) => s.name === 'tools:sdk');
check('section: tools:sdk is supplied by the executor', sdk !== undefined, true);
check('section: carries the Code Mode instructions', /## Code Mode/.test(sdk?.text ?? ''), true);
check('section: names the transport', (sdk?.text ?? '').includes('code_run'), true);
check('section: reports the masked count', /5 tool\(s\) are outside this preset/.test(sdk?.text ?? ''), true);
check('section: leaks no hidden tool name', (sdk?.text ?? '').includes('mcp__fake__ping'), false);

// ── 3. model-direct denial ──
const batch = (calls) => new Promise((done) => preset.ctx.inject(['tools'], (inj) => done(inj.tools.execute({
  calls, agent: agentKey, signal: new AbortController().signal,
}))));
const denied = await batch([{ id: 'm1', name: 'mcp_probe', arguments: '{}' }]);
check('guard: a model-direct call to a masked tool is denied', denied.results[0].result.isError, true);
check('guard: the denial points at the search tool', /code_tools_search|code_run/.test(denied.results[0].result.error.message), true);

const agentDenied = await batch([{ id: 'm2', name: 'spawn_teammate', arguments: '{}' }]);
check('guard: an agent-layer tool is denied too', agentDenied.results[0].result.isError, true);

const allowed = await batch([{ id: 'm3', name: 'pwsh', arguments: '{}' }]);
check('guard: a preset-owned tool still runs', allowed.results[0].result.isError, false);

// ── 4. code_run end to end: the program's sub-call reaches a masked tool ──
// The preset-scope view is where the transport was registered; the global view
// deliberately cannot see it, which is the whole point of preset scoping.
const transport = await new Promise((done) => preset.ctx.inject(['tools'], (inj) => done(inj.tools.get('code_run', presetKey))));
check('transport: registered in the preset scope', transport !== undefined, true);
check('transport: invisible from the global view', await new Promise((done) => preset.ctx.inject(['tools'], (inj) => done(inj.tools.get('code_run')))) === undefined, true);
const ran = await batch([{
  id: 'r1', name: 'code_run',
  arguments: JSON.stringify({ code: 'return await tools.mcp_probe({query:"hi"})', description: 'probe' }),
}]);
check('code_run: a program can call a masked tool', ran.results[0].result.isError, false);
check('code_run: the program result comes back', ran.results[0].result.value?.result, 'program-result');

// ── 5. discovery tools work from inside a program ──
const discovered = await batch([{
  id: 'r2', name: 'code_run',
  arguments: JSON.stringify({ code: 'return await tools.code_tools_search({query:"mcp"})', description: 'discover' }),
}]);
check('discovery: reachable from inside a program', discovered.results[0].result.isError, false);

const failed = results.filter((r) => !r.ok);
out(`\n${results.length - failed.length} PASS / ${failed.length} FAIL / ${results.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);

