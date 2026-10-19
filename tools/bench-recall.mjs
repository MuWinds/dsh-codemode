/**
 * Recall benchmark: lexical-only vs hybrid (lexical + embeddings).
 * Query set reproduces the documented upstream failure: brand-named tools
 * whose descriptions share no tokens with natural task phrasing (EN + ZH).
 * Usage: node tools/bench-recall.mjs [--baseUrl URL] [--model NAME]
 */
import { rankTools } from '../lib/rules.js';
import { createEmbedder } from '../lib/embeddings.js';

const CATALOG = [
  { name: 'mcp__markitdown__convert', description: 'Convert files to markdown using markitdown' },
  { name: 'mcp__markitdown__batch', description: 'Batch convert a directory with markitdown' },
  { name: 'mcp__agent_search__query', description: 'Run a web search and return result snippets' },
  { name: 'mcp__firecrawl__scrape', description: 'Fetch and clean a web page' },
  { name: 'mcp__okx__market_get_ticker', description: 'Get latest price for an instrument' },
  { name: 'mcp__pdf__merge', description: 'Merge multiple pdf files into one' },
  { name: 'mcp__ffmpeg__transcode', description: 'Transcode media with ffmpeg' },
  { name: 'mcp__notion__search', description: 'Search pages in your Notion workspace' },
  { name: 'mcp__git__commit', description: 'Create a git commit with staged changes' },
  { name: 'mcp__screenshot__snap', description: 'Capture a screenshot of a region' },
  { name: 'mcp__deepl__translate', description: 'Translate text between languages' },
  { name: 'mcp__tts__speak', description: 'Synthesize speech from text' },
];

const CASES = [
  ['word 转 pdf 怎么弄', 'mcp__markitdown__convert'],
  ['把 docx 文档转成 markdown', 'mcp__markitdown__convert'],
  ['批量转换整个文件夹的文档', 'mcp__markitdown__batch'],
  ['联网搜索抓取网页内容', 'mcp__agent_search__query'],
  ['帮我查一下最新的 BTC 价格', 'mcp__okx__market_get_ticker'],
  ['合并几个 pdf 文件', 'mcp__pdf__merge'],
  ['把视频转成 mp4', 'mcp__ffmpeg__transcode'],
  ['在我的笔记里找相关内容', 'mcp__notion__search'],
  ['提交代码', 'mcp__git__commit'],
  ['截个图', 'mcp__screenshot__snap'],
  ['把这句话翻译成英文', 'mcp__deepl__translate'],
  ['把这段文字读出来变成语音', 'mcp__tts__speak'],
];

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const embedder = createEmbedder({
  enabled: true,
  baseUrl: arg('--baseUrl', 'http://127.0.0.1:11434'),
  model: arg('--model', 'bge-m3'),
  timeoutMs: 30000,
});
const rowText = (entry) => entry.name + ' ' + entry.description;
const texts = CASES.map((row) => row[0]).concat(CATALOG.map(rowText));
const getter = await embedder.ensure(texts);
const stats = embedder.stats();
console.log('embeddings: ' + stats.cached + '/' + texts.length + ' cached, cooldown=' + stats.onCooldown);
if (stats.cached < texts.length) {
  console.error('provider unreachable or incomplete - aborting');
  process.exit(1);
}
let lex = 0;
let hyb = 0;
let rescued = 0;
let broken = 0;
for (const item of CASES) {
  const query = item[0];
  const expected = item[1];
  const lexical = rankTools(query, CATALOG, 8);
  const semantic = {
    weight: 1,
    rescueFloor: 0.35,
    cosine: embedder.cosine,
    getQueryVector: () => getter(query),
    getVector: (entry) => getter(rowText(entry)),
  };
  const hybrid = rankTools(query, CATALOG, 8, undefined, semantic);
  const l = lexical.length > 0 && lexical[0].name === expected;
  const h = hybrid.length > 0 && hybrid[0].name === expected;
  if (l) lex += 1;
  if (h) hyb += 1;
  if (!l && h) rescued += 1;
  if (l && !h) broken += 1;
  const tag = l === h ? '' : (l ? '  (REGRESSION)' : '  (RESCUED)');
  console.log((h ? 'OK  ' : 'MISS') + ' lex=' + (l ? 'top1' : 'miss') + ' hyb=' + (h ? 'top1' : 'miss') + '  "' + query + '" -> ' + expected + tag);
}
console.log('');
console.log('top-1 recall: lexical ' + lex + '/' + CASES.length + '   hybrid ' + hyb + '/' + CASES.length + '   rescued=' + rescued + ' regressions=' + broken);
