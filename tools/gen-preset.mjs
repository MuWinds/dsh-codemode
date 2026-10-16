#!/usr/bin/env node
/**
 * Generate `cordis.patch.yml` for the codemode preset.
 *
 * The preset must mount the *complete* standard composition plus two rows — the
 * registry replaces a preset's child list wholesale and never merges future
 * changes into it — so this script slices `preset-standard`'s `plugins:` block
 * out of a composed profile tree instead of hand-copying it. Re-run after a DSH
 * upgrade to pick up additions to the standard preset:
 *
 *   node tools/gen-preset.mjs <path>
 *
 * `<path>` may be either shape that contains a `preset-standard` row:
 *
 *   - a shipped preset file, e.g.
 *     `node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`
 *     (installed copies also live under the app's own resources); or
 *   - a composed profile tree, e.g. the `--dump-config` output.
 *
 * The shipped preset file is the one that tracks a release exactly, which is
 * why it is preferred over `$DSH_HOME/profiles/*​/cordis.yml`: since 0.2.x the
 * desktop profile is composed by the Electron application and its on-disk
 * `cordis.yml` stays an empty root.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const OUTPUT = join(PROJECT, 'cordis.patch.yml');

/** Rows this preset adds on top of the standard composition. */
const EXTRA_ROWS = [
  '          - id: tool-presentation',
  "            name: '@deepseek-ai/dsh-agent-tool-presentation'",
  '            config:',
  '              # Standard tools stay natively callable. DSH 0.2.1 removed the',
  '              # `both` mode, so the program transport is supplied by this',
  '              # package instead of by the presentation row.',
  '              mode: native',
  '          - id: codemode',
  "            name: 'dsh-codemode'",
  '            config:',
  '              # Tool-name prefixes kept out of the request surface.',
  '              hiddenPrefixes:',
  "                - 'mcp__'",
  '              # Mask every tool the registry does not resolve from this',
  "              # preset's own scope: MCP servers, profile-level plugin",
  '              # bundles, and per-agent tool sets. What stays in the request',
  "              # is the standard composition plus this package's transport.",
  '              nativeScope: true',
  '              # Explicit exceptions, by exact tool name:',
  "              #   nativeTools: ['load_workspace_dependencies']",
  "              #   hiddenTools: ['subagent_codex']",
  '              # Name of this package\'s own transport tool. It cannot be',
  '              # `run_code`: the registry reserves that name for the built-in',
  '              # PTC transport and rejects a registration that shadows it.',
  '              runToolName: code_run',
  '              # Discovery tools, callable only from inside a program.',
  '              metaTools:',
  '                - code_tools_list',
  '                - code_tools_search',
  '                - code_tools_describe',
  '                - code_debug',
];

/**
 * Slice one row's `plugins:` block, dedented to its own minimum indent.
 *
 * Both accepted input shapes are handled: the row may sit at the top level of a
 * composed tree or nested inside another patch entry, and the block ends at the
 * first non-empty line shallower than the plugin list itself — which keeps
 * nested lists (`- id: plan-mode` inside a `cordis:group`) inside the block.
 * @param lines - the file split into lines.
 * @param rowId - the preset row id to slice.
 * @returns the block and its own indent.
 */
function slicePluginsBlock(lines, rowId) {
  const start = lines.findIndex((line) => new RegExp(`^\\s*-\\s*id:\\s*${rowId}\\s*$`).test(line));
  if (start < 0) throw new Error(`row "id: ${rowId}" not found in ${SOURCE}`);
  const rowIndent = lines[start].match(/^\s*/)[0].length;

  let pluginsAt = -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue;
    const indent = lines[index].match(/^\s*/)[0].length;
    if (indent <= rowIndent) break;
    if (/^\s*plugins:\s*$/.test(lines[index])) {
      pluginsAt = index;
      break;
    }
  }
  if (pluginsAt < 0) throw new Error(`row "id: ${rowId}" has no plugins: block`);

  let listIndent = -1;
  let end = lines.length;
  for (let index = pluginsAt + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue;
    const indent = lines[index].match(/^\s*/)[0].length;
    if (listIndent < 0) {
      listIndent = indent;
      continue;
    }
    if (indent < listIndent) {
      end = index;
      break;
    }
  }
  if (listIndent < 0) throw new Error(`row "id: ${rowId}" has an empty plugins: block`);

  const block = lines.slice(pluginsAt + 1, end);
  while (block.length > 0 && block[block.length - 1].trim() === '') block.pop();
  if (block.length === 0) throw new Error(`row "id: ${rowId}" has an empty plugins: block`);
  return { block, indent: listIndent };
}

