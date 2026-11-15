/**
 * Codex PreToolUse hooks: discovery, trust, matching, execution and output
 * semantics.
 *
 * Reference: openai/codex rust-v0.169.0 (commit d32063f96c2d):
 * `codex-rs/hooks/src/engine/{discovery,matcher,dispatcher,command_runner,output_parser}.rs`,
 * `hooks/src/events/pre_tool_use.rs`, `hooks/src/config_rules.rs`,
 * `hooks/src/{lib,schema}.rs`, `config/src/fingerprint.rs`,
 * `protocol/src/hooks.rs`, `core/src/tools/hook_names.rs`.
 *
 * Discovery: each active config layer contributes `<folder>/hooks.json` and
 * the inline `[hooks]` table of its config.toml; `/etc/codex/requirements.toml`
 * contributes managed inline hooks; enabled plugins contribute their hooks.
 *
 * Trust: Codex runs a non-managed hook only when the user config has
 * `[hooks.state."<source path>:pre_tool_use:<group>:<handler>"]` with
 * `trusted_hash` equal to the hook's current hash and `enabled` not false.
 * The hash is `sha256:` + SHA-256 of the key-sorted JSON of
 * `{event_name, matcher, hooks: [normalized handler]}`. Managed layers are
 * trusted; `--dangerously-bypass-hook-trust` trusts everything.
 *
 * Hooks this adapter cannot reproduce exactly run in deny-only mode: a deny
 * still denies, a rewrite is refused, anything else is ignored. That covers
 * plugin hooks (their trust includes a plugin content fingerprint), `-c`
 * session-flag hooks, and every hook when `[hooks.state]` cannot be parsed.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { runCommandHook, type CommandHookResult } from '../../core/command-hook.js';
import type { DenySource } from '../../core/types.js';
import { ConfigError, getPath, isTable, type CodexConfig, type ConfigIo, type TomlTable } from './config.js';
import { shellQuote } from './shell.js';

export type HookTrustMode = 'trusted' | 'deny-only';

export type HookMatcher = { readonly kind: 'all' } | { readonly kind: 'exact'; readonly names: readonly string[] } | { readonly kind: 'regex'; readonly source: string };

/** One PreToolUse handler Codex would consider. */
export interface HookHandler {
  readonly key: string;
  readonly sourcePath: string;
  readonly origin: 'layer' | 'requirements' | 'plugin' | 'session-flags';
  readonly matcher: HookMatcher;
  readonly handler: { readonly type: 'command'; readonly command: string; readonly env: Readonly<Record<string, string>> } | { readonly type: 'mcp_tool'; readonly server: string; readonly tool: string };
  readonly timeoutSec: number;
  readonly mode: HookTrustMode;
  /** Codex hash of the handler (for trust and for diagnostics). */
  readonly hash: string;
}

const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT = 2500;

// ---------------------------------------------------------------------------
// Schemas of hook config (protocol/src/hooks.rs).
// ---------------------------------------------------------------------------

const CommandHandlerSchema = z.object({
  type: z.literal('command'),
  command: z.string(),
  commandWindows: z.string().optional(),
  command_windows: z.string().optional(),
  timeout: z.number().int().nonnegative().optional(),
  async: z.boolean().optional(),
  statusMessage: z.string().optional(),
  additionalContextLimit: z.number().int().nonnegative().optional(),
});

const McpToolHandlerSchema = z.object({
  type: z.literal('mcp_tool'),
  server: z.string(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
  timeout: z.number().int().nonnegative().optional(),
  statusMessage: z.string().optional(),
});

const PromptHandlerSchema = z.object({ type: z.literal('prompt') });
const AgentHandlerSchema = z.object({ type: z.literal('agent') });

const HandlerSchema = z.discriminatedUnion('type', [CommandHandlerSchema, McpToolHandlerSchema, PromptHandlerSchema, AgentHandlerSchema]);

const MatcherGroupSchema = z.looseObject({
  matcher: z.string().nullable().optional(),
  hooks: z.array(HandlerSchema).default([]),
});

const EventsSchema = z.looseObject({
  PreToolUse: z.array(MatcherGroupSchema).default([]),
});

const HooksFileSchema = z.strictObject({
  description: z.string().optional(),
  hooks: EventsSchema.default({ PreToolUse: [] }),
});

const HookStateSchema = z.looseObject({
  enabled: z.boolean().optional(),
  trusted_hash: z.string().optional(),
  trusted_content_hash: z.string().optional(),
});

type MatcherGroup = z.infer<typeof MatcherGroupSchema>;

// ---------------------------------------------------------------------------
// Hash (config/src/fingerprint.rs `version_for_toml`).
// ---------------------------------------------------------------------------

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, x]) => [k, sortKeys(x)]));
  }
  return v;
}

