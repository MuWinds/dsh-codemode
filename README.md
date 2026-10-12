# dsh-codemode

[English](./README.en.md) | **简体中文**

一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的
**Code Mode（代码编排）** 智能体预设：提示词与工具完全沿用标准模式，只额外增加一个
工具——DSH 保留的 `run_code`；与此同时，所有 MCP 工具都被挡在**模型上下文之外**，
只能从程序内部调用。

设计上参考了 pi 的 codemode（`mode: on` + MCP 延迟暴露），但实现建立在 DSH 自带的
PTC 运行时之上，而不是另起一套沙箱。

## 它做了什么

为会话选择 `codemode` 模式后：

- **提示词和工具与标准模式一致**，不做任何改动，只是多了一个 `run_code`。
- **`mcp__*` 工具完全不进入请求。** 没有工具 schema、没有 SDK 声明、没有按服务器拼接的
  提示词文本——无论 MCP 服务器如何增减，请求体积保持不变（只显示各命名空间下的工具数量，
  作为提示）。
- **它们依然可以调用**，在 `run_code` 内部：

  ```js
  const { tools: hits } = await tools.code_tools_search({ query: 'okx ticker', limit: 5 })
  // hits[0].name、hits[0].description、hits[0].parameters（完整 JSON Schema）
  return await tools[hits[0].name]({ instId: 'BTC-USDT' })
  ```

- **发现工具本身就是普通工具**：`code_tools_list`、`code_tools_search`（BM25 风格排序，
  支持中文二元切分）、`code_tools_describe` 以及 `code_debug`。它们是注册表上的普通工具，
  因此只存在于本预设中，会自动成为 `run_code` 的绑定，并且走正常的执行管线（参数校验、
  策略、守卫、超时、会话日志）。
- **直接猜名字调用会被拒绝。** 一个单调守卫会拦截模型对隐藏工具的直接调用，并返回自愈提示；
  而程序内部的嵌套调用（带 `parent` 令牌或 `:ptc:` 子调用 id）会正常放行。
- **只有程序 `return` 或 `console.log` 的内容会进入对话。** 其余都留在沙箱内，且每一次
  子调用都会以 `tool/ptc-dispatch` 记入会话日志，保证整次运行可回放。

其他模式（`standard`、`ptc`、`minimal`、`cordis`）不受影响：MCP 工具在那些模式下仍以原生
方式呈现。

## 工作原理

```
dsh-tools.wireSchemas(agent)      ->  标准工具 + mcp__* + run_code   (mode: both)
systemPrompt.assemble()           ->  assembly { sections, tools, contexts }
  system-prompt/assemble 瀑布钩子（本插件，仅 codemode 会话生效）
    1. tools[]  -= mcp__* 与 code_tools_*/code_debug
    2. sections['tools:sdk'] := Code Mode 说明
模型看到：标准工具 + run_code
模型调用 run_code -> dsh-tools PTC -> dsh-ptc-runtime-node 子进程
    bindings = registry.schemas(agent)   <- 注册表未改动：mcp__* 仍在其中
```

注册表从未被修改，被改的只是**呈现层**。正因如此，请求里没有携带的那些工具在程序内部依然
可以完整调用，也就不需要改动 DSH 本身。

判别条件是精确的：发现工具**只**存在于本预设的作用域中，因此一个装配结果只要含有它们，
就一定是 codemode 装配。标准会话（没有 `run_code`）与其他 PTC 预设（没有标记工具）都会
原样返回，不受影响。

## 安装

```powershell
dsh plugin --profile desktop add "link:C:\Users\MuWinds\Documents\Coding Project\github\dsh-codemode"
```

该命令会把 bundle 追加到 `dsh.profile.bundles` 并拉取本包。**重启桌面端应用**，然后在新建
会话时选择 `Code Mode（代码编排）` 模式。

## 配置

`cordis.patch.yml` 负责挂载本预设；修改 `codemode` 这一行的 `config` 即可调整行为
（`null` 或省略表示使用默认值）：

| 键 | 默认值 | 含义 |
|---|---|---|
| `hiddenPrefixes` | `['mcp__']` | 从请求呈现面中剥离的工具名前缀 |
| `metaTools` | `[list, search, describe, debug]` | 发现工具名；第一个同时用作 codemode 标记 |
| `searchLimit` | `8` | `code_tools_search` 默认返回的行数 |
| `maxDescriptionChars` | `240` | 列表中描述文本的截断长度 |
| `guard` | `true` | 拒绝模型对隐藏工具的直接调用 |
| `sdkSection` | `true` | 用 Code Mode 说明替换自动生成的 `tools:sdk` 段落 |
| `debug` | `true` | 注册 `code_debug` 工具 |

## 验证

```powershell
node --test                                                   # 26 个离线测试
node tools/gen-preset.mjs                                     # 重新生成预设行
dsh --profile codemode-verify --patch fixtures/verify-codemode.patch.yml --dump-config
```

下面两个 fixture 覆盖层会挂载一个本地假 MCP 服务器（3 个工具，不联网），因此整个特性可以
在 `headless` 应用上端到端跑通：

```powershell
# 遮蔽：3 个 mcp__fake__* 工具从模型的工具列表中消失
dsh --profile codemode-verify-hl --patch fixtures/verify-host-mask.patch.yml "list every tool name you can call"

# 完整 Code Mode：在 run_code 内部发现隐藏工具并调用它
dsh --profile codemode-verify-hl --patch fixtures/verify-host-codemode.patch.yml "call run_code once, search for 'ticker', call the hit, return its result"
```

## 基线与升级

`cordis.patch.yml` 内嵌了**随 DSH 发布的 `preset-standard` 插件列表快照**（注册表会整体
替换预设的子列表，不会把未来的变更合并进来）。DSH 升级后，重新运行
`node tools/gen-preset.mjs`，即可对照 `~/.dsh/profiles/<profile>/cordis.yml` 重新同步。

基线：DSH `0.2.0-rc.2`，来源 `~/.dsh/profiles/desktop/cordis.yml`。

## 回滚

```powershell
dsh plugin --profile desktop remove dsh-codemode
```

预设行位于本 bundle 的 patch 层中，会随包一起消失。profile 之外的任何内容都未被改动。

## 限制

- 代码工具是 DSH 保留的 `run_code`，名称不可更改；而 `both`（而非 `ptc`）的呈现方式，
  正是标准工具仍可原生调用的原因。
- 沙箱、审批、超时和输出上限均由 PTC 运行时决定，与随包发布的 `ptc` 预设完全一致。
- 程序是一次性的：`run_code` 调用之间不保留任何状态（这是 DSH 的约束，与本插件无关）。
