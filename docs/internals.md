# dsh-codemode 开发文档

[English](./internals.en.md) | **简体中文**

本文档面向维护者，以及需要了解内部机制的开发者。安装、配置与日常使用请看
[README](../README.md)。

## 工作原理

```
tools.wireSchemas(agent)          ->  标准工具 + 全局层(MCP/插件) + agent 层 + mcp__* + code_run
systemPrompt.assemble()           ->  assembly { sections, tools, contexts }
  system-prompt/assemble 瀑布钩子（本插件，仅 codemode 会话生效）
    1. tools[] -= 非本预设作用域注册的工具（全局层 + agent 层）
                   + mcp__* + code_tools_*/code_debug
    2. sections 中若无 tools:sdk 则追加 Code Mode 说明（有则替换）
模型看到：标准工具 + code_run
模型调用 code_run -> 本包的传输层 -> dsh-ptc-runtime-node 执行程序
    每个绑定 -> ctx.tools.execute({ parent, callId: '...:ptc:N' })   <- 公开 API
       -> 完整的 pre-policy / 守卫 / 审批 / post-execute / tool/result 日志
    注册表从未改动：被遮蔽的工具仍在其中，因此程序内部仍可完整调用
```

注册表从未被修改，被改的只是**呈现层**。传输层的子调用走注册表的公开 `execute()`，并带上
公开的 `parent` 令牌——正是内置传输标记嵌套调用的方式，所以守卫会将其识别为程序内调用。

判别条件是精确的：发现工具**只**存在于本预设的作用域中，因此一个装配结果只要含有它们，
就一定是 codemode 装配。标准会话（没有标记工具）与其他预设都会原样返回，不受影响。

`tools:sdk` 段落只在非 `native` 呈现下注册。原生呈现时瀑布钩子会自行**追加**一段 Code Mode
说明；若部署另有一份全局注册，则改为替换它。

呈现面上的几个具体行为：

- **归属判定在 `lib/scope.js`。** 注册表按「层」解析工具：全局层是 MCP 服务端与 profile 级
  bundle，预设层是本预设自己的插件行，agent 层是按 `agent.ctx` 注册的工具集（Agent Teams、
  定时任务）。本包在 `apply()` 时按符号描述 `dsh.scope` 找到自己所在的作用域标签，装配时再用
  **公开**的 `ctx.tools.get(name)`（全局视图）与 `ctx.tools.get(name, scopeKey)`（预设视图）
  逐一判定：在预设视图内、且不在全局视图内 = 本预设所有，保持原生；其余一律遮蔽。读不到标签
  （挂载在 host 层）时该规则自动失效并 warn 一次，退化为纯名字规则。
- 发现工具（`code_tools_list`、`code_tools_search`、`code_tools_describe`、`code_debug`）
  是注册表上的普通工具，因此只存在于本预设中，会自动成为程序绑定，并走完整的执行管线
  （参数校验、策略、审批、守卫、超时）。它们自身也按同一套规则判为遮蔽，只能从程序内部调用。
- 模型对被遮蔽工具的直接调用会被单调守卫拒绝，并返回自愈提示；程序内部的嵌套调用（带 `parent`
  令牌或 `:ptc:` 子调用 id）正常放行。注册表解析不出的名字交给注册表自身的 `UNKNOWN_TOOL`。
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
遮蔽」「守卫拒绝直接调用」「发现工具的分类与请求遮蔽一致」「无人归属的 schema 保持原生」。
它需要 DSH 自己的包可解析，因此要放到被测 DSH 构建的包目录旁运行：

```powershell
# 例如放到 <app>/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-tools/ 下
<app>/resources/runtime/bin/node verify-assembly.mjs <本检出>/lib/index.js
```

改动 `lib/scope.js`、`lib/rules.js` 或 DSH 升级后应重跑。

## 基线与升级

`cordis.patch.yml` 内嵌了**随 DSH 发布的 `preset-standard` 插件列表快照**（注册表会整体
替换预设的子列表，不会把未来的变更合并进来）。DSH 升级后重新运行：

```powershell
node tools/gen-preset.mjs node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml
```

生成器优先接受**随版本发布的 `standard.patch.yml`**，因为它精确对应一个发行版；自 `0.2.x`
起桌面 profile 由 Electron 应用合成，磁盘上的 `cordis.yml` 只是一个空根。

基线：DSH `0.2.1-alpha.5`，来源 `@deepseek-ai/dsh-web-app/presets/standard.patch.yml`。

`package.json` 的 `engines.dsh` 会在版本不匹配时让 DSH 在**安装/启动阶段**报出可读诊断，
而不是等到预设挂载失败。