/**
 * The trust hash Codex computes for a command handler. `timeoutSec` is the
 * normalized timeout. Absent optional fields are omitted, like TOML
 * serialization of `None`.
 */
export function commandHookHash(input: {
  readonly matcher: string | null | undefined;
  readonly command: string;
  readonly timeoutSec: number;
  readonly async: boolean;
  readonly statusMessage?: string | undefined;
  readonly additionalContextLimit?: number | undefined;
}): string {
  const handler: Record<string, unknown> = { type: 'command', command: input.command, timeout: input.timeoutSec, async: input.async };
  if (input.statusMessage !== undefined) handler['statusMessage'] = input.statusMessage;
  if (input.additionalContextLimit !== undefined && input.additionalContextLimit !== DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT) {
    handler['additionalContextLimit'] = input.additionalContextLimit;
  }
  const identity: Record<string, unknown> = { event_name: 'pre_tool_use', hooks: [handler] };
  if (input.matcher !== undefined && input.matcher !== null) identity['matcher'] = input.matcher;
  const json = JSON.stringify(sortKeys(identity));
  return `sha256:${createHash('sha256').update(json, 'utf8').digest('hex')}`;
}

function mcpHookHash(matcher: string | null | undefined, h: z.infer<typeof McpToolHandlerSchema>, timeoutSec: number): string {
  const handler: Record<string, unknown> = { type: 'mcp_tool', server: h.server, tool: h.tool, input: h.input ?? {}, timeout: timeoutSec };
  if (h.statusMessage !== undefined) handler['statusMessage'] = h.statusMessage;
  const identity: Record<string, unknown> = { event_name: 'pre_tool_use', hooks: [handler] };
  if (matcher !== undefined && matcher !== null) identity['matcher'] = matcher;
  return `sha256:${createHash('sha256').update(JSON.stringify(sortKeys(identity)), 'utf8').digest('hex')}`;
}

/** Trust key of a handler (`hooks/src/lib.rs` `hook_key`). */
export function hookKey(sourcePath: string, groupIndex: number, handlerIndex: number): string {
  return `${sourcePath}:pre_tool_use:${groupIndex}:${handlerIndex}`;
}

// ---------------------------------------------------------------------------
// Matchers (hooks/src/engine/matcher.rs).
// ---------------------------------------------------------------------------

