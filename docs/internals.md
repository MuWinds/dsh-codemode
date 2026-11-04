# dsh-codemode 开发文档

[English](./internals.en.md) | **简体中文**

本文档面向维护者，以及需要了解内部机制的开发者。安装、配置与日常使用请看
[README](../README.md)。

## 工作原理

```
ctx.tools.setExecutor(本包的 CodemodeExecutor)     <- 预设作用域，注册表只认一个
systemPrompt.assemble()
  -> 注册表向该作用域的 executor 要 schema
     executor.describe(agent 视图的全部定义)
        1. 丢掉非本预设作用域注册的工具（全局层 + agent 层）
        2. 丢掉 mcp__* 与 code_tools_*/code_debug
        -> 请求面 = 标准工具 + code_run
     executor.sections -> tools:sdk 换成 Code Mode 说明
模型看到：标准工具 + code_run
模型调用 code_run -> 本包的传输层 -> dsh-ptc-runtime-node 执行程序
    每个绑定 -> ctx.tools.execute({ calls, agent, signal: 已打标记 })
       -> 委托给 @deepseek-ai/dsh-tool-executor-native 的管线
          -> 完整的 pre-policy / 审批 / around-dispatch / post-execute
    注册表从未改动：被遮蔽的工具仍在其中，因此程序内部仍可完整调用
```

注册表从未被修改，被改的只是**呈现层**。`0.2.2` 把呈现层从
`system-prompt/assemble` 瀑布搬到了 per-scope `ToolExecutor`：注册表向
`ctx.tools.setExecutor()` 选中的 executor 要模型可见的 schema，所以 executor 的
`describe()` **就是**请求面。这是本包在 `0.3.x` 上唯一的遮蔽接缝，也比旧钩子更正当——它是
这块的官方归属者。

`tools:sdk` 段落由 executor 自己的 `sections` 提供：注册表会替 executor 注册这些段落，
所以插件行**不能**再自己注册同名段落（会撞车）。

呈现面上的几个具体行为：

- **归属判定在 `lib/scope.js`。** 注册表按「层」解析工具：全局层是 MCP 服务端与 profile 级
  bundle，预设层是本预设自己的插件行，agent 层是按 `agent.ctx` 注册的工具集（Agent Teams、
  定时任务）。本包在 `apply()` 时按符号描述 `dsh.scope` 找到自己所在的作用域标签，再用
  **公开**的 `ctx.tools.get(name)`（全局视图）与 `ctx.tools.get(name, scopeKey)`（预设视图）
  逐一判定：在预设视图内、且不在全局视图内 = 本预设所有，保持原生；其余一律遮蔽。读不到标签
  （挂载在 host 层）时该规则自动失效并 warn 一次，退化为纯名字规则。
- **executor 拿不到 agent scope，所以入参即 agent 视图。** `describe()` 只收到「调用方能看到
  的定义」，没有 scope 参数。凡既不在全局视图也不在预设视图里的名字，只可能注册在预设之下
  （agent 层）——`resolveCatalogView` 就据此判定，比旧钩子更精确，因为它读的是注册表实际交来的
  那份定义集。同一份视图也被缓存下来给「模型直呼遮蔽工具」的拒绝路径复用，两者因此不可能不一致。
- 发现工具（`code_tools_list`、`code_tools_search`、`code_tools_describe`、`code_debug`）
  是注册表上的普通工具，因此只存在于本预设中，会自动成为程序绑定，并走完整的执行管线
  （参数校验、策略、审批、守卫、超时）。它们自身也按同一套规则判为遮蔽，只能从程序内部调用。
- 模型对被遮蔽工具的直接调用由 executor 的 `execute()` 在派发**之前**拒绝，并返回自愈提示。
  这一层不能交给 `tools.guard()`：守卫运行在委托管线**内部**，那时调用已被接纳；而遮蔽的名字
  根本不在模型拿到的目录里，必须在派发前就挡掉。
- **程序内子调用靠 signal 标记识别。** `0.2.2` 的批量 `tools.execute()` 入参没有 `parent`
  字段（执行令牌由注册表自己的管线铸造，插件传输造不出来），所以传输层把自己持出的
  `AbortSignal` 打上 `Symbol.for('dsh-codemode.nested')`；executor 的拒绝判断同时读这个标记与
  `:ptc:` 子调用 id。signal 是模型无法伪造的对象，因此这条判定不是可绕过的约定。
