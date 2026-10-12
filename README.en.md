# dsh-codemode

A **Code Mode** agent preset for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH):
the standard-mode prompt and tools, plus one extra tool — the harness's reserved
`run_code` — while every MCP tool is kept **out of the model's context** and
reachable only from inside a program.

Modelled on pi's codemode (`mode: on` + deferred MCP exposure), implemented on
top of DSH's own PTC runtime instead of a hand-rolled sandbox.

## What it does

Pick the `codemode` mode for a session and:

- **The prompt and tools are the standard mode's**, unchanged, plus `run_code`.
- **`mcp__*` tools never enter the request.** No tool schema, no SDK declaration,
  no per-server prompt text — the request stays the same size as MCP servers come
  and go (only a per-namespace count is shown, as a hint).
- **They are still callable**, from inside `run_code`:

  ```js
  const { tools: hits } = await tools.code_tools_search({ query: 'okx ticker', limit: 5 })
  // hits[0].name, hits[0].description, hits[0].parameters (full JSON Schema)
  return await tools[hits[0].name]({ instId: 'BTC-USDT' })
  ```

- **Discovery is done by real tools**: `code_tools_list`, `code_tools_search`
  (BM25-style ranking, CJK bigrams), `code_tools_describe`, and `code_debug`.
  They are ordinary registry tools, so they exist only in this preset, become
  `run_code` bindings automatically, and run through the normal pipeline
  (validation, policy, guards, timeouts, session logging).
- **A guessed direct call is refused.** A monotonic guard rejects any model-direct
  call to a hidden tool and answers with the self-healing hint; nested calls from
  inside a program pass (they carry a `parent` token / `:ptc:` sub-call id).
- **Only what a program returns or prints reaches the conversation.** Everything
  else stays inside the sandbox, and every sub-call lands in the session log as
  `tool/ptc-dispatch`, so the run stays replayable.

Every other mode (`standard`, `ptc`, `minimal`, `cordis`) is untouched: MCP tools
keep their native presentation there.

## How it works

```
dsh-tools.wireSchemas(agent)      ->  standard tools + mcp__* + run_code   (mode: both)
systemPrompt.assemble()           ->  assembly { sections, tools, contexts }
  system-prompt/assemble waterfall (this plugin, codemode sessions only)
    1. tools[]  -= mcp__* and code_tools_*/code_debug
    2. sections['tools:sdk'] := Code Mode instructions
model sees: standard tools + run_code
model calls run_code -> dsh-tools PTC -> dsh-ptc-runtime-node child process
    bindings = registry.schemas(agent)   <- registry untouched: mcp__* is still there
```

The registry is never modified — only the *presentation* is. That is why the same
tools the request does not carry stay fully callable inside the program, and why
this needs no change to DSH itself.

The discriminator is exact: the discovery tools exist **only** in this preset's
scope, so an assembly that carries them is a codemode assembly. Standard sessions
(no `run_code`) and other PTC presets (no marker tool) are returned untouched.

## Install

```powershell
dsh plugin --profile desktop add "link:C:\Users\MuWinds\Documents\Coding Project\github\dsh-codemode"
```

That appends the bundle to `dsh.profile.bundles` and pulls the package in. **Restart
the desktop app**, then pick `Code Mode（代码编排）` as the mode of a new session.

## Configure

`cordis.patch.yml` mounts the preset; edit the `codemode` row's `config` to change
behaviour (`null`/absent = defaults):

| Key | Default | Meaning |
|---|---|---|
| `hiddenPrefixes` | `['mcp__']` | Tool-name prefixes stripped from the request surface |
| `metaTools` | `[list, search, describe, debug]` | Discovery tool names; the first is also the codemode marker |
| `searchLimit` | `8` | Default rows returned by `code_tools_search` |
| `maxDescriptionChars` | `240` | Description truncation in listings |
| `guard` | `true` | Reject model-direct calls to hidden tools |
| `sdkSection` | `true` | Replace the generated `tools:sdk` section with Code Mode instructions |
| `debug` | `true` | Register the `code_debug` tool |

## Verify

```powershell
node --test                                                   # 26 offline tests
node tools/gen-preset.mjs                                     # regenerate the preset rows
dsh --profile codemode-verify --patch fixtures/verify-codemode.patch.yml --dump-config
```

The two fixture overlays mount a local fake MCP server (3 tools, no network), so
the whole feature can be exercised end to end on the `headless` app:

```powershell
# masking: the 3 mcp__fake__* tools disappear from the model's tool list
dsh --profile codemode-verify-hl --patch fixtures/verify-host-mask.patch.yml "list every tool name you can call"

# full Code Mode: discover a hidden tool inside run_code, then call it
dsh --profile codemode-verify-hl --patch fixtures/verify-host-codemode.patch.yml "call run_code once, search for 'ticker', call the hit, return its result"
```

## Baseline and upgrades

`cordis.patch.yml` embeds a **snapshot of the shipped `preset-standard` plugin
list** (the registry replaces a preset's child list wholesale and never merges
future changes into it). After a DSH upgrade, re-run `node tools/gen-preset.mjs`
to re-sync it against `~/.dsh/profiles/<profile>/cordis.yml`.

Baseline: DSH `0.2.0-rc.2`, source `~/.dsh/profiles/desktop/cordis.yml`.

## Roll back

```powershell
dsh plugin --profile desktop remove dsh-codemode
```

The preset row lives in this bundle's patch layer, so it disappears with the
package. Nothing outside the profile was touched.

## Limits

- The code tool is the harness's reserved `run_code`; its name cannot be changed,
  and `both` (not `ptc`) presentation is what keeps standard tools natively callable.
- Sandboxing, approvals, timeouts and output limits are the PTC runtime's, i.e.
  the same ones the shipped `ptc` preset uses.
- Programs are one-shot: no state survives between `run_code` calls (a DSH
  constraint, not this plugin's).