export function compileMatcher(pattern: string | null | undefined, where: string): HookMatcher {
  if (pattern === undefined || pattern === null || pattern === '' || pattern === '*') return { kind: 'all' };
  if (/^[A-Za-z0-9_|]+$/.test(pattern)) return { kind: 'exact', names: pattern.split('|') };
  try {
    new RegExp(pattern);
  } catch (err) {
    // Codex drops a group whose matcher is not a valid Rust regex. A matcher
    // JavaScript cannot compile may still be valid for Codex, so fail closed.
    throw new ConfigError(`hook matcher ${JSON.stringify(pattern)} in ${where} cannot be compiled: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { kind: 'regex', source: pattern };
}

export function matcherMatches(m: HookMatcher, names: readonly string[]): boolean {
  switch (m.kind) {
    case 'all':
      return true;
    case 'exact':
      return names.some((n) => m.names.includes(n));
    case 'regex': {
      const re = new RegExp(m.source);
      return names.some((n) => re.test(n));
    }
  }
}

// ---------------------------------------------------------------------------
// Discovery.
// ---------------------------------------------------------------------------

interface HookStates {
  readonly states: ReadonlyMap<string, z.infer<typeof HookStateSchema>>;
  /** False when `[hooks.state]` could not be parsed: trust is then unknown. */
  readonly readable: boolean;
}

function readHookStates(config: CodexConfig): HookStates {
  const states = new Map<string, z.infer<typeof HookStateSchema>>();
  let readable = true;
  for (const layer of config.layers) {
    if (layer.source !== 'user' && layer.source !== 'session-flags') continue;
    const raw = getPath(layer.config, ['hooks', 'state']);
    if (raw === undefined) continue;
    if (!isTable(raw)) {
      readable = false;
      continue;
    }
    for (const [k, v] of Object.entries(raw)) {
      const parsed = HookStateSchema.safeParse(v);
      if (!parsed.success) {
        readable = false;
        continue;
      }
      const key = k.trim();
      if (key === '') continue;
      const prev = states.get(key) ?? {};
      states.set(key, {
        ...prev,
        ...(parsed.data.enabled === undefined ? {} : { enabled: parsed.data.enabled }),
        ...(parsed.data.trusted_hash === undefined ? {} : { trusted_hash: parsed.data.trusted_hash }),
      });
    }
  }
  return { states, readable };
}

interface Source {
  readonly path: string;
  readonly keySource: string;
  readonly origin: HookHandler['origin'];
  readonly managed: boolean;
  readonly env: Readonly<Record<string, string>>;
}

function parseGroups(raw: unknown, where: string): MatcherGroup[] {
  const parsed = EventsSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new ConfigError(`invalid hooks in ${where}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  return parsed.data.PreToolUse;
}

function appendGroups(out: HookHandler[], groups: readonly MatcherGroup[], source: Source, states: HookStates, config: CodexConfig, platform: NodeJS.Platform): void {
  groups.forEach((group, groupIndex) => {
    const matcherRaw = group.matcher;
    const matcher = compileMatcher(matcherRaw, source.path);
    group.hooks.forEach((h, handlerIndex) => {
      if (h.type === 'prompt' || h.type === 'agent') return; // Codex skips these with a warning.
      const timeoutSec = Math.max(1, h.timeout ?? DEFAULT_TIMEOUT_SEC);
      const key = hookKey(source.keySource, groupIndex, handlerIndex);
      let hash: string;
      let handler: HookHandler['handler'];
      if (h.type === 'command') {
        const cmd = platform === 'win32' ? (h.commandWindows ?? h.command_windows ?? h.command) : h.command;
        if (cmd.trim() === '') return; // Codex skips empty commands.
        hash = commandHookHash({ matcher: matcherRaw, command: cmd, timeoutSec, async: h.async ?? false, statusMessage: h.statusMessage, additionalContextLimit: h.additionalContextLimit });
        // Async hooks never change the decision in Codex; nothing to run here.
        if (h.async === true) return;
        let command = cmd;
        for (const [k, v] of Object.entries(source.env)) command = command.split(`\${${k}}`).join(v);
        handler = { type: 'command', command, env: source.env };
      } else {
        if (h.server.trim() === '' || h.tool.trim() === '') return;
        hash = mcpHookHash(matcherRaw, h, timeoutSec);
        handler = { type: 'mcp_tool', server: h.server, tool: h.tool };
      }
      const state = states.states.get(key);
      // Managed hooks are always enabled; others can be disabled in the user config.
      if (!source.managed && state?.enabled === false) return;
      let mode: HookTrustMode | undefined;
      if (source.managed || config.bypassHookTrust) mode = 'trusted';
      else if (source.origin === 'plugin' || source.origin === 'session-flags' || !states.readable) mode = 'deny-only';
      else if (state?.trusted_hash === hash) mode = 'trusted';
      if (mode === undefined) return; // Untrusted or modified: Codex skips it.
      out.push({ key, sourcePath: source.path, origin: source.origin, matcher, handler, timeoutSec, mode, hash });
    });
  });
}

const PluginManifestSchema = z.looseObject({
  hooks: z.union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown()))]).optional(),
});

const PluginEnabledSchema = z.record(z.string(), z.looseObject({ enabled: z.boolean().optional() }).catch({}));

