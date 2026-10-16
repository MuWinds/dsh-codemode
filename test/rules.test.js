import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodemodeSectionText,
  filterAssemblyTools,
  isAlwaysNativeName,
  isForeignName,
  isHiddenName,
  isMaskedName,
  isMcpToolName,
  namespaceOf,
  normalizeConfig,
  rankTools,
  summarizeHidden,
  tokenize,
  truncate,
} from '../lib/rules.js';

const options = normalizeConfig();

/** A scope view as `lib/scope.js` resolves one: global, preset, and agent names. */
function view({ global = [], preset = [], agent } = {}) {
  const globalNames = new Set(global);
  const presetNames = new Set(preset);
  return {
    enabled: true,
    globalNames,
    presetNames,
    agentNames: new Set(agent ?? [...globalNames, ...presetNames]),
  };
}

test('normalizeConfig applies defaults and honors overrides', () => {
  assert.deepEqual(options.hiddenPrefixes, ['mcp__']);
  assert.deepEqual(options.metaTools, ['code_tools_list', 'code_tools_search', 'code_tools_describe', 'code_debug']);
  assert.equal(options.guard, true);
  assert.equal(options.sdkSection, true);
  assert.equal(options.searchLimit, 8);
  assert.equal(options.nativeScope, true);
  assert.deepEqual(options.nativeTools, []);
  assert.deepEqual(options.hiddenTools, []);

  const custom = normalizeConfig({ hiddenPrefixes: ['mcp__', 'browser_'], searchLimit: 3, guard: false, debug: false });
  assert.deepEqual(custom.hiddenPrefixes, ['mcp__', 'browser_']);
  assert.equal(custom.searchLimit, 3);
  assert.equal(custom.guard, false);
  assert.equal(custom.debug, false);

  const scoped = normalizeConfig({
    nativeScope: false,
    nativeTools: [' load_workspace_dependencies ', 'read', 'read'],
    hiddenTools: ['spawn_teammate'],
  });
  assert.equal(scoped.nativeScope, false);
  assert.deepEqual(scoped.nativeTools, ['load_workspace_dependencies', 'read']);
  assert.deepEqual(scoped.hiddenTools, ['spawn_teammate']);
  assert.deepEqual(normalizeConfig({ nativeTools: 'read' }).nativeTools, []);
});

test('isHiddenName hides MCP names and the discovery tools, never native ones', () => {
  assert.equal(isHiddenName('mcp__okx__market_get_ticker', options), true);
  assert.equal(isHiddenName('code_tools_search', options), true);
  assert.equal(isHiddenName('pwsh', options), false);
  assert.equal(isHiddenName('run_code', options), false);
  assert.equal(isHiddenName(undefined, options), false);
});

test('the name-only rules honor hiddenTools, nativeTools and the reserved transport', () => {
  const configured = normalizeConfig({ nativeTools: ['mcp__okx__market_get_ticker', 'run_code'], hiddenTools: ['mcp__okx__place_order'] });
  // An explicit nativeTools entry outranks the prefix rule …
  assert.equal(isHiddenName('mcp__okx__market_get_ticker', configured), false);
  // … but not an explicit hiddenTools entry, and never the discovery tools.
  assert.equal(isHiddenName('mcp__okx__place_order', configured), true);
  assert.equal(isHiddenName('code_tools_list', normalizeConfig({ nativeTools: ['code_tools_list'] })), true);
  // Both transports stay callable whatever the config says.
  assert.equal(isAlwaysNativeName('run_code', configured), true);
  assert.equal(isAlwaysNativeName('code_run', normalizeConfig({ runToolName: 'code_run' })), true);
});

