import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { claudeConfigDir } from './hosts/claude/settings.js';
import { REGISTERED_SERVER_NAME } from './server/runtime.js';
import { unifiedDiff } from './tools/diff.js';

export type InstallHost = 'claude' | 'codex';
export type InstallScope = 'user' | 'project';

export interface InstallOptions {
  readonly host: InstallHost;
  readonly scope: InstallScope;
  readonly write: boolean;
  readonly local: boolean;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}

export interface FileChange {
  readonly file: string;
  readonly before: string | null;
  readonly after: string;
}

export interface InstallPlan {
  readonly text: string;
  readonly changes: readonly FileChange[];
  readonly commands: readonly string[];
  readonly refusals: readonly string[];
}

const RUN_TOOL = `mcp__${REGISTERED_SERVER_NAME}__run`;

export const INSTALL_CODEX_TOOL_TIMEOUT_SEC = 300;

export function cliArgv(local: boolean): readonly string[] {
  if (!local) return ['npx', '-y', REGISTERED_SERVER_NAME];
  return [process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url))];
}

function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

function shellLine(argv: readonly string[]): string {
  return argv.map(shellWord).join(' ');
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
}

const JsonObject = z.record(z.string(), z.unknown());

function parseJsonObject(text: string | null, file: string): Record<string, unknown> {
  if (text === null || text.trim() === '') return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}); fix it or apply the change by hand`);
  }
  const parsed = JsonObject.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} does not hold a JSON object; apply the change by hand`);
  return parsed.data;
}

function objectAt(obj: Record<string, unknown>, key: string, file: string): Record<string, unknown> {
  const value = obj[key];
  if (value === undefined) return {};
  const parsed = JsonObject.safeParse(value);
  if (!parsed.success) throw new Error(`${file}: "${key}" is not an object; apply the change by hand`);
  return parsed.data;
}

export function companionHookEntry(local: boolean): { matcher: string; hooks: { type: 'command'; command: string }[] } {
  return { matcher: RUN_TOOL, hooks: [{ type: 'command', command: shellLine([...cliArgv(local), 'hook']) }] };
}