function appendPluginHooks(out: HookHandler[], config: CodexConfig, io: ConfigIo, states: HookStates, notes: string[]): void {
  const plugins = PluginEnabledSchema.safeParse(config.merged['plugins'] ?? {});
  if (!plugins.success) return;
  for (const [id, entry] of Object.entries(plugins.data)) {
    if (entry.enabled === false) continue;
    const at = id.lastIndexOf('@');
    if (at <= 0) continue;
    const name = id.slice(0, at);
    const marketplace = id.slice(at + 1);
    if (!/^[A-Za-z0-9._-]+$/.test(name) || !/^[A-Za-z0-9._-]+$/.test(marketplace)) continue;
    const base = path.join(config.codexHome, 'plugins', 'cache', marketplace, name);
    // The installed version is not recorded where this server can read it; every cached version is considered.
    for (const version of io.listDir(base).sort()) {
      const root = path.join(base, version);
      const env = { PLUGIN_ROOT: root, CLAUDE_PLUGIN_ROOT: root };
      const manifestPath = path.join(root, '.codex-plugin', 'plugin.json');
      const text = io.readFile(manifestPath);
      let sources: { file: string; rel: string; value: unknown }[] = [];
      let manifestHooks: z.infer<typeof PluginManifestSchema>['hooks'];
      if (text !== undefined) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          notes.push(`plugin manifest ${manifestPath} is not valid JSON; its hooks were not loaded`);
          continue;
        }
        const m = PluginManifestSchema.safeParse(json);
        if (!m.success) {
          notes.push(`plugin manifest ${manifestPath} is invalid; its hooks were not loaded`);
          continue;
        }
        manifestHooks = m.data.hooks;
      }
      const fromFile = (rel: string): void => {
        const file = path.resolve(root, rel);
        const body = io.readFile(file);
        if (body === undefined) return;
        try {
          sources.push({ file, rel: path.relative(root, file).split(path.sep).join('/'), value: JSON.parse(body) });
        } catch {
          throw new ConfigError(`plugin hooks file ${file} is not valid JSON`);
        }
      };
      if (manifestHooks === undefined) fromFile(path.join('hooks', 'hooks.json'));
      else if (typeof manifestHooks === 'string') fromFile(manifestHooks);
      else if (Array.isArray(manifestHooks)) {
        manifestHooks.forEach((item, index) => {
          if (typeof item === 'string') fromFile(item);
          else sources.push({ file: manifestPath, rel: `plugin.json#hooks[${index}]`, value: item });
        });
      } else sources.push({ file: manifestPath, rel: 'plugin.json#hooks[0]', value: manifestHooks });
      sources = sources.filter((s) => isTable(s.value));
      for (const s of sources) {
        const value = s.value;
        const events = isTable(value) && isTable(value['hooks']) ? value['hooks'] : value;
        appendGroups(out, parseGroups(events, s.file), { path: s.file, keySource: `${id}:${s.rel}`, origin: 'plugin', managed: false, env }, states, config, io.platform);
      }
    }
  }
}

