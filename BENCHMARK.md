# 检索召回评测（hybrid vs 纯词法）

复现并修复上游被指出的失败模式：品牌名工具 × 自然语言任务词，词法检索零召回。

## 环境
- 语料：`tools/bench-lexical-only.mjs` / `tools/bench-recall.mjs` 内 12 个遮蔽工具（markitdown/agent_search/okx/ffmpeg/notion 等品牌名 + 短描述，中英混合查询）
- embedding：bge-m3 Q8_0（本地 GGUF，Ollama 11434，1024 维）
- 融合参数：`semanticWeight=1`，`semanticRescueFloor=0.35`

## 结果（2026-10-19）

| 指标 | 纯词法（上游） | 混合（本 fork） |
|---|---|---|
| top-1 召回 | **2/12 (17%)** | **11/12 (92%)** |
| 语义救回 | – | 9 |
| 词法命中被语义拖垮 | – | **0** |

复现的上游失败（全部被救回）："批量转换整个文件夹的文档"、"联网搜索抓取网页内容"、"帮我查一下最新的 BTC 价格"、"把视频转成 mp4"、"在我的笔记里找相关内容"、"提交代码"、"截个图"、"把这句话翻译成英文"、"把这段文字读出来变成语音"。

唯一残留 MISS："word 转 pdf 怎么弄" → 期望 `markitdown__convert`。该条标注本身有问题：markitdown 输出 markdown 而非 pdf，目录里根本没有 docx→pdf 工具（评测语料缺陷，非检索缺陷）。

## 复现方法
```
# 一次性：装 embedding 模型（见 .models/ 的下载与 ollama create 流程）
node tools/bench-lexical-only.mjs   # 纯词法基线
node tools/bench-recall.mjs         # 混合（需 Ollama 在 11434）
```
