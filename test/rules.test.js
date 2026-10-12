import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodemodeSectionText,
  filterAssemblyTools,
  isHiddenName,
  namespaceOf,
  normalizeConfig,
  rankTools,
  summarizeHidden,
  tokenize,
  truncate,
} from '../lib/rules.js';

const options = normalizeConfig();

test('normalizeConfig applies defaults and honors overrides', () => {
  assert.deepEqual(options.hiddenPrefixes, ['mcp__']);
  assert.deepEqual(options.metaTools, ['code_tools_list', 'code_tools_search', 'code_tools_describe', 'code_debug']);
  assert.equal(options.guard, true);
  assert.equal(options.sdkSection, true);
  assert.equal(options.searchLimit, 8);

  const custom = normalizeConfig({ hiddenPrefixes: ['mcp__', 'browser_'], searchLimit: 3, guard: false, debug: false });
  assert.deepEqual(custom.hiddenPrefixes, ['mcp__', 'browser_']);
  assert.equal(custom.searchLimit, 3);
  assert.equal(custom.guard, false);
  assert.equal(custom.debug, false);
});

test('isHiddenName hides MCP names and the discovery tools, never native ones', () => {
  assert.equal(isHiddenName('mcp__okx__market_get_ticker', options), true);
  assert.equal(isHiddenName('code_tools_search', options), true);
  assert.equal(isHiddenName('pwsh', options), false);
  assert.equal(isHiddenName('run_code', options), false);
  assert.equal(isHiddenName(undefined, options), false);
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
    { namespace: 'chrome-devtools', count: 1 },
    { namespace: 'okx', count: 2 },
  ]);
});

test('namespaceOf reads the server out of an MCP tool name', () => {
  assert.equal(namespaceOf('mcp__okx__market_get_ticker'), 'okx');
  assert.equal(namespaceOf('mcp__chrome-devtools__click'), 'chrome-devtools');
  assert.equal(namespaceOf('mcp__weird__name__tool'), 'weird');
  assert.equal(namespaceOf('pwsh'), 'mcp');
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
  assert.match(text, /`okx` — 2 tool\(s\)/);
  assert.match(text, /tools\.mcp__okx__<tool>/);
  // Namespace hint only: no exact hidden tool name and no JSON schema.
  assert.doesNotMatch(text, /market_get_ticker/);
  assert.doesNotMatch(text, /"parameters"/);
  assert.doesNotMatch(text, /\{\{/);
});

test('buildCodemodeSectionText degrades cleanly with nothing hidden', () => {
  const text = buildCodemodeSectionText({ hidden: { total: 0, namespaces: [] } });
  assert.match(text, /No hidden tools are connected right now/);
});
