/**
 * Isolation: the ported plugin must mask ONLY the codemode preset, and must
 * leave a sibling preset in the same process completely untouched.
 */
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { createScope, bindScopeParent } from '@deepseek-ai/dsh-scope';
import { apply as codemodeApply } from '../lib/index.js';

const out = (...a) => console.log(...a);
const checks = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push(ok);
  out(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
};

function tool(name) {
  return defineTool({
    name, description: `fixture ${name}`,
    parameters: { query: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute() { return { ok: name }; },
  });
}
function registerIn(ctx, names) {
  return new Promise((done, fail) => {
    ctx.inject(['tools'], (inj) => {
      try { for (const n of names) inj.tools.register(tool(n)); done(); } catch (e) { fail(e); }
    });
  });
}

const root = new Context();
await root.plugin(SystemPrompt, {});
await root.plugin(ToolRuntime, {});
await root.plugin(NativeExecutor, {});
await registerIn(root, ['mcp__fake__ping', 'mcp_probe']);

// preset `standard`: exactly what upstream ships — no executor row of its own.
const stdKey = {};
const std = createScope(root, stdKey);
await registerIn(std.ctx, ['read', 'pwsh']);
const stdAgentKey = {};
createScope(root, stdAgentKey);
bindScopeParent(stdAgentKey, stdKey);
await registerIn(createScope(root, stdAgentKey).ctx, ['spawn_teammate']);

// preset `codemode`
const cmKey = {};
const cm = createScope(root, cmKey);
await cm.ctx.plugin({ name: 'dsh-codemode', inject: ['tools', 'systemPrompt'], apply: codemodeApply }, {});
await registerIn(cm.ctx, ['read', 'pwsh']);
const cmAgentKey = {};
createScope(root, cmAgentKey);
bindScopeParent(cmAgentKey, cmKey);
await registerIn(createScope(root, cmAgentKey).ctx, ['spawn_teammate']);

const systemPrompt = root.get('systemPrompt', false);
const stdAsm = await systemPrompt.assemble({ scope: stdAgentKey });
const cmAsm = await systemPrompt.assemble({ scope: cmAgentKey });

const stdNames = stdAsm.tools.map((t) => t.name).sort();
const cmNames = cmAsm.tools.map((t) => t.name).sort();
out('\nstandard preset catalog:', stdNames.join(', '));
out('codemode preset catalog:', cmNames.join(', '), '\n');

check('standard preset is untouched: MCP tools visible', stdNames.filter((n) => n.startsWith('mcp__')).length, 1);
check('standard preset is untouched: the bundle tool visible', stdNames.includes('mcp_probe'), true);
check('standard preset is untouched: the agent-layer tool visible', stdNames.includes('spawn_teammate'), true);
check('standard preset gets no Code Mode section', stdAsm.sections.some((s) => s.name === 'tools:sdk'), false);
check('codemode: masked', [cmNames.includes('mcp_probe'), cmNames.includes('mcp__fake__ping'), cmNames.includes('spawn_teammate')], [false, false, false]);
check('codemode: composition kept', cmNames.filter((n) => ['read', 'pwsh'].includes(n)), ['pwsh', 'read']);
check('codemode: transport present', cmNames.includes('code_run'), true);
check('codemode: Code Mode section present', cmAsm.sections.some((s) => s.name === 'tools:sdk'), true);

const failed = checks.filter((ok) => !ok).length;
out(`\n${checks.length - failed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);

