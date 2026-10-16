import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../lib/rules.js';
import { disabledView, findScopeKey, isForeignAtCall, resolveScopeView } from '../lib/scope.js';

const options = normalizeConfig();

/** The tag `@deepseek-ai/dsh-scope` writes onto a scoped context. */
const SCOPE_TAG = Symbol('dsh.scope');

test('findScopeKey reads the tag off this context or an ancestor', () => {
  const key = {};
  assert.equal(findScopeKey({ [SCOPE_TAG]: key }), key);

  const parent = { [SCOPE_TAG]: key };
  const child = Object.create(parent);
  child.own = true;
  assert.equal(findScopeKey(child), key);

  // A nearer tag wins, which is how a nested scope shadows its ancestor.
  const nearer = {};
  assert.equal(findScopeKey(Object.assign(Object.create(parent), { [SCOPE_TAG]: nearer })), nearer);

  assert.equal(findScopeKey({}), undefined);
  assert.equal(findScopeKey({ [Symbol('dsh.something-else')]: key }), undefined);
  assert.equal(findScopeKey(undefined), undefined);
});

test('findScopeKey survives a context whose symbols cannot be inspected', () => {
  const hostile = new Proxy({}, { ownKeys: () => { throw new Error('nope'); } });
  assert.equal(findScopeKey(hostile), undefined);
});

test('resolveScopeView reports the global, preset and agent names it can resolve', () => {
  const scopeKey = {};
  const agentKey = {};
  const registry = new Map([
    ['pwsh', { global: false, preset: true }],
    ['code_run', { global: false, preset: true }],
    ['run_code', { global: true, preset: true }],
    ['spawn_teammate', { global: false, preset: false, agent: true }],
    ['mcp__fake__ping', { global: true, preset: true }],
  ]);
  const ctx = {
    tools: {
      get: (name, scope) => {
        const entry = registry.get(name);
        if (entry === undefined) return undefined;
        if (scope === agentKey) return entry.global || entry.preset || entry.agent ? entry : undefined;
        if (scope === scopeKey) return entry.global || entry.preset ? entry : undefined;
        if (scope === undefined) return entry.global ? entry : undefined;
        return undefined;
      },
    },
  };

  const view = resolveScopeView(ctx, scopeKey, [...registry.keys(), 'unknown'], agentKey);
  assert.equal(view.enabled, true);
  assert.deepEqual([...view.globalNames].sort(), ['mcp__fake__ping', 'run_code']);
  assert.deepEqual([...view.presetNames].sort(), ['code_run', 'mcp__fake__ping', 'pwsh', 'run_code']);
  // A per-agent tool set is reachable for the session but owned by no layer above it.
  assert.deepEqual([...view.agentNames].sort(), ['code_run', 'mcp__fake__ping', 'pwsh', 'run_code', 'spawn_teammate']);

  // Without a calling scope, nothing is attributed beyond the two resolved views.
  const blind = resolveScopeView(ctx, scopeKey, [...registry.keys()]);
  assert.deepEqual([...blind.agentNames].sort(), [...blind.globalNames, ...blind.presetNames].filter((name, index, all) => all.indexOf(name) === index).sort());
  assert.equal(blind.agentNames.has('spawn_teammate'), false);

  // No scope key, no `get`, or a throwing registry: the view stays inert, so
  // no rule can hide the wrong half of a catalog.
  assert.equal(resolveScopeView(ctx, undefined, ['pwsh']).enabled, false);
  assert.equal(resolveScopeView({ tools: {} }, scopeKey, ['pwsh']).enabled, false);
  const throwing = { tools: { get: () => { throw new Error('registry down'); } } };
  assert.equal(resolveScopeView(throwing, scopeKey, ['pwsh']).enabled, false);
  assert.deepEqual(disabledView().globalNames.size, 0);
});

test('isForeignAtCall answers the guard with the same attribution', () => {
  const scopeKey = {};
  const agentKey = {};
  const ctx = {
    tools: {
      get: (name, scope) => {
        const global = ['run_code', 'mcp__fake__ping', 'mcp_probe'];
        const preset = ['pwsh', 'code_run'];
        const agent = ['spawn_teammate'];
        if (scope === undefined) return global.includes(name) ? { name } : undefined;
        if (scope === scopeKey) return global.includes(name) || preset.includes(name) ? { name } : undefined;
        if (scope === agentKey) {
          return global.includes(name) || preset.includes(name) || agent.includes(name) ? { name } : undefined;
        }
        return undefined;
      },
    },
  };

  assert.equal(isForeignAtCall(ctx, scopeKey, 'pwsh', options, agentKey), false);
  assert.equal(isForeignAtCall(ctx, scopeKey, 'mcp__fake__ping', options, agentKey), true);
  assert.equal(isForeignAtCall(ctx, scopeKey, 'mcp_probe', options, agentKey), true);
  assert.equal(isForeignAtCall(ctx, scopeKey, 'spawn_teammate', options, agentKey), true);
  // A name no view resolves is not ours to judge: the registry answers it.
  assert.equal(isForeignAtCall(ctx, scopeKey, 'unknown_tool', options, agentKey), false);
  // Exemptions and inert configurations.
  assert.equal(isForeignAtCall(ctx, scopeKey, 'run_code', options, agentKey), false);
  assert.equal(isForeignAtCall(ctx, scopeKey, 'mcp_probe', normalizeConfig({ nativeTools: ['mcp_probe'] }), agentKey), false);
  assert.equal(isForeignAtCall(ctx, scopeKey, 'code_tools_list', options, agentKey), false);
  assert.equal(isForeignAtCall(ctx, scopeKey, 'mcp_probe', normalizeConfig({ nativeScope: false }), agentKey), false);
  assert.equal(isForeignAtCall(ctx, undefined, 'mcp_probe', options, agentKey), false);
  assert.equal(isForeignAtCall(ctx, scopeKey, undefined, options, agentKey), false);
  const throwing = { tools: { get: () => { throw new Error('registry down'); } } };
  assert.equal(isForeignAtCall(throwing, scopeKey, 'mcp_probe', options, agentKey), false);
});
