# dsh-codemode

A **Code Mode** agent preset for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH):
the standard-mode prompt and tools, plus one extra tool — the harness's built-in
`run_code` — while **every tool this preset's own composition does not register**
(MCP servers, profile-level plugins, per-agent tool sets) is kept **out of the
model's context** and reachable only from inside a program.

Modelled on pi's codemode (`mode: on` + deferred MCP exposure), implemented on
top of DSH's own PTC runtime instead of a hand-rolled sandbox.

## What it does

Pick the `codemode` mode for a session and:

- **The prompt and tools are the standard mode's**, unchanged, plus `run_code`.
- **Tools this preset does not own never enter the request.** No tool schema, no
  SDK declaration, no per-server prompt text — the request stays the same size as
  MCP servers and out-of-preset plugins come and go (only a per-namespace count is
  shown, as a hint).

  The decision is by **registration scope**, not by name prefix: the preset's own
  plugin rows register inside the preset scope and stay native; MCP servers and
  profile-level bundles register in the global layer, and tool sets a plugin
  registers through `agent.ctx` (Agent Teams, schedule tools) land in the agent
  layer — both are masked. The name rules (`hiddenPrefixes`, `hiddenTools`,
  `nativeTools`) still apply and can add exceptions, and a name the registry
  cannot resolve at all (a schema another prompt provider contributed) stays
  native.
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

Every other mode (`standard`, `ptc`, `minimal`, `cordis`) is untouched: every tool
keeps its native presentation there.

## How it works

```
dsh-tools.wireSchemas(agent)      ->  standard tools + layers outside this preset + run_code   (mode: both)
systemPrompt.assemble()           ->  assembly { sections, tools, contexts }
  system-prompt/assemble waterfall (this plugin, codemode sessions only)
    1. tools[]  -= everything outside this preset's scope + code_tools_*/code_debug
    2. sections['tools:sdk'] := Code Mode instructions
model sees: standard tools + run_code
model calls run_code -> dsh-tools PTC -> dsh-ptc-runtime-node child process
    bindings = registry.schemas(agent)   <- registry untouched: MCP tools are still there
```

The registry is never modified — only the *presentation* is. That is why the same
tools the request does not carry stay fully callable inside the program, and why
this needs no change to DSH itself.

Masking = **name rules ∪ scope rules**. Attribution only reads the registry's
public `get(name)`, `get(name, presetScope)` and `get(name, agentScope)`: a tool
that resolves inside the preset scope and not in the global view is one this
preset registered itself.

The discriminator is exact: the discovery tools exist **only** in this preset's
scope, so an assembly that carries them is a codemode assembly. Standard sessions
(no `run_code`) and other PTC presets (no marker tool) are returned untouched.

## Version lines

| Plugin line | Target DSH | Program entry |
|---|---|---|
| `0.2.x` (`main`) | 0.2.1-alpha.5 and later, where `dsh-tools` no longer accepts `mode: both` | this package's own `code_run` transport, preset row `mode: native` |
| `0.1.x` (branch `0.1.x`) | 0.2.0-rc.2, which still has `mode: both` | the built-in `run_code` that `both` adds; this package registers no transport |

Both lines behave the same way: standard tools stay native, and everything outside
the preset's own list (MCP, profile-level plugins, per-agent tool sets) is reached
only from inside a program. `0.1.1` is verified against a real 0.2.0-rc.2 core
(see below).

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
| `nativeScope` | `true` | Mask every tool not registered in this preset's own scope (MCP, profile-level plugins, per-agent tool sets) |
| `hiddenPrefixes` | `['mcp__']` | Extra tool-name prefixes stripped from the request surface |
| `nativeTools` | `[]` | Exceptions: these names always stay native (the built-in `run_code` always does) |
| `hiddenTools` | `[]` | Exceptions: these names are always masked |
| `metaTools` | `[list, search, describe, debug]` | Discovery tool names; the first is also the codemode marker |
| `searchLimit` | `8` | Default rows returned by `code_tools_search` |
| `maxDescriptionChars` | `240` | Description truncation in listings |
| `guard` | `true` | Reject model-direct calls to masked tools |
| `sdkSection` | `true` | Replace the generated `tools:sdk` section with Code Mode instructions |
| `debug` | `true` | Register the `code_debug` tool |

## Verify

```powershell
node --test --experimental-test-isolation=none                     # 43 offline tests
node tools/gen-preset.mjs                                          # regenerate the preset rows
dsh --profile codemode-verify --patch fixtures/verify-codemode.patch.yml --dump-config
```

Scope attribution cannot be proven with a fake context, so there is also an
assembly harness: copy it next to the DSH build's `@deepseek-ai/dsh-tools`
directory (which must resolve `@deepseek-ai/*`) and point it at this package's
entry:

```powershell
node verify-assembly.mjs "<checkout>\lib\index.js"
```

It assembles one request on real cordis + `dsh-tools` (`mode: both`) + `dsh-scope`
and makes real `tools.execute()` calls, checking that the request carries only the
preset's own list plus the built-in `run_code` and unattributable schemas, that
global- and agent-layer tools are denied, and that the discovery listing agrees
with the request masking.

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

- The code tool is the harness's built-in `run_code`; its name cannot be changed,
  and `both` (not `ptc`) presentation is what keeps standard tools natively
  callable while adding `run_code`.
- **Scope attribution depends on one DSH internal.** The registry publishes no
  "which scope did this tool register in" API, so this package reads the tag
  `@deepseek-ai/dsh-scope` writes onto a scoped context by its symbol description
  `dsh.scope`, then decides ownership through the public
  `ctx.tools.get(name, scope)` (`lib/scope.js`). When the tag is absent — e.g. the
  package mounted at the host level instead of inside a preset — the scope rule is
  inert, only the name rules apply, and one warn is logged; nothing is masked by
  mistake. A name the registry cannot resolve stays native too: another prompt
  provider contributed that schema, so nobody owns it.
- **A plugin row inside this preset counts as "standard".** The rule is "registered
  by this preset", not "shipped with DSH": add a row to `cordis.patch.yml`'s plugin
  list and the tools it registers stay native like the standard ones; use
  `hiddenTools` to mask them. Conversely, a plugin installed at profile level
  (`dsh plugin add`) registers in the global or agent layer and is masked
  automatically.
- Sandboxing, approvals, timeouts and output limits are the PTC runtime's, i.e.
  the same ones the shipped `ptc` preset uses.
- Programs are one-shot: no state survives between `run_code` calls (a DSH
  constraint, not this plugin's).
