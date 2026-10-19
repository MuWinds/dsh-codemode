import { rankTools } from '../lib/rules.js';
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
let hits = 0;
for (const item of CASES) {
  const ranked = rankTools(item[0], CATALOG, 8);
  const top = ranked.length > 0 ? ranked[0].name : '(none)';
  const ok = top === item[1];
  if (ok) hits += 1;
  console.log((ok ? 'OK  ' : 'MISS') + ' "' + item[0] + '" -> ' + top);
}
console.log('lexical-only top-1: ' + hits + '/' + CASES.length);
