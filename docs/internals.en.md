# dsh-codemode internals

[简体中文](./internals.md) | **English**

This document is for maintainers and for developers who need the internal
mechanics. For installation, configuration, and day-to-day usage, see the
[README](../README.en.md).

## How it works

```
tools.wireSchemas(agent)          ->  standard tools + global layer (MCP/plugins) + agent layer + code_run
systemPrompt.assemble()           ->  assembly { sections, tools, contexts }
  system-prompt/assemble waterfall (this plugin, codemode sessions only)
    1. tools[]  -= every tool the preset's own scope did not register
                   (global layer + agent layer) + mcp__* + code_tools_*/code_debug
    2. append the Code Mode section (replace it when tools:sdk exists)
Model sees: standard tools + code_run
Model calls code_run -> this package's transport -> dsh-ptc-runtime-node runs the program
    each binding -> ctx.tools.execute({ parent, callId: '...:ptc:N' })   <- public API
       -> full pre-policy / guards / approval / post-execute / tool/result logging
    The registry is never touched: masked tools stay in it, so a program can still call them
```

The registry is never modified — only the **presentation** is. The transport's
sub-calls go through the registry's public `execute()` carrying the public
`parent` token, exactly how the built-in transport marks a nested call, so the
guard recognises them as program-internal.

The discriminator is exact: the discovery tools exist **only** in this preset's
scope, so any assembly containing them is a codemode assembly. Standard sessions
(no marker tool) and other presets are returned untouched.

`tools:sdk` is registered only under a non-`native` presentation. A native preset
therefore **appends** its own Code Mode section; when a deployment registers a
global one, the hook replaces it instead.

A few concrete behaviours on the presentation surface:

- **Attribution lives in `lib/scope.js`.** The registry resolves tools per layer:
  the global layer holds MCP servers and profile-level bundles, the preset layer
  holds this preset's own plugin rows, and the agent layer holds tool sets a plugin
  registers through `agent.ctx` (Agent Teams, schedule). At `apply()` time this
  package finds its own scope tag by symbol description (`dsh.scope`), then decides
  ownership with the **public** `ctx.tools.get(name)` (global view) and
  `ctx.tools.get(name, scopeKey)` (preset view): inside the preset view and outside
  the global view means the preset owns it and it stays native; everything else is
  masked. Without the tag (mounted at the host level) the rule goes inert, logs one
  warn, and only the name rules apply.
- The discovery tools (`code_tools_list`, `code_tools_search`,
  `code_tools_describe`, `code_debug`) are ordinary registry tools, so they exist
  only in this preset, become program bindings automatically, and run through the
  full pipeline (validation, policy, approval, guards, timeouts). They are masked
  like everything else and therefore callable only from inside a program.
- A model-direct call to a masked tool is rejected by the monotonic guard and
  answered with the self-healing hint; nested calls from inside a program (a
  `parent` token or a `:ptc:` sub-call id) pass. A name the registry cannot resolve
  is left to the registry's own `UNKNOWN_TOOL`.
- Only what a program returns or prints reaches the conversation; everything else
  stays inside the sandbox, and sub-calls write no session log (see
  [Limitations](../README.en.md#limitations)).

## Why a plugin-owned `code_run`

DSH `0.2.1-alpha.5` **removed the `both` presentation mode**; `mode` is now only
`native` or `ptc`:

- `native` — every tool presents natively, and there is **no** `run_code`;
- `ptc` — only `run_code` presents, and the registry **hard-denies** any
  model-direct call to another name (`UNKNOWN_TOOL`) at the execution boundary.

The two are mutually exclusive, so no configuration expresses "native tools plus
`run_code`". This preset therefore selects `native` to keep the native tool
surface, and this package supplies the transport itself. It cannot be called
`run_code` — the registry reserves that name and `tools.register()` throws — so
it is `code_run`.

## Retained environments

When the deployment configures `@deepseek-ai/dsh-ptc-runtime-node` with
`executionMode: persistent-in-memory`, one agent's `code_run` calls share a
resident REPL: top-level variables, functions, and imported modules survive
across calls. This package passes `stateOwner` on DSH's terms and registers the
release **in the same step**, so "passed an owner but never released it" is
unrepresentable (`lib/retention.js`).

Two cleanup layers cover different deaths:

1. an effect on the **agent's** scope — disposing the agent releases its
   environment even if this plugin was already unloaded; and
2. a **plugin-scope** teardown — unloading or reloading this package releases
   whatever is outstanding.

The registry dedups by `(agent, provider)` so runs do not accumulate disposers,
and unwraps cordis service proxies through `Symbol.for('cordis.original')` so a
reload never double-registers.

> A retained environment has **no idle expiry**: forgetting to release leaves a
> child process alive until the process exits. That is why this module exists.

Under the default `per-call` mode, passing `stateOwner` is harmless: the runtime
treats it as a temporary environment.

## Verification

```powershell
node --test                                                   # 90 offline tests
node tools/gen-preset.mjs <path/to/standard.patch.yml>        # re-generate the preset rows
dsh --profile codemode-verify --patch fixtures/verify-codemode.patch.yml --dump-config
```

The two fixture overlays below mount a local fake MCP server (3 tools, no
network), so the whole feature runs end to end on the `headless` app:

```powershell
# Masking: the 3 mcp__fake__* tools disappear from the model's tool list
dsh --profile codemode-verify-hl --patch fixtures/verify-host-mask.patch.yml "list every tool name you can call"

# Full Code Mode: discover and call a hidden tool from inside code_run
dsh --profile codemode-verify-hl --patch fixtures/verify-host-codemode.patch.yml "call code_run once, search for 'ticker', call the hit, return its result"
```

Scope attribution has its own offline check: `tools/verify-assembly.mjs` loads
cordis, `dsh-system-prompt`, `dsh-tools`, and `dsh-scope` as libraries, builds the
same global / preset / agent layers, then `import`s this package's `apply()` and
runs one real assembly plus real `execute()` calls. It asserts that preset tools
stay in the request, that global and agent-layer tools are masked, that the guard
denies model-direct calls to them, that the discovery listing agrees with the
request masking, and that a schema nobody attributes stays native. Because it
imports DSH's own packages, it must run beside the packages of the build under
test:

```powershell
# e.g. placed under <app>/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-tools/
<app>/resources/runtime/bin/node verify-assembly.mjs <this-checkout>/lib/index.js
```

Re-run it after touching `lib/scope.js` or `lib/rules.js`, and after a DSH upgrade.

## Baseline and upgrades

`cordis.patch.yml` embeds a **snapshot of the `preset-standard` plugin list shipped
with DSH** (the registry replaces a preset's child list wholesale and never merges
future changes). After a DSH upgrade, re-run:

```powershell
node tools/gen-preset.mjs node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml
```

The generator prefers the **`standard.patch.yml` shipped with a release**, because
it tracks that release exactly; since `0.2.x` the desktop profile is composed by
the Electron application and its on-disk `cordis.yml` stays an empty root.

Baseline: DSH `0.2.1-alpha.5`, source
`@deepseek-ai/dsh-web-app/presets/standard.patch.yml`.

`engines.dsh` in `package.json` makes DSH report a readable diagnostic at
**install/startup** instead of waiting for the preset mount to fail.
