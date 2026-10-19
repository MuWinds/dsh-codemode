/**
 * Semantic embedding layer for the discovery search (hybrid ranking).
 *
 * Why this exists: the stock rankTools is a lexical BM25-lite. On corpora where
 * a tool's brand name shares no tokens with the task phrasing ("convert docx
 * to pdf" vs "markitdown"), lexical recall is zero and the model degrades into
 * repeated failed searches followed by a full catalog pull-in - exactly the
 * failure a reviewer documented for the upstream plugin. Embeddings close that
 * gap: the query and every tool row are mapped into one vector space, cosine
 * similarity catches what token overlap cannot.
 *
 * Design constraints inherited from the package philosophy:
 *  - zero runtime dependency on any @deepseek-ai/* package and on any npm
 *    package: plain fetch against an OpenAI-compatible /v1/embeddings endpoint
 *    (Ollama serves one natively on 11434; any other provider works too).
 *  - embedding failure must NEVER fail a search: every error path degrades to
 *    "no semantic score", which leaves ranking byte-identical to upstream.
 *  - the tool catalog drifts (MCP servers connect and disconnect), so vectors
 *    are cached by a content hash of name+description, never by name alone,
 *    and the cache is bounded by LRU.
 *  - a failing provider is put on cooldown so a broken endpoint costs one
 *    timed-out request per window, not one per search call.
 *
 * The embedder is injectable (constructor option) so unit tests can pass a
 * deterministic fake and never touch the network.
 * @module dsh-codemode/embeddings
 */

import { createHash } from 'node:crypto';

/** Default Ollama endpoint (the local model line's agreed embedding home). */
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

/** Ollama's native embeddings route; the OpenAI-compat route is tried as a fallback. */
const OLLAMA_ROUTE = '/api/embed';
const OPENAI_ROUTE = '/v1/embeddings';

/** Cap concurrent in-flight provider requests; a cold 200-tool catalog embeds in waves. */
const MAX_INFLIGHT = 4;

/** Cooldown after a provider failure, so searches do not pay the timeout each time. */
const DEFAULT_COOLDOWN_MS = 30_000;

/** Bound the LRU so a long-lived session cannot grow the cache without limit. */
const DEFAULT_MAX_VECTORS = 4096;

/** Ollama can take seconds to cold-load a model on the first request. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Normalize the `embed` config block. `enabled` defaults to false so an
 * upgrade of the package never silently starts making network calls.
 */
export function normalizeEmbedConfig(config = {}) {
  const embed = config && typeof config === 'object' ? config : {};
  const baseUrl = typeof embed.baseUrl === 'string' && embed.baseUrl.trim().length > 0
    ? embed.baseUrl.trim().replace(/\/+$/, '')
    : DEFAULT_BASE_URL;
  return {
    enabled: embed.enabled === true,
    baseUrl,
    model: typeof embed.model === 'string' && embed.model.trim().length > 0
      ? embed.model.trim()
      : 'bge-m3',
    timeoutMs: Number.isFinite(embed.timeoutMs) && embed.timeoutMs > 0
      ? Math.floor(embed.timeoutMs)
      : DEFAULT_TIMEOUT_MS,
    cooldownMs: Number.isFinite(embed.cooldownMs) && embed.cooldownMs >= 0
      ? Math.floor(embed.cooldownMs)
      : DEFAULT_COOLDOWN_MS,
    maxVectors: Number.isFinite(embed.maxVectors) && embed.maxVectors > 0
      ? Math.floor(embed.maxVectors)
      : DEFAULT_MAX_VECTORS,
  };
}

/** Stable content key: a vector is only valid for the exact text it embedded. */
function contentKey(model, text) {
  return createHash('sha256').update(`${model}\u0000${text}`).digest('hex');
}

/**
 * Create one embedder per plugin instance.
 *
 * @param config - the raw `embed` block from the plugin config (normalized here).
 * @param extras - test seams: `{ fetchImpl, now }`.
 * @returns an embedder object (see below). When disabled or degraded, every
 *   method resolves to a no-op so callers can treat semantics as absent.
 */
