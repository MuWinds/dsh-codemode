/**
 * Tests for the hybrid (lexical + semantic) ranking layer.
 * Everything runs against a fake embedder: no network, deterministic vectors.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig, rankTools } from '../lib/rules.js';
import { createEmbedder, normalizeEmbedConfig } from '../lib/embeddings.js';

/** Toy 2-d space: docx/pdf cluster vs search cluster vs unrelated. */
const SPACE = {
  'word to pdf conversion': [0.98, 0.02],
  'convert docx to pdf': [0.97, 0.03],
  'web search fetch pages': [0.02, 0.98],
  'search the web': [0.03, 0.97],
  'btc ticker': [0.5, 0.5],
};

function fakeEmbedder() {
  return {
    options: { enabled: true },
    async ensure() {
      return (text) => {
        const vector = SPACE[String(text).toLowerCase()];
        return vector === undefined ? undefined : Float32Array.from(vector);
      };
    },
    cosine(a, b) {
      let dot = 0; let na = 0; let nb = 0;
      for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    },
  };
}

function semanticBundle(vectors, overrides = {}) {
  const embedder = fakeEmbedder();
  const queryVector = Float32Array.from(SPACE['word to pdf conversion']);
  return {
    weight: 1,
    rescueFloor: 0.35,
    cosine: embedder.cosine,
    getQueryVector: () => queryVector,
    getVector: (entry) => vectors[entry.name],
    ...overrides,
  };
}

describe('normalizeConfig semantic knobs', () => {
  it('defaults keep semantics deterministic', () => {
    const options = normalizeConfig({});
    assert.equal(options.semanticWeight, 1);
    assert.equal(options.semanticRescueFloor, 0.35);
  });
  it('clamps a nonsense rescue floor back to the default', () => {
    const options = normalizeConfig({ semanticRescueFloor: 9 });
    assert.equal(options.semanticRescueFloor, 0.35);
  });
  it('accepts an explicit weight', () => {
    assert.equal(normalizeConfig({ semanticWeight: 0.4 }).semanticWeight, 0.4);
  });
});

describe('rankTools hybrid fusion', () => {
  const rows = [
    { name: 'mcp__markitdown__convert', description: 'Convert documents using markitdown' },
    { name: 'mcp__agent_search__web', description: 'search the web' },
    { name: 'mcp__okx__ticker', description: 'btc ticker price' },
  ];
  const vectors = {
    'mcp__markitdown__convert': Float32Array.from(SPACE['convert docx to pdf']),
    'mcp__agent_search__web': Float32Array.from(SPACE['web search fetch pages']),
    'mcp__okx__ticker': Float32Array.from(SPACE['btc ticker']),
  };

  it('without a semantic bundle, the docx query finds nothing (the upstream failure)', () => {
    assert.equal(rankTools('word to pdf conversion', rows, 8).length, 0);
  });

  it('a purely lexical miss is rescued by the embedding match', () => {
    const ranked = rankTools('word to pdf conversion', rows, 8, undefined, semanticBundle(vectors));
    assert.equal(ranked[0].name, 'mcp__markitdown__convert');
  });

  it('a rescue never outranks a prefix name match', () => {
    const ranked = rankTools('mcp__okx', rows, 8, undefined, semanticBundle(vectors));
    assert.equal(ranked[0].name, 'mcp__okx__ticker');
  });

  it('a perfect exact name match still outranks everything semantic', () => {
    const ranked = rankTools('mcp__okx__ticker', rows, 8, undefined, semanticBundle(vectors));
    assert.equal(ranked[0].name, 'mcp__okx__ticker');
  });

  it('below the rescue floor, a weak similarity changes nothing', () => {
    // 'btc ticker' sits at 45 degrees: cos ~0.707 vs the query - above floor.
    // Use an orthogonal vector instead: cos 0 < floor, so only lexical survives.
    const cold = { ...vectors, 'mcp__okx__ticker': Float32Array.from([0, 1]) };
    const ranked = rankTools('word to pdf conversion', rows, 8, undefined, semanticBundle(cold));
    assert.ok(!ranked.some((row) => row.name === 'mcp__okx__ticker'));
  });

  it('namespace diversity surfaces a second server without dropping recall', () => {
    const many = [];
    for (let i = 0; i < 10; i += 1) many.push({ name: `mcp__big__tool_${i}`, description: 'shared description word' });
    many.push({ name: 'mcp__other__tool', description: 'shared description word' });
    const ranked = rankTools('shared description word', many, 8);
    // Without the cap, 'other' sorts last of 11 ties and never reaches top-8.
    const otherRank = ranked.findIndex((row) => row.name === 'mcp__other__tool');
    assert.ok(otherRank >= 0 && otherRank < 5, `other surfaced at ${otherRank}`);
    assert.equal(ranked.length, 8, 'diversity must not drop rows');
    assert.ok(ranked.filter((row) => row.name.startsWith('mcp__big__')).length < 8);
  });

  it('a single-namespace result is untouched by the cap', () => {
    const many = [];
    for (let i = 0; i < 10; i += 1) many.push({ name: `mcp__big__tool_${i}`, description: 'shared description word' });
    const ranked = rankTools('shared description word', many, 8);
    assert.equal(ranked.length, 8);
  });
});

describe('embeddings module', () => {
  it('disabled by default and never throws', async () => {
    const embedder = createEmbedder({});
    assert.equal(embedder.options.enabled, false);
    const get = await embedder.ensure(['anything']);
    assert.equal(get('anything'), undefined);
  });
  it('normalizes config with defaults', () => {
    const options = normalizeEmbedConfig({ enabled: true, baseUrl: 'http://x:1/' });
    assert.equal(options.enabled, true);
    assert.equal(options.baseUrl, 'http://x:1');
    assert.equal(options.model, 'bge-m3');
  });
  it('caches by content and degrades on provider failure', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, json: async () => ({ embeddings: [[1, 0]] }) };
    };
    const embedder = createEmbedder({ enabled: true }, { fetchImpl });
    const get = await embedder.ensure(['a text']);
    assert.ok(get('a text'));
    assert.equal(calls, 1);
    const again = await embedder.ensure(['a text']);
    assert.ok(again('a text'));
    assert.equal(calls, 1, 'cache must absorb the repeat');
    const failing = createEmbedder({ enabled: true }, { fetchImpl: async () => { throw new Error('down'); } });
    const degraded = await failing.ensure(['b']);
    assert.equal(degraded('b'), undefined);
    assert.equal(failing.stats().onCooldown, true);
  });
  it('falls back to the OpenAI-compat route when the native route 404s', async () => {
    const routes = [];
    const fetchImpl = async (url) => {
      routes.push(url);
      if (String(url).includes('/api/embed')) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => ({ data: [{ embedding: [0, 1] }] }) };
    };
    const embedder = createEmbedder({ enabled: true }, { fetchImpl });
    const get = await embedder.ensure(['c']);
    assert.ok(get('c'));
    assert.equal(routes.length, 2);
  });
});