test('isForeignName hides everything the preset scope does not own', () => {
  const scope = view({
    // Global layer: MCP servers and deployment-level plugin bundles.
    global: ['mcp__fake__ping', 'mcp_probe'],
    // Preset layer: this preset's own rows.
    preset: ['pwsh', 'code_run', 'mcp__fake__ping'],
    // Everything the calling session can actually reach.
    agent: ['pwsh', 'code_run', 'mcp__fake__ping', 'mcp_probe', 'spawn_teammate', 'schedule_create'],
  });

  // Preset-owned: resolved inside the preset scope and not in the global layer.
  assert.equal(isForeignName('pwsh', options, scope), false);
  assert.equal(isForeignName('code_run', options, scope), false);
  // Global layer: MCP tools and deployment-level plugin bundles.
  assert.equal(isForeignName('mcp__fake__ping', options, scope), true);
  assert.equal(isForeignName('mcp_probe', options, scope), true);
  // Agent layer: registered through `agent.ctx`, so the preset scope never sees it.
  assert.equal(isForeignName('spawn_teammate', options, scope), true);
  assert.equal(isForeignName('schedule_create', options, scope), true);
  // Attributed to nobody (another prompt provider, a fixture): left alone.
  assert.equal(isForeignName('provider_tool', options, scope), false);
  assert.equal(isForeignName('provider_tool', options, view({})), false);
  // Attributed to the agent view alone, though: a per-agent tool set.
  assert.equal(isForeignName('provider_tool', options, view({ agent: ['provider_tool'] })), true);

  // Inert configurations: no view, or the rule switched off.
  assert.equal(isForeignName('spawn_teammate', options, undefined), false);
  assert.equal(isForeignName('spawn_teammate', options, { enabled: false }), false);
  assert.equal(isForeignName('spawn_teammate', normalizeConfig({ nativeScope: false }), scope), false);
  // Explicit exemptions apply here too.
  assert.equal(isForeignName('spawn_teammate', normalizeConfig({ nativeTools: ['spawn_teammate'] }), scope), false);
  assert.equal(isForeignName('run_code', options, view({ global: ['run_code'] })), false);
  assert.equal(isForeignName(undefined, options, scope), false);
});

test('isMaskedName is the union of both rule sets', () => {
  const scope = view({ global: ['spawn_teammate'], preset: ['pwsh'] });
  assert.equal(isMaskedName('pwsh', options, scope), false);
  assert.equal(isMaskedName('spawn_teammate', options, scope), true);
  assert.equal(isMaskedName('mcp__fake__ping', options, scope), true);
  assert.equal(isMaskedName('code_tools_describe', options, scope), true);
});

test('filterAssemblyTools keeps run_code and every native tool', () => {
  const tools = [
    { name: 'pwsh' },
    { name: 'run_code' },
    { name: 'mcp__okx__market_get_ticker' },
    { name: 'code_tools_list' },
    { name: 'code_tools_search' },
    { name: 'code_tools_describe' },
  ];
  assert.deepEqual(filterAssemblyTools(tools, options).map((tool) => tool.name), ['pwsh', 'run_code']);

  const scope = view({ global: ['spawn_teammate'], preset: ['pwsh', 'run_code', 'mcp__okx__market_get_ticker'] });
  const scopedTools = [...tools, { name: 'spawn_teammate' }];
  assert.deepEqual(filterAssemblyTools(scopedTools, options, scope).map((tool) => tool.name), ['pwsh', 'run_code']);
});

test('summarizeHidden counts MCP namespaces and ignores the discovery tools', () => {
  const summary = summarizeHidden([
    'pwsh',
    'mcp__okx__market_get_ticker',
    'mcp__okx__place_order',
    'mcp__chrome-devtools__click',
    'code_tools_list',
  ], options);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.namespaces, [
    { namespace: 'chrome-devtools', count: 1, kind: 'mcp' },
    { namespace: 'okx', count: 2, kind: 'mcp' },
  ]);
});

test('summarizeHidden buckets scope-masked plugin tools under `plugin`', () => {
  const scope = view({
    global: ['mcp_probe', 'mcp__fake__ping'],
    preset: ['pwsh', 'mcp__fake__ping'],
    agent: ['pwsh', 'mcp__fake__ping', 'mcp_probe', 'spawn_teammate', 'schedule_create'],
  });
  const summary = summarizeHidden(
    ['pwsh', 'spawn_teammate', 'schedule_create', 'mcp_probe', 'mcp__fake__ping'],
    options,
    scope,
  );
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.namespaces, [
    { namespace: 'fake', count: 1, kind: 'mcp' },
    { namespace: 'plugin', count: 3, kind: 'plugin' },
  ]);
});