function withCompanionHook(text: string | null, file: string, local: boolean): string {
  const settings = parseJsonObject(text, file);
  const hooks = objectAt(settings, 'hooks', file);
  const preRaw = hooks['PreToolUse'] ?? [];
  const pre = z.array(z.unknown()).safeParse(preRaw);
  if (!pre.success) throw new Error(`${file}: "hooks.PreToolUse" is not an array; apply the change by hand`);
  const entry = companionHookEntry(local);
  const command = entry.hooks[0]?.command;
  const present = pre.data.some((group) => {
    const g = z.looseObject({ matcher: z.string().optional(), hooks: z.array(z.looseObject({ command: z.string().optional() })) }).safeParse(group);
    return g.success && g.data.matcher === entry.matcher && g.data.hooks.some((h) => h.command === command);
  });
  if (present && text !== null) return text;
  const next = { ...settings, hooks: { ...hooks, PreToolUse: [...pre.data, ...(present ? [] : [entry])] } };
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function mcpJsonEntry(local: boolean): { type: 'stdio'; command: string; args: string[] } {
  const [command = 'npx', ...args] = [...cliArgv(local), 'serve', '--host', 'claude'];
  return { type: 'stdio', command, args };
}

function withMcpJsonServer(text: string | null, file: string, local: boolean): string {
  const doc = parseJsonObject(text, file);
  const servers = objectAt(doc, 'mcpServers', file);
  const next = { ...doc, mcpServers: { ...servers, [REGISTERED_SERVER_NAME]: mcpJsonEntry(local) } };
  const out = `${JSON.stringify(next, null, 2)}\n`;
  return text !== null && JSON.stringify(parseJsonObject(text, file)) === JSON.stringify(next) ? text : out;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexServerBlock(local: boolean): string {
  const [command = 'npx', ...args] = [...cliArgv(local), 'serve', '--host', 'codex'];
  return [
    `[mcp_servers.${REGISTERED_SERVER_NAME}]`,
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(', ')}]`,
    `tool_timeout_sec = ${INSTALL_CODEX_TOOL_TIMEOUT_SEC}`,
    '',
    // `run` mutates, so it has no readOnlyHint; without an explicit approval Codex refuses it under approval_policy "never".
    `[mcp_servers.${REGISTERED_SERVER_NAME}.tools.run]`,
    'approval_mode = "approve"',
    '',
  ].join('\n');
}

const TomlTableSchema = z.record(z.string(), z.unknown());

function parseTomlTable(text: string): Record<string, unknown> | Error {
  try {
    const parsed = TomlTableSchema.safeParse(parseToml(text));
    return parsed.success ? parsed.data : new Error('not a TOML table');
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function codexServerEntry(local: boolean): unknown {
  const parsed = parseTomlTable(codexServerBlock(local));
  return parsed instanceof Error ? undefined : TomlTableSchema.safeParse(parsed['mcp_servers']).data?.[REGISTERED_SERVER_NAME];
}

function planCodexConfig(before: string | null, file: string, local: boolean): { after?: string; note?: string; refusal?: string } {
  const current = before === null ? {} : parseTomlTable(before);
  if (current instanceof Error) return { refusal: `${file} is not valid TOML (${current.message.split('\n')[0] ?? ''}); fix it or add the block by hand` };
  const servers = TomlTableSchema.safeParse(current['mcp_servers'] ?? {});
  if (!servers.success) return { refusal: `${file}: mcp_servers is not a table; add the block by hand` };
  const existing = servers.data[REGISTERED_SERVER_NAME];
  if (existing !== undefined) {
    if (JSON.stringify(existing) === JSON.stringify(codexServerEntry(local))) return { note: `${file} already has this configuration.` };
    return { refusal: `${file} already defines mcp_servers.${REGISTERED_SERVER_NAME} with other settings; --write does not edit an existing table, so compare it with the block above and change it by hand` };
  }
  const sep = before === null || before === '' ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const after = `${before ?? ''}${sep}${codexServerBlock(local)}`;
  const check = parseTomlTable(after);
  const added = check instanceof Error ? undefined : TomlTableSchema.safeParse(check['mcp_servers']).data?.[REGISTERED_SERVER_NAME];
  if (check instanceof Error || JSON.stringify(added) !== JSON.stringify(codexServerEntry(local))) {
    return {
      refusal: `appending the block to ${file} would not give a valid configuration (${check instanceof Error ? check.message.split('\n')[0] : 'the table would merge with existing keys'}); add it by hand`,
    };
  }
  return { after };
}


export async function planInstall(o: InstallOptions): Promise<InstallPlan> {
  const lines: string[] = [];
  const changes: FileChange[] = [];
  const commands: string[] = [];
  const refusals: string[] = [];
  if (o.host === 'claude') {
    const settingsFile = o.scope === 'user' ? path.join(claudeConfigDir(o.env, o.home), 'settings.json') : path.join(o.cwd, '.claude', 'settings.json');
    const serverArgv = [...cliArgv(o.local), 'serve', '--host', 'claude'];
    if (o.scope === 'user') {
      const add = shellLine(['claude', 'mcp', 'add', '--scope', 'user', REGISTERED_SERVER_NAME, '--', ...serverArgv]);
      commands.push(add);
      lines.push('# 1. Register the MCP server (run this yourself; install never edits ~/.claude.json):', add, '');
    } else {
      const mcpFile = path.join(o.cwd, '.mcp.json');
      const before = await readText(mcpFile);
      const after = withMcpJsonServer(before, mcpFile, o.local);
      if (after !== before) changes.push({ file: mcpFile, before, after });
      lines.push(`# 1. Register the MCP server in ${mcpFile}:`, JSON.stringify({ mcpServers: { [REGISTERED_SERVER_NAME]: mcpJsonEntry(o.local) } }, null, 2), '');
    }
    const before = await readText(settingsFile);
    const after = withCompanionHook(before, settingsFile, o.local);
    if (after !== before) changes.push({ file: settingsFile, before, after });
    lines.push(
      `# 2. Add the companion context hook to ${settingsFile} (it tells the server the live permission mode, cwd and subagent of each run call):`,
      JSON.stringify({ hooks: { PreToolUse: [companionHookEntry(o.local)] } }, null, 2),
      '',
      `# The run tool is ${RUN_TOOL}. In claude -p, allow it as usual (e.g. --allowedTools ${RUN_TOOL}); every call inside it is still checked against your rules and hooks.`,
    );
  } else {
    const codexHome = o.env['CODEX_HOME'] !== undefined && o.env['CODEX_HOME'] !== '' ? o.env['CODEX_HOME'] : path.join(o.home, '.codex');
    const configFile = o.scope === 'user' ? path.join(codexHome, 'config.toml') : path.join(o.cwd, '.codex', 'config.toml');
    const block = codexServerBlock(o.local);
    const before = await readText(configFile);
    lines.push(`# Add to ${configFile}:`, block);
    const planned = planCodexConfig(before, configFile, o.local);
    if (planned.after !== undefined) changes.push({ file: configFile, before, after: planned.after });
    if (planned.note !== undefined) lines.push(`# ${planned.note}`);
    if (planned.refusal !== undefined) {
      refusals.push(planned.refusal);
      lines.push(`# ${planned.refusal}`);
    }
    if (o.scope === 'project') lines.push('# Codex reads <project>/.codex/config.toml only when the project is trusted.');
  }
  return { text: `${lines.join('\n')}\n`, changes, commands, refusals };
}

export function planDiff(plan: InstallPlan): string {
  return plan.changes.map((c) => unifiedDiff(c.file, c.before, c.after)).join('');
}

export async function applyPlan(plan: InstallPlan): Promise<void> {
  if (plan.refusals.length > 0) throw new Error(`refusing to write: ${plan.refusals.join('; ')}`);
  for (const change of plan.changes) {
    if ((await readText(change.file)) !== change.before) throw new Error(`${change.file} changed after install planned the change; run install again`);
  }
  for (const change of plan.changes) {
    await mkdir(path.dirname(change.file), { recursive: true });
    await writeFile(change.file, change.after, 'utf8');
  }
}

export function parseInstallArgs(
  args: readonly string[],
  base: { readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>>; readonly home?: string },
): InstallOptions | Error {
  let host: InstallHost | undefined;
  let scope: InstallScope = 'user';
  let write = false;
  let local = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = (): string | undefined => inline ?? args[++i];
    switch (flag) {
      case '--host': {
        const v = z.enum(['claude', 'codex']).safeParse(value());
        if (!v.success) return new Error('--host must be claude or codex');
        host = v.data;
        break;
      }
      case '--scope': {
        const v = z.enum(['user', 'project']).safeParse(value());
        if (!v.success) return new Error('--scope must be user or project');
        scope = v.data;
        break;
      }
      case '--write':
        if (inline !== undefined) return new Error('--write does not take a value');
        write = true;
        break;
      case '--local':
        if (inline !== undefined) return new Error('--local does not take a value');
        local = true;
        break;
      default:
        return new Error(`unknown install option ${JSON.stringify(arg)}`);
    }
  }
  if (host === undefined) return new Error('install needs --host claude or --host codex');
  return { host, scope, write, local, cwd: base.cwd, env: base.env, home: base.home ?? os.homedir() };
}