/** Discovers the PreToolUse handlers Codex would run for this configuration. */
export function discoverHooks(config: CodexConfig, io: ConfigIo): { hooks: HookHandler[]; notes: string[] } {
  const notes: string[] = [];
  const out: HookHandler[] = [];
  if (!config.hooksEnabled) return { hooks: out, notes: ['hooks are disabled (features.hooks = false)'] };
  const states = readHookStates(config);
  if (!states.readable) notes.push('[hooks.state] could not be parsed: every configured hook runs in deny-only mode');
  const managedOnly = config.requirements?.allowManagedHooksOnly ?? false;

  if (config.requirements?.hooks) {
    const file = config.requirements.file;
    appendGroups(out, parseGroups(config.requirements.hooks, file), { path: file, keySource: file, origin: 'requirements', managed: true, env: {} }, states, config, io.platform);
  }
  const visitedFolders = new Set<string>();
  for (const layer of config.layers) {
    if (managedOnly && !layer.managed) continue;
    const origin: HookHandler['origin'] = layer.source === 'session-flags' ? 'session-flags' : 'layer';
    if (layer.folder !== null && !visitedFolders.has(layer.folder)) {
      visitedFolders.add(layer.folder);
      const file = path.join(layer.folder, 'hooks.json');
      const text = io.readFile(file);
      if (text !== undefined) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch (err) {
          // Codex skips an unparsable hooks.json with a warning; we refuse to guess.
          throw new ConfigError(`invalid JSON in ${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
        const parsed = HooksFileSchema.safeParse(json);
        if (!parsed.success) throw new ConfigError(`invalid hooks file ${file}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
        appendGroups(out, parsed.data.hooks.PreToolUse, { path: file, keySource: file, origin, managed: layer.managed, env: {} }, states, config, io.platform);
      }
    }
    const inline = layer.config['hooks'];
    if (inline !== undefined) {
      if (!isTable(inline)) throw new ConfigError(`[hooks] in ${layer.file} must be a table`);
      const events: TomlTable = { ...inline };
      delete events['state'];
      appendGroups(out, parseGroups(events, layer.file), { path: layer.file, keySource: layer.file, origin, managed: layer.managed, env: {} }, states, config, io.platform);
    }
  }
  if (!managedOnly) appendPluginHooks(out, config, io, states, notes);
  if (out.some((h) => h.mode === 'deny-only')) notes.push('some hooks run in deny-only mode (trust could not be verified)');
  return { hooks: out, notes };
}

// ---------------------------------------------------------------------------
// Running hooks and reading their output.
// ---------------------------------------------------------------------------

const HookSpecificSchema = z.strictObject({
  hookEventName: z.enum(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt']),
  permissionDecision: z.enum(['allow', 'deny', 'ask']).optional(),
  permissionDecisionReason: z.string().optional(),
  updatedInput: z.unknown().optional(),
  additionalContext: z.string().optional(),
});

const PreToolUseOutputSchema = z.strictObject({
  continue: z.boolean().optional(),
  stopReason: z.string().optional(),
  suppressOutput: z.boolean().optional(),
  systemMessage: z.string().optional(),
  decision: z.enum(['approve', 'block']).optional(),
  reason: z.string().optional(),
  hookSpecificOutput: HookSpecificSchema.optional(),
});

/** Outcome of one hook. */
export type HookOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'update'; readonly input: unknown }
  | { readonly kind: 'error'; readonly source: DenySource; readonly reason: string };

const nonEmpty = (s: string | undefined): string | undefined => {
  const t = s?.trim();
  return t === undefined || t === '' ? undefined : t;
};

/**
 * Interprets a finished command hook like Codex `pre_tool_use.rs`, except
 * that every result Codex treats as a non-blocking failure is an error here
 * (fail closed): non-zero exit other than 2, exit 2 without stderr, invalid
 * JSON, unsupported fields or decisions (`ask`, `allow` without
 * `updatedInput`, `continue: false`, ...), timeouts and crashes.
 */
export function interpretHookResult(r: CommandHookResult, label: string): HookOutcome {
  if (r.spawnError !== null) return { kind: 'error', source: 'hook-error', reason: `${label} could not start: ${r.spawnError}` };
  if (r.timedOut) return { kind: 'error', source: 'hook-timeout', reason: `${label} timed out` };
  if (r.aborted) return { kind: 'error', source: 'hook-error', reason: `${label} was cancelled` };
  if (r.stdoutTruncated || r.stderrTruncated) return { kind: 'error', source: 'hook-error', reason: `${label} produced too much output` };
  if (r.exitCode === 2) {
    const reason = nonEmpty(r.stderr);
    // Codex: exit 2 without stderr is a non-blocking failure. We deny.
    return reason === undefined ? { kind: 'error', source: 'hook-error', reason: `${label} exited with code 2 without a reason on stderr` } : { kind: 'deny', reason };
  }
  if (r.exitCode !== 0) {
    const detail = nonEmpty(r.stderr);
    return { kind: 'error', source: 'hook-error', reason: `${label} failed (${r.exitCode === null ? `signal ${r.signal ?? 'unknown'}` : `exit code ${r.exitCode}`})${detail ? `: ${detail.slice(0, 500)}` : ''}` };
  }
  const stdout = r.stdout.trim();
  // Codex ignores output that does not look like JSON.
  if (stdout === '' || !(stdout.startsWith('{') || stdout.startsWith('['))) return { kind: 'none' };
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { kind: 'error', source: 'hook-error', reason: `${label} returned invalid JSON` };
  }
  const parsed = PreToolUseOutputSchema.safeParse(json);
  if (!parsed.success) return { kind: 'error', source: 'hook-error', reason: `${label} returned unsupported output: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  const o = parsed.data;
  const bad = (what: string): HookOutcome => ({ kind: 'error', source: 'hook-error', reason: `${label} returned unsupported ${what}` });
  if (o.continue === false) return bad('continue:false');
  if (o.stopReason !== undefined) return bad('stopReason');
  if (o.suppressOutput === true) return bad('suppressOutput');
  const hs = o.hookSpecificOutput;
  const useSpecific = hs !== undefined && (hs.permissionDecision !== undefined || hs.permissionDecisionReason !== undefined || hs.updatedInput !== undefined);
  if (useSpecific) {
    if (hs.updatedInput !== undefined && hs.permissionDecision !== 'allow') return bad('updatedInput without permissionDecision:allow');
    switch (hs.permissionDecision) {
      case 'allow':
        if (hs.updatedInput === undefined) return bad('permissionDecision:allow without updatedInput');
        return { kind: 'update', input: hs.updatedInput };
      case 'ask':
        return bad('permissionDecision:ask');
      case 'deny': {
        const reason = nonEmpty(hs.permissionDecisionReason);
        return reason === undefined ? bad('permissionDecision:deny without a reason') : { kind: 'deny', reason };
      }
      case undefined:
        return bad('permissionDecisionReason without permissionDecision');
    }
  }
  if (o.decision === 'approve') return bad('decision:approve');
  if (o.decision === 'block') {
    const reason = nonEmpty(o.reason);
    return reason === undefined ? bad('decision:block without a reason') : { kind: 'deny', reason };
  }
  if (o.reason !== undefined) return bad('reason without decision');
  return { kind: 'none' };
}

export interface HookRunInput {
  readonly hooks: readonly HookHandler[];
  /** Names the call matches (`Bash`, or `apply_patch` plus its aliases). */
  readonly names: readonly string[];
  readonly stdin: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly signal: AbortSignal;
  /** Test hook to replace the process runner. */
  readonly run?: typeof runCommandHook;
}

/** Final result of the matching hooks. */
export type HooksResult =
  | { readonly kind: 'allow'; readonly updatedInput?: unknown }
  | { readonly kind: 'deny'; readonly source: DenySource; readonly reason: string };

/** Wraps the command the way Codex launches it: `$SHELL -lc <command>` (default `/bin/sh`). */
export function hookShellCommand(command: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string {
  if (platform === 'win32') return command;
  const shell = env['SHELL'] !== undefined && env['SHELL'] !== '' ? env['SHELL'] : '/bin/sh';
  return `exec ${shellQuote(shell)} -lc ${shellQuote(command)}`;
}

/**
 * Runs every matching hook in parallel and combines their outcomes: the
 * first non-allow outcome in configured order wins (Codex: any block wins,
 * reason of the first in order); otherwise the single rewrite, if any.
 * Several different rewrites are refused (Codex keeps whichever finished
 * last, which is not deterministic).
 */
export async function runHooks(input: HookRunInput): Promise<HooksResult> {
  const matching = input.hooks.filter((h) => matcherMatches(h.matcher, input.names));
  if (matching.length === 0) return { kind: 'allow' };
  const mcp = matching.find((h) => h.handler.type === 'mcp_tool');
  if (mcp && mcp.handler.type === 'mcp_tool') {
    return { kind: 'deny', source: 'unsupported-config', reason: `hook ${mcp.key} is an MCP tool hook (${mcp.handler.server}/${mcp.handler.tool}), which this server cannot run` };
  }
  const run = input.run ?? runCommandHook;
  const outcomes = await Promise.all(
    matching.map(async (h): Promise<HookOutcome> => {
      if (h.handler.type !== 'command') return { kind: 'none' };
      const result = await run({
        command: hookShellCommand(h.handler.command, input.env, input.platform),
        stdin: input.stdin,
        env: { ...h.handler.env },
        cwd: input.cwd,
        timeoutMs: h.timeoutSec * 1000,
        signal: input.signal,
      });
      const outcome = interpretHookResult(result, `hook ${h.key}`);
      if (h.mode === 'deny-only') {
        if (outcome.kind === 'deny') return outcome;
        if (outcome.kind === 'update') return { kind: 'error', source: 'unsupported-config', reason: `hook ${h.key} rewrote the call but its trust could not be verified` };
        return { kind: 'none' };
      }
      return outcome;
    }),
  );
  for (const o of outcomes) {
    if (o.kind === 'deny') return { kind: 'deny', source: 'hook', reason: o.reason };
    if (o.kind === 'error') return { kind: 'deny', source: o.source, reason: o.reason };
  }
  const updates = outcomes.filter((o): o is Extract<HookOutcome, { kind: 'update' }> => o.kind === 'update');
  if (updates.length === 0) return { kind: 'allow' };
  const first = JSON.stringify(updates[0]?.input);
  if (updates.some((u) => JSON.stringify(u.input) !== first)) {
    return { kind: 'deny', source: 'hook-error', reason: 'several hooks rewrote the call differently' };
  }
  return { kind: 'allow', updatedInput: updates[0]?.input };
}