export function createEmbedder(config = {}, extras = {}) {
  const options = normalizeEmbedConfig(config);
  const fetchImpl = extras.fetchImpl ?? globalThis.fetch;
  const now = extras.now ?? (() => Date.now());

  /** LRU of sha256(model+text) -> Float32Array. Map preserves insertion order. */
  const vectors = new Map();
  let cooldownUntil = 0;
  let inflight = 0;
  const queue = [];

  function stats() {
    return {
      enabled: options.enabled,
      model: options.model,
      baseUrl: options.baseUrl,
      cached: vectors.size,
      onCooldown: now() < cooldownUntil,
    };
  }

  function remember(key, vector) {
    if (vectors.size >= options.maxVectors) vectors.delete(vectors.keys().next().value);
    vectors.set(key, vector);
  }

  /** One provider round-trip for a batch of texts, trying Ollama native then OpenAI-compat. */
  async function requestBatch(texts) {
    const body = { model: options.model, input: texts };
    const attempts = [
      { route: OLLAMA_ROUTE, body, pick: (json) => json?.embeddings },
      { route: OPENAI_ROUTE, body: { ...body, encoding_format: 'float' }, pick: (json) => json?.data?.map((row) => row.embedding) },
    ];
    let lastError;
    for (const attempt of attempts) {
      try {
        const signal = AbortSignal.timeout(options.timeoutMs);
        const response = await fetchImpl(`${options.baseUrl}${attempt.route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(attempt.body),
          signal,
        });
        if (!response.ok) throw new Error(`embed ${attempt.route}: HTTP ${response.status}`);
        const json = await response.json();
        const rows = attempt.pick(json);
        if (!Array.isArray(rows) || rows.length !== texts.length) {
          throw new Error(`embed ${attempt.route}: malformed response`);
        }
        return rows.map((row) => Float32Array.from(row));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('embed: no route available');
  }

  /** Queue-throttled batch runner: at most MAX_INFLIGHT provider calls at once. */
  async function runBatch(texts) {
    if (inflight >= MAX_INFLIGHT) {
      await new Promise((resolve) => queue.push(resolve));
    }
    inflight += 1;
    try {
      return await requestBatch(texts);
    } finally {
      inflight -= 1;
      const next = queue.shift();
      if (next !== undefined) next();
    }
  }

  /**
   * Ensure vectors exist for `texts` (embedding the missing ones in batches).
   * Returns a getter; never throws - on any provider failure it returns a
   * getter that yields undefined for uncached texts, i.e. pure lexical ranking.
   */
  async function ensure(texts) {
    if (!options.enabled || texts.length === 0 || now() < cooldownUntil) {
      return (text) => vectors.get(contentKey(options.model, text));
    }
    const missing = [];
    const seen = new Set();
    for (const text of texts) {
      const key = contentKey(options.model, text);
      if (vectors.has(key) || seen.has(text)) continue;
      seen.add(text);
      missing.push(text);
    }
    // Chunk so a 500-tool catalog does not become one 500-text request.
    const CHUNK = 32;
    for (let start = 0; start < missing.length; start += CHUNK) {
      const chunk = missing.slice(start, start + CHUNK);
      try {
        const rows = await runBatch(chunk);
        for (let index = 0; index < chunk.length; index += 1) {
          remember(contentKey(options.model, chunk[index]), rows[index]);
        }
      } catch {
        cooldownUntil = now() + options.cooldownMs;
        break; // keep whatever was cached so far; degrade, do not throw
      }
    }
    return (text) => vectors.get(contentKey(options.model, text));
  }

  /** Cosine similarity with zero-norm safety; returns 0 for missing vectors. */
  function cosine(a, b) {
    if (a === undefined || b === undefined || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < a.length; index += 1) {
      dot += a[index] * b[index];
      normA += a[index] * a[index];
      normB += b[index] * b[index];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / Math.sqrt(normA * normB);
  }

  return { options, ensure, cosine, stats };
}