test('namespaceOf reads the server out of an MCP tool name', () => {
  assert.equal(namespaceOf('mcp__okx__market_get_ticker'), 'okx');
  assert.equal(namespaceOf('mcp__chrome-devtools__click'), 'chrome-devtools');
  assert.equal(namespaceOf('mcp__weird__name__tool'), 'weird');
  assert.equal(namespaceOf('pwsh'), 'plugin');
});

test('isMcpToolName recognizes only MCP names', () => {
  assert.equal(isMcpToolName('mcp__okx__market_get_ticker'), true);
  assert.equal(isMcpToolName('mcp__okx'), false);
  assert.equal(isMcpToolName('pwsh'), false);
  assert.equal(isMcpToolName(undefined), false);
});

test('truncate collapses whitespace and ellipsizes over the cap', () => {
  assert.equal(truncate('  a\n\n  b  ', 40), 'a b');
  assert.equal(truncate('abcdef', 4), 'abc…');
});

test('tokenize splits identifiers on underscores, and CJK runs into bigrams', () => {
  assert.deepEqual(tokenize('Get Ticker'), ['get', 'ticker']);
  assert.deepEqual(tokenize('mcp__okx__market_get_ticker'), ['mcp', 'okx', 'market', 'get', 'ticker']);
  assert.deepEqual(tokenize('行情查询'), ['行情', '情查', '查询']);
});

test('rankTools ranks a name hit above a description hit, and filters namespaces', () => {
  const entries = [
    { name: 'mcp__okx__market_get_ticker', description: 'Latest price for an instrument' },
    { name: 'mcp__okx__account_balance', description: 'Read the latest ticker 行情快照 for the account' },
    { name: 'mcp__chrome-devtools__click', description: 'unrelated helper' },
  ];
  const hits = rankTools('ticker', entries, 5);
  assert.deepEqual(hits.map((row) => row.name), [
    'mcp__okx__market_get_ticker',
    'mcp__okx__account_balance',
  ]);

  const scoped = rankTools('ticker', entries, 5, 'okx');
  assert.equal(scoped.length, 2);
  assert.deepEqual(rankTools('ticker', entries, 5, 'chrome-devtools'), []);

  const chinese = rankTools('行情', entries, 5);
  assert.equal(chinese[0].name, 'mcp__okx__account_balance');

  const empty = rankTools('', entries, 2);
  assert.equal(empty.length, 2);
  assert.equal(rankTools('no-such-term', entries, 5).length, 0);
});

test('buildCodemodeSectionText documents discovery without leaking hidden schemas', () => {
  const hidden = summarizeHidden(['mcp__okx__market_get_ticker', 'mcp__okx__place_order'], options);
  const text = buildCodemodeSectionText({ hidden, metaTools: options.metaTools, searchLimit: options.searchLimit });

  assert.match(text, /## Code Mode/);
  assert.match(text, /tools\.code_tools_search\(\{ query/);
  assert.match(text, /tools\.code_tools_list/);
  assert.match(text, /tools\.code_tools_describe/);
  assert.match(text, /`okx` \(MCP server\) — 2 tool\(s\)/);
  assert.match(text, /tools\.mcp__okx__<tool>/);
  // Namespace hint only: no exact hidden tool name and no JSON schema.
  assert.doesNotMatch(text, /market_get_ticker/);
  assert.doesNotMatch(text, /"parameters"/);
  assert.doesNotMatch(text, /\{\{/);
});

test('buildCodemodeSectionText names the plugin bucket by exact name', () => {
  const view = { enabled: true, globalNames: new Set(['spawn_teammate']), presetNames: new Set(['pwsh']) };
  const hidden = summarizeHidden(['pwsh', 'spawn_teammate'], options, view);
  const text = buildCodemodeSectionText({ hidden, metaTools: options.metaTools });

  assert.match(text, /`plugin` \(contributed by plugins outside this preset\) — 1 tool\(s\)/);
  assert.match(text, /callable by exact name as `tools\.<name>\(\{\.\.\.\}\)`/);
  assert.doesNotMatch(text, /spawn_teammate/);
});

test('buildCodemodeSectionText degrades cleanly with nothing hidden', () => {
  const text = buildCodemodeSectionText({ hidden: { total: 0, namespaces: [] } });
  assert.match(text, /No masked tools are connected right now/);
});