/**
 * A portable label for the source file, so the generated header never records
 * this machine's directory layout. A file shipped by a package is named as
 * `<name>@<version>/<path>`; this project's own files are named relatively.
 * @returns the note written into `cordis.patch.yml`'s header.
 */
function sourceLabel() {
  const own = join(PROJECT, 'package.json');
  let directory = dirname(SOURCE);
  for (;;) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      if (manifest === own) return relative(PROJECT, SOURCE).split('\\').join('/');
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        const rel = relative(directory, SOURCE).split('\\').join('/');
        const spec = pkg.version === undefined ? pkg.name : `${pkg.name}@${pkg.version}`;
        return `${spec}/${rel}`;
      } catch {
        return basename(SOURCE);
      }
    }
    const next = dirname(directory);
    if (next === directory) return basename(SOURCE);
    directory = next;
  }
}

/** Candidate inputs, in preference order. */
function candidates() {
  const explicit = process.argv[2];
  if (explicit !== undefined) return [resolve(explicit)];
  return [
    join(PROJECT, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml'),
    join(DSH_HOME, 'profiles', 'desktop', 'cordis.yml'),
    join(DSH_HOME, 'profiles', 'web', 'cordis.yml'),
    join(DSH_HOME, 'profiles', 'default', 'cordis.yml'),
  ];
}

let SOURCE = '';
let block;
let indent;
const tried = [];
for (const candidate of candidates()) {
  if (!existsSync(candidate)) continue;
  const raw = await readFile(candidate, 'utf8');
  if (!/id:\s*preset-standard\b/.test(raw)) {
    tried.push(`${candidate} (no preset-standard row)`);
    continue;
  }
  try {
    ({ block, indent } = slicePluginsBlock(raw.split(/\r?\n/), 'preset-standard'));
    SOURCE = candidate;
    break;
  } catch (error) {
    tried.push(`${candidate} (${error.message})`);
  }
}

if (SOURCE === '') {
  const lines = [
    'gen-preset: could not find a source with a `preset-standard` row.',
    'Pass one explicitly, e.g.:',
    '',
    '  node tools/gen-preset.mjs node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml',
    '',
    'The shipped file is the release-accurate source; $DSH_HOME/profiles/*/cordis.yml',
    'is an empty root on desktops that the Electron application composes.',
  ];
  if (tried.length > 0) lines.push('', 'Tried:', ...tried.map((entry) => `  - ${entry}`));
  throw new Error(lines.join('\n'));
}

if (!block.some((line) => /-\s*id:\s*persona\b/.test(line))) {
  throw new Error('the sliced block does not look like the standard preset (no persona row)');
}
if (!block.some((line) => /-\s*id:\s*tool-pwsh\b/.test(line))) {
  throw new Error('the sliced block does not look like the standard preset (no tool-pwsh row)');
}

// Re-indent the block so the plugin list lands at this patch's depth.
const shift = ' '.repeat(10 - indent);
const plugins = block.map((line) => (line.trim() === '' ? '' : shift + line));

const header = [
  '# AUTO-GENERATED by tools/gen-preset.mjs — do not edit by hand.',
  `# Source: ${sourceLabel()}`,
  `# Generated: ${new Date().toISOString()}`,
  '#',
  "# This bundle layer inserts one row: the `codemode` agent preset. Its plugin list",
  '# mirrors the composed `preset-standard` row captured above, plus:',
  '#   - @deepseek-ai/dsh-agent-tool-presentation with mode: native (standard tools',
  '#     stay natively callable), and',
  '#   - this package, which supplies the `code_run` program transport, masks every',
  "#     tool the preset's own composition does not register (MCP servers, profile",
  '#     bundles, per-agent tool sets) out of the request surface, and registers the',
  '#     discovery tools a program uses to find and call them.',
  '#',
  '# Re-run `node tools/gen-preset.mjs <path>` after a DSH upgrade to re-sync the',
  '# standard rows; the input must be the shipped standard.patch.yml of that release.',
];

const out = [
  ...header,
  '- insert:',
  '    - id: preset-codemode',
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  '        id: codemode',
  '        name: "Code Mode（代码编排）"',
  '        description: "标准模式 + code_run：标准工具照常直接调用，预设自身清单以外的工具（MCP、插件）不进上下文，由程序按需发现与调用。"',
  '        order: 9',
  '        plugins:',
  ...plugins,
  ...EXTRA_ROWS,
  '',
].join('\n');

await writeFile(OUTPUT, out, 'utf8');
console.log(`wrote ${OUTPUT}`);
console.log(`  source: ${SOURCE}`);
console.log(`  preset plugins: ${block.filter((line) => /^\s*-\s*id:/.test(line) && !/^\s{14,}/.test(line)).length} standard rows + 2 added`);
