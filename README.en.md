# dsh-codemode

[简体中文](./README.md) | **English**

A **Code Mode** agent preset for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH):
the standard tools stay natively callable, while **every tool this preset does not
own** (MCP tools, profile-level plugin bundles, per-agent tool sets) is kept **out
of the model's context** and reached on demand from inside a program through one
extra tool, `code_run`.

Modelled on pi's codemode (`mode: on` + deferred MCP exposure), implemented on
top of DSH's own PTC runtime instead of a hand-rolled sandbox.

## What it does

Pick the `codemode` mode for a session and:

- **The standard tools are the standard mode's**, natively callable, unchanged.
- **Everything the preset does not own is discovered and called from inside a
  program, keeping the fixed context cost down:**

  ```js
  const { tools: hits } = await tools.code_tools_search({ query: 'okx ticker', limit: 5 })
  // hits[0].name, hits[0].description, hits[0].parameters (full JSON Schema)
  return await tools[hits[0].name]({ instId: 'BTC-USDT' })
  ```

  The rule is **registration scope**, not a name prefix: the preset's own plugin
  rows register in the preset's scope and stay native, while MCP servers and
  profile-level bundles live in the global layer and per-agent tool sets (Agent
  Teams, schedule) land in the agent layer — both are masked. The name rules
  (`hiddenPrefixes`, `hiddenTools`, `nativeTools`) still apply, for exceptions.

Every other mode (`standard`, `ptc`, `minimal`, `cordis`) is untouched: tools keep
their native presentation there.

## Version lines

| Plugin line | Target DSH | Program entry |
|---|---|---|
| `0.2.x` (`main`) | 0.2.1-alpha.5 and later, where `dsh-tools` no longer accepts `mode: both` | this package's own `code_run` transport, preset row `mode: native` |
| `0.1.x` (branch `0.1.x`) | 0.2.0-rc.2, which still has `mode: both` | the built-in `run_code` that `both` adds; this package registers no transport |

Both lines behave the same way: standard tools stay native, and everything outside
the preset's own list (MCP, profile-level plugins, per-agent tool sets) is reached
only from inside a program. `0.2.1` is verified against a real 0.2.1-alpha.5 core;
the recipe is in [docs/internals.en.md](./docs/internals.en.md#verification).

## Install

![alt text](image.png)

For local development, point `link:` at the checkout instead:

```powershell
dsh plugin --profile desktop add "link:<path-to-the-checkout>"
```

## Configuration

`cordis.patch.yml` mounts the preset; edit the `codemode` row's `config` to change
behaviour (omit a key, or set it to `null`, to take the default):

| Key | Default | Meaning |
|---|---|---|
| `nativeScope` | `true` | Mask every tool the registry does not resolve from this preset's own scope (MCP, profile-level plugins, per-agent tool sets) |
| `hiddenPrefixes` | `['mcp__']` | Additional tool-name prefixes stripped from the request surface |
| `nativeTools` | `[]` | Exceptions: these names always stay native (`run_code` and `runToolName` always do) |
| `hiddenTools` | `[]` | Exceptions: these names are always masked |
| `metaTools` | `[list, search, describe, debug]` | Discovery tool names; the first doubles as the codemode marker |
| `runToolName` | `code_run` | Name of this package's transport tool (the reserved `run_code` is unavailable) |
| `searchLimit` | `8` | Default rows returned by `code_tools_search` |
| `maxDescriptionChars` | `240` | Truncation length for descriptions in listings |
| `maxParallelSubCalls` | `10` | Concurrent read-only sub-calls allowed inside one program |
| `guard` | `true` | Reject model-direct calls to masked tools |
| `sdkSection` | `true` | Inject / replace the Code Mode section |
| `debug` | `true` | Register the `code_debug` tool |

## Uninstall

```powershell
dsh plugin --profile desktop remove dsh-codemode
```

The preset row lives in this bundle's patch layer and disappears with the package.
Nothing outside the profile was ever modified.

## Limitations

- **The scope attribution leans on one DSH internal.** The registry exposes no
  "which scope registered this tool" API, so this package reads the tag
  `@deepseek-ai/dsh-scope` writes onto a scoped context (by symbol description,
  `dsh.scope`) and then decides ownership through the public
  `ctx.tools.get(name, scope)` (`lib/scope.js`). When the tag is absent — this
  package mounted at the host level rather than inside a preset — the scope rule
  goes inert, one warn is logged, and only the name rules apply, so nothing is
  masked by mistake.
- **A name nobody attributes stays native.** A schema contributed by another prompt
  provider is in no registry layer, so no rule owns it and it keeps its place in
  the request; only tools whose ownership the registry confirms are masked.
- **A plugin row inside the preset counts as standard.** The question answered is
  "did this preset register it?", not "does DSH ship it?": adding a row to
  `cordis.patch.yml` keeps its tools native like the standard ones (use
  `hiddenTools` to mask them), while anything installed at the profile level
  (`dsh plugin add`) lands in the global or agent layer and is masked
  automatically.
- **The sub-call scheduler is implemented here.** The built-in transport joins the
  agent loop's scheduler through the private `TOOL_RUNTIME_SCHEDULER`; this package
  reproduces the same observable contract from the public
  `ctx.tools.executionMode()` (`exclusive` serialises as a barrier, `parallel` is
  capped at `maxParallelSubCalls`). The difference: this pool orders sub-calls
  **within one program only**, never relative to other tool calls in the same
  model step.
- **No program-level sandbox escalation.** The built-in
  `sandbox_permissions` / `justification` rest on a module-private approval helper,
  so this package does not expose them; programs always run under the standing
  policy, while each **sub-call** still gets the built-in policy and approval
  pipeline.
- **Sub-calls write no session log.** `ctx.tools.execute()` only emits the
  `tools/result` event; the `tool/result` session entry is appended by the agent
  loop for the calls it scheduled itself, and nothing subscribes to write one for
  a program's sub-calls. The built-in transport additionally writes
  `tool/ptc-dispatch` / `tool/ptc-dispatch-start` pairing events; this one does
  not — so a program run leaves no replayable record of its sub-calls.
- Sandbox, timeout caps, and output caps are the PTC runtime's, identical to the
  shipped `ptc` preset; `timeoutMs` is clamped and timed by the runtime, and this
  package only forwards it.
- If a deployment sets `persona` to `complete: true`, `system-prompt` restores that
  complete section after the waterfall and the injected Code Mode section is
  dropped. The default configuration does not trigger this.

## Development docs

Architecture, the retained-environment lifecycle, verification, and the upgrade
procedure live in [docs/internals.en.md](./docs/internals.en.md).
