# dsh-codemode

[English](./README.en.md) | **简体中文**

一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的
**Code Mode（代码编排）** 智能体预设：提示词与工具完全沿用标准模式，只额外增加一个
工具——DSH 内置的 `run_code`；与此同时，**本预设自身清单以外的一切工具**（MCP 服务端、
profile 级插件、按 `agent.ctx` 注册的工具集）都被挡在**模型上下文之外**，只能从程序内部调用。

设计上参考了 pi 的 codemode（`mode: on` + MCP 延迟暴露），但实现建立在 DSH 自带的
PTC 运行时之上，而不是另起一套沙箱。

## 它做了什么

为会话选择 `codemode` 模式后：

- **提示词和工具与标准模式一致**，不做任何改动，只是多了一个 `run_code`。
- **本预设不拥有的工具完全不进入请求。** 没有工具 schema、没有 SDK 声明、没有按服务器拼接的
  提示词文本——无论 MCP 服务器或外部插件如何增减，请求体积保持不变（只显示各命名空间下的工具
  数量，作为提示）。

  判定依据是**注册作用域**，不是名字前缀：本预设自身的插件行注册在预设作用域里，保持原生；
  MCP 服务端与 profile 级 bundle 注册在全局层，按 `agent.ctx` 注册的工具集（如 Agent Teams、
  定时任务）落在 agent 层，两者都被遮蔽。名字规则（`hiddenPrefixes`、`hiddenTools`、
  `nativeTools`）依然生效，可用来加例外；注册表解析不出的名字（别的 prompt provider 贡献的
  schema）保持原生。
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

其他模式（`standard`、`ptc`、`minimal`、`cordis`）不受影响：那些模式下所有工具仍以原生
方式呈现。

## 工作原理

```
dsh-tools.wireSchemas(agent)      ->  标准工具 + 本预设之外的层 + run_code   (mode: both)
systemPrompt.assemble()           ->  assembly { sections, tools, contexts }
  system-prompt/assemble 瀑布钩子（本插件，仅 codemode 会话生效）
    1. tools[]  -= 本预设作用域之外的一切 + code_tools_*/code_debug
    2. sections['tools:sdk'] := Code Mode 说明
模型看到：标准工具 + run_code
模型调用 run_code -> dsh-tools PTC -> dsh-ptc-runtime-node 子进程
    bindings = registry.schemas(agent)   <- 注册表未改动：MCP 工具仍在其中
```

注册表从未被修改，被改的只是**呈现层**。正因如此，请求里没有携带的那些工具在程序内部依然
可以完整调用，也就不需要改动 DSH 本身。

遮蔽判定 = **名字规则 ∪ 作用域规则**。归属判定只用注册表的公开读取：`ctx.tools.get(name)`、
`ctx.tools.get(name, 预设作用域)`、`ctx.tools.get(name, agent 作用域)`——在预设作用域内能解析、
且不在全局视图里的工具，就是本预设自己注册的。

判别条件是精确的：发现工具**只**存在于本预设的作用域中，因此一个装配结果只要含有它们，
就一定是 codemode 装配。标准会话（没有 `run_code`）与其他 PTC 预设（没有标记工具）都会
原样返回，不受影响。

## 版本线

| 插件线 | 目标 DSH | 程序入口 |
|---|---|---|
| `0.2.x`（`main`） | 0.2.1-alpha.5 及以后（该版起 `mode: both` 被 `dsh-tools` 的 schema 移除） | 本包自带的 `code_run` 传输，预设行 `mode: native` |
| `0.1.x`（分支 `0.1.x`） | 0.2.0-rc.2（仍有 `mode: both`） | 内置 `run_code`（由 `both` 附带），本包不注册传输 |

两条线行为一致：标准工具原生，预设自身清单以外的一切（MCP、profile 级插件、按 `agent.ctx`
注册的工具集）都只能从程序内部调用。`0.1.1` 已在真正的 0.2.0-rc.2 内核上验证（见下节）。

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
| `nativeScope` | `true` | 遮蔽一切不是本预设自身作用域注册的工具（MCP、profile 级插件、按 agent 注册的工具集） |
| `hiddenPrefixes` | `['mcp__']` | 额外剥离的工具名前缀 |
| `nativeTools` | `[]` | 例外：这些名字始终原生呈现（内置 `run_code` 永远原生） |
| `hiddenTools` | `[]` | 例外：这些名字始终遮蔽 |
| `metaTools` | `[list, search, describe, debug]` | 发现工具名；第一个同时用作 codemode 标记 |
| `searchLimit` | `8` | `code_tools_search` 默认返回的行数 |
| `maxDescriptionChars` | `240` | 列表中描述文本的截断长度 |
| `guard` | `true` | 拒绝模型对被遮蔽工具的直接调用 |
| `sdkSection` | `true` | 用 Code Mode 说明替换自动生成的 `tools:sdk` 段落 |
| `debug` | `true` | 注册 `code_debug` 工具 |

## 验证

```powershell
node --test --experimental-test-isolation=none                     # 43 个离线测试
node tools/gen-preset.mjs                                          # 重新生成预设行
dsh --profile codemode-verify --patch fixtures/verify-codemode.patch.yml --dump-config
```

作用域判定无法用假 context 证明，因此另有一个装配 harness：把它复制到被测 DSH 构建的
`@deepseek-ai/dsh-tools` 目录下（该目录必须能解析到 `@deepseek-ai/*`），再指向本包的入口：

```powershell
node verify-assembly.mjs "<checkout>\lib\index.js"
```

它在真实 cordis + `dsh-tools`（`mode: both`）+ `dsh-scope` 上装配一次请求并做真实
`tools.execute()`，验证请求面只剩「预设清单 + 内置 `run_code` + 无法归属的 schema」、
MCP 与 agent 层工具被拒、发现工具的 listing 与请求遮蔽一致。

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

- 代码工具是 DSH 内置的 `run_code`，名称不可更改；而 `both`（而非 `ptc`）的呈现方式，
  正是标准工具仍可原生调用、并附带 `run_code` 的原因。
- **作用域判定依赖一处 DSH 内部结构。** 注册表没有公开「某个工具注册在哪个作用域」的 API，
  本包因此按符号描述 `dsh.scope` 读取 `@deepseek-ai/dsh-scope` 写在 scoped context 上的标签，
  再用公开的 `ctx.tools.get(name, scope)` 做归属判断（`lib/scope.js`）。读不到标签时（例如把本包
  挂在 host 层而不是预设里）作用域规则自动失效，只保留名字规则并打出一次 warn，不会误遮蔽。
  「注册表解析不出的名字」也保持原生——那是别的 prompt provider 贡献的 schema，谁也不拥有它。
- **预设清单内的插件行算「标准」。** 判定是「本预设自己注册的」而不是「随 DSH 发布的」：
  往 `cordis.patch.yml` 的插件列表里加一行，它注册的工具就和标准工具一样保持原生；需要遮蔽时
  用 `hiddenTools`。反过来，只要插件挂在 profile（`dsh plugin add`），它的工具就在全局层或
  agent 层，会被自动遮蔽。
- 沙箱、审批、超时和输出上限均由 PTC 运行时决定，与随包发布的 `ptc` 预设完全一致。
- 程序是一次性的：`run_code` 调用之间不保留任何状态（这是 DSH 的约束，与本插件无关）。