- 只有程序 `return` 或 `console.log` 的内容会进入对话，其余留在沙箱内；子调用不写会话日志
  （见 [限制](../README.md#限制)）。

## 设计取舍：为什么用插件自带的 `code_run`

DSH `0.2.1-alpha.5` **移除了 `both` 呈现模式**；`mode` 现在只有 `native` 或 `ptc`：

- `native`——所有工具都原生呈现，且**没有** `run_code`；
- `ptc`——只有 `run_code` 呈现，注册表在执行边界**硬拒绝**模型对其他任何名字的直接调用
  （`UNKNOWN_TOOL`）。

两者互斥，因此没有任何配置能表达「原生工具 + `run_code`」。本预设因此选择 `native` 保住
原生工具面，由本包自己提供传输层。该工具不能叫 `run_code`——注册表保留了那个名字，
`tools.register()` 会抛错——所以叫 `code_run`。

## 设计取舍：为什么自带 `dsh-tool-executor-native` 依赖

executor 必须能真正执行工具，而 profile 插件解析不到宿主的内核包。可选做法有三种：

1. **自己重写管线**——不可接受：pre-policy、审批、around-dispatch、post-execute 任何一处漏掉，
   插件就会静默丢策略。
2. **`tools.restrict()`**——实测在 preset 作用域只能命名**继承来的**根层工具，且是硬删除：
   嵌套调用也会变 `UNKNOWN_TOOL`，直接废掉 Code Mode。
3. **把 `@deepseek-ai/dsh-tool-executor-native` 作为真实依赖装上**（本包选择）。它是纯 Cordis
   插件，`describe()` 走 `projectToolSchema`、`execute()` 走 `executeToolBatch`，跨两份独立的
   模块图驱动宿主注册表已经实测通过。代价是安装多约 19 个包 / 6.6 MB。

`ToolSchema.deferLoading` 不是替代方案：它只是适配器级提示，默认路由
（未声明 `toolUpdate`）会直接剥掉该标志，因此既不隐藏 schema 也不阻止调用。

## 保留执行环境

当部署把 `@deepseek-ai/dsh-ptc-runtime-node` 配成 `executionMode: persistent-in-memory` 时，
同一个 agent 的多次 `code_run` 会共用一个常驻 REPL，顶层变量、函数与 `import` 的模块跨调用
存活。本包按 DSH 的契约传入 `stateOwner`，并**在同一动作里**注册释放，因此"传了 owner 却没
释放"在结构上不可表达（`lib/retention.js`）。

清理有两层，覆盖不同的"死亡"：

1. 挂在 **agent 作用域**上的 effect——即使本插件早已卸载，agent 销毁也会释放其环境；
2. 挂在**插件作用域**上的 teardown——卸载或热重载本包时释放所有遗留环境。

注册表按 `(agent, provider)` 去重，避免每次调用都注册一个 disposer；通过
`Symbol.for('cordis.original')` 剥掉 cordis 服务代理，使热重载不会重复注册。

> 常驻环境**没有空闲过期**：忘记释放会让子进程存活到进程结束。这正是本模块存在的理由。

未启用常驻模式（默认 `per-call`）时，传 `stateOwner` 也无副作用：运行时按临时环境处理。

## 验证

```powershell
node --test                                                   # 90 个离线测试
node tools/gen-preset.mjs <path/to/standard.patch.yml>        # 重新生成预设行
dsh --profile codemode-verify --patch fixtures/verify-codemode.patch.yml --dump-config
```

下面两个 fixture 覆盖层会挂载一个本地假 MCP 服务器（3 个工具，不联网），因此整个特性可以
在 `headless` 应用上端到端跑通：

```powershell
# 遮蔽：3 个 mcp__fake__* 工具从模型的工具列表中消失
dsh --profile codemode-verify-hl --patch fixtures/verify-host-mask.patch.yml "list every tool name you can call"

# 完整 Code Mode：在 code_run 内部发现隐藏工具并调用它
dsh --profile codemode-verify-hl --patch fixtures/verify-host-codemode.patch.yml "call code_run once, search for 'ticker', call the hit, return its result"
```

作用域判定另有一层离线验证：`tools/verify-assembly.mjs` 把 cordis、`dsh-system-prompt`、
`dsh-tools`、`dsh-scope` 当库加载，按同样方式造出全局层 / 预设层 / agent 层，再 `import` 本包的
`apply()` 跑一次真实装配与真实 `execute()`，断言「预设工具留在请求里」「全局层与 agent 层工具被
遮蔽」「模型直呼被拒绝」「发现工具的分类与请求遮蔽一致」「无人归属的 schema 保持原生」。
它需要 DSH 自己的包可解析，因此要放到被测 DSH 构建的包目录旁运行：

```powershell
# 例如放到 <app>/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-tools/ 下
<app>/resources/runtime/bin/node verify-assembly.mjs <本检出>/lib/index.js
```

改动 `lib/scope.js`、`lib/executor.js`、`lib/rules.js` 或 DSH 升级后应重跑。

**在 0.2.2-alpha.3 上验证。** `0.3.x` 线的基线是 `0.2.2-alpha.3`，`0.2.x` 线是
`0.2.1-alpha.5`。内核层验证在独立目录装对应版本的包（`cordis` 作为 peer 由 npm 解析）：

```powershell
# 0.3.x 线（main）
npm install @deepseek-ai/cordis@~4.0.6-alpha.2 @deepseek-ai/dsh-tools@0.2.2-alpha.3 `
  @deepseek-ai/dsh-system-prompt@0.2.2-alpha.3 @deepseek-ai/dsh-scope@0.2.2-alpha.3 `
  @deepseek-ai/dsh-tool-executor-native@0.2.2-alpha.3

# 0.2.x 线
npm install @deepseek-ai/dsh-tools@0.2.1-alpha.5 @deepseek-ai/dsh-system-prompt@0.2.1-alpha.5 `
  @deepseek-ai/dsh-scope@0.2.1-alpha.5
```

2026-11 实测（`0.2.2-alpha.3`）：`ctx.tools.setExecutor()` 是唯一还能决定请求工具列表的接缝；
`system-prompt/assemble` 瀑布不再把 `tools` 交给监听器（构造 `{sections,contexts,variables}`，
瀑布后才由 provider 结果接回）；`tools.execute()` 改为批量入参；`tools.executionMode()` 已移除；
`@deepseek-ai/dsh-agent-tool-presentation` 已废弃且不再随 `dsh-web-app`/`dsh-base` 发布；
`dsh-scope` 的 `Symbol("dsh.scope")` 与 `run_code` 保留名语义未变；`ptcRuntime` 的
`programFormat` / `timeout` / `sandboxMode` / `executionInstructions` / `language` 未变。

端到端另有两个探针，覆盖真实内核上的完整链路。它们同样要在能解析 DSH 包的目录里运行
（把 `tools/verify-e2e.mjs`、`tools/verify-isolation.mjs` 复制到该目录即可）：

```powershell
node verify-e2e.mjs        # 20 项：遮蔽、段落、拒绝、code_run 子调用、discovery 可达
node verify-isolation.mjs  #  8 项：同进程内 standard 预设完全不受影响
```

两者都在 `0.2.2-alpha.3` 上实测 `20/20` 与 `8/8` 全 PASS。

## 基线与升级

`cordis.patch.yml` 内嵌了**随 DSH 发布的 `preset-standard` 插件列表快照**（注册表会整体
替换预设的子列表，不会把未来的变更合并进来）。DSH 升级后重新运行：

```powershell
node tools/gen-preset.mjs node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml
```

生成器优先接受**随版本发布的 `standard.patch.yml`**，因为它精确对应一个发行版；自 `0.2.x`
起桌面 profile 由 Electron 应用合成，磁盘上的 `cordis.yml` 只是一个空根。生成器逐行原样复制
（`!!js` 表达式与新 config 键都会保留），但 `EXTRA_ROWS` 是硬编码的——`0.2.2` 起其中**不再**
包含 `tool-presentation` 行，原因见下。

基线：DSH `0.2.2-alpha.3`，来源 `@deepseek-ai/dsh-web-app/presets/standard.patch.yml`。

`package.json` 的 `engines.dsh` 会在版本不匹配时让 DSH 在**安装/启动阶段**报出可读诊断，
而不是等到预设挂载失败。

### 0.2.2 为什么必须换接缝

`0.2.2-alpha.2` 起内核重做了工具呈现，`0.2.x` 线的承重点同时失效，且多为**静默**失效
（不抛错，只让遮蔽变成空操作）：

| `0.2.x` 依赖 | 0.2.2+ 的现实 |
|---|---|
| `system-prompt/assemble` 的 `assembly.tools` | 不再传入；`if (!Array.isArray(assembled.tools)) return` 每次早退 |
| `ctx.tools.execute({callId,name,arguments,...})` | 改为批量 `{calls,agent,signal}`，旧形参在管线里 `undefined.map` 抛错 |
| `ctx.tools.executionMode` | 移除，迁至 `ToolExecutionPipeline.executionMode()` |
| 预设行 `tool-presentation` `mode:native` | 包已废弃且不再随 `dsh-web-app`/`dsh-base` 发布；缺失时该行 `never started`，**整个预设激活失败** |
| 快照行 `dsh-tool-subagent-control/list-agents` | `exports` 已无该子路径（工具并入主插件），同样导致预设激活失败 |

`0.3.x` 因此改用 `ctx.tools.setExecutor()`：注册表向当前作用域的 executor 要 schema，
`describe()` 就是请求面。`dsh-base` 已为所有 profile 挂载 `tool-executor-native` 行，
所以快照里不再需要 `tool-presentation`；本包在预设作用域内提供自己的 executor 覆盖掉它。
