/**
 * Codex CLI configuration: config layers, project trust, command-line
 * overrides and the effective permission settings.
 *
 * Reference: openai/codex rust-v0.169.0 (commit d32063f96c2d):
 * `codex-rs/config/src/loader/mod.rs` (layers and project trust),
 * `config/src/merge.rs` (tables merge, arrays and scalars replace),
 * `config/src/project_root_markers.rs` (default marker `.git`),
 * `utils/cli/src/config_override.rs` (`-c key=value`),
 * `utils/cli/src/shared_options.rs` (`-p`, `-s`, bypass flags),
 * `utils/home-dir/src/lib.rs` (`CODEX_HOME`).
 *
 * Layers, lowest to highest precedence: `/etc/codex/config.toml`,
 * `$CODEX_HOME/config.toml`, `$CODEX_HOME/<profile>.config.toml` (only with
 * `--profile`), each trusted `<dir>/.codex/config.toml` from the project root
 * down to the cwd, `-c` overrides, `/etc/codex/managed_config.toml`.
 * Constraints come from `/etc/codex/requirements.toml`.
 *
 * Settings passed only on the parent Codex command line are read best-effort
 * from that command line (Linux `/proc`, macOS `ps`). Anything else that is
 * ephemeral (app-server thread overrides, cloud and MDM config, settings
 * changed inside a running TUI) is invisible to this server.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

export type TomlTable = { [key: string]: unknown };

export type LayerSource = 'system' | 'user' | 'profile' | 'project' | 'session-flags' | 'managed';

export interface ConfigLayer {
  readonly source: LayerSource;
  /** The config.toml path (synthetic for session flags). */
  readonly file: string;
  /** Folder holding the layer's `hooks.json` and `rules/`, when it has one. */
  readonly folder: string | null;
  readonly config: TomlTable;
  /** Managed layers (system, managed config) run their hooks without user trust. */
  readonly managed: boolean;
}

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never' | 'granular';

/** What could be read from the parent Codex command line. */
export interface ParentCommandLine {
  readonly overrides: readonly (readonly [key: string, value: unknown])[];
  readonly profile?: string;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly sandboxMode?: SandboxMode;
  readonly enable: readonly string[];
  readonly disable: readonly string[];
  readonly addDirs: readonly string[];
  readonly bypassApprovalsAndSandbox: boolean;
  readonly bypassHookTrust: boolean;
  /** `codex exec` defaults the approval policy to `never`. */
  readonly exec: boolean;
}

export interface Requirements {
  readonly allowedSandboxModes?: readonly SandboxMode[];
  readonly allowedApprovalPolicies?: readonly string[];
  readonly allowManagedHooksOnly: boolean;
  /** Inline managed hooks (`[hooks]` of requirements.toml), as a TOML table. */
  readonly hooks?: TomlTable;
  readonly file: string;
}

export interface CodexConfig {
  readonly codexHome: string;
  readonly cwd: string;
  readonly projectRoot: string;
  /** Active layers, lowest precedence first. */
  readonly layers: readonly ConfigLayer[];
  /** Project `.codex` folders skipped because the project is not trusted. */
  readonly untrustedProjectFolders: readonly string[];
  readonly merged: TomlTable;
  readonly requirements: Requirements | null;
  readonly cmdline: ParentCommandLine | null;
  /** Effective sandbox mode from config and command line (the turn metadata wins over it). */
  readonly sandboxMode: SandboxMode;
  readonly approvalPolicy: ApprovalPolicy;
  readonly writableRoots: readonly string[];
  readonly networkAccess: boolean;
  readonly excludeTmpdirEnvVar: boolean;
  readonly excludeSlashTmp: boolean;
  readonly hooksEnabled: boolean;
  readonly bypassHookTrust: boolean;
  /** Notes about what could not be seen. */
  readonly notes: readonly string[];
}

/** Filesystem and process access, injectable for tests. */
export interface ConfigIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly systemDir: string;
  readFile(file: string): string | undefined;
  isDir(dir: string): boolean;
  exists(p: string): boolean;
  realpath(p: string): string;
  listDir(dir: string): string[];
  /** The parent Codex process argv, or undefined when it cannot be read. */
  parentArgv(): readonly string[] | undefined;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function readParentArgv(platform: NodeJS.Platform): readonly string[] | undefined {
  const ppid = process.ppid;
  try {
    if (platform === 'linux') {
      const raw = readFileSync(`/proc/${ppid}/cmdline`, 'utf8');
      return raw.split('\0').filter((s, i, all) => s !== '' || i < all.length - 1);
    }
    if (platform === 'darwin') {
      // Best effort: `ps` joins argv with spaces, so quoted values with spaces are mis-split.
      const out = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(ppid)], { encoding: 'utf8', timeout: 2000 });
      return out.trim().split(/\s+/);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Real filesystem and process access. */
export function nodeConfigIo(env: Readonly<Record<string, string | undefined>> = process.env): ConfigIo {
  return {
    env,
    home: os.homedir(),
    platform: process.platform,
    systemDir: process.platform === 'win32' ? path.join(env['ProgramData'] ?? 'C:\\ProgramData', 'OpenAI', 'Codex') : '/etc/codex',
    readFile(file) {
      try {
        return readFileSync(file, 'utf8');
      } catch (err) {
        if (err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return undefined;
        throw new ConfigError(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    isDir(dir) {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    },
    exists: (p) => existsSync(p),
    realpath(p) {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    },
    listDir(dir) {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    parentArgv: () => readParentArgv(process.platform),
  };
}

// ---------------------------------------------------------------------------
// TOML helpers.
// ---------------------------------------------------------------------------

export function isTable(v: unknown): v is TomlTable {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function parseTomlFile(text: string, file: string): TomlTable {
  try {
    const parsed: unknown = parseToml(text);
    if (!isTable(parsed)) throw new ConfigError(`${file}: not a TOML table`);
    return parsed;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`invalid TOML in ${file}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

/** Deep merge: tables merge recursively, everything else is replaced (Codex `merge_toml_values`). */
export function mergeTables(base: TomlTable, over: TomlTable): TomlTable {
  const out: TomlTable = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const prev = out[k];
    out[k] = isTable(prev) && isTable(v) ? mergeTables(prev, v) : v;
  }
  return out;
}

/** Value at a dotted path. */
export function getPath(t: TomlTable, keys: readonly string[]): unknown {
  let cur: unknown = t;
  for (const k of keys) {
    if (!isTable(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Parses a `-c key=value` override like Codex: the value as TOML, else the raw string. */
export function parseOverride(raw: string): readonly [string, unknown] | undefined {
  const eq = raw.indexOf('=');
  if (eq <= 0) return undefined;
  const key = raw.slice(0, eq).trim();
  const valueText = raw.slice(eq + 1).trim();
  if (key === '') return undefined;
  let value: unknown = valueText;
  try {
    const parsed: unknown = parseToml(`_x_ = ${valueText}`);
    if (isTable(parsed) && '_x_' in parsed) value = parsed['_x_'];
  } catch {
    // Not a TOML value: keep the string, like Codex.
  }
  return [key, value];
}

function overridesTable(overrides: readonly (readonly [string, unknown])[]): TomlTable {
  let out: TomlTable = {};
  for (const [key, value] of overrides) {
    const parts = key.split('.');
    let leaf: unknown = value;
    for (let i = parts.length - 1; i >= 0; i--) leaf = { [parts[i] ?? '']: leaf };
    if (isTable(leaf)) out = mergeTables(out, leaf);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parent command line.
// ---------------------------------------------------------------------------

const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVALS: readonly ApprovalPolicy[] = ['untrusted', 'on-failure', 'on-request', 'never'];
const VALUE_OPTIONS = new Set(['-c', '--config', '-p', '--profile', '-a', '--ask-for-approval', '-s', '--sandbox', '-m', '--model', '-C', '--cd', '-i', '--image', '--enable', '--disable', '--local-provider', '--add-dir', '--output-schema', '-o', '--output-last-message', '--color']);

function isSandboxMode(v: unknown): v is SandboxMode {
  return typeof v === 'string' && (SANDBOX_MODES as readonly string[]).includes(v);
}

function isApproval(v: unknown): v is ApprovalPolicy {
  return typeof v === 'string' && (APPROVALS as readonly string[]).includes(v);
}

/** Reads the options Codex accepts on its command line that change permissions. */
export function parseParentCommandLine(argv: readonly string[]): ParentCommandLine {
  const overrides: (readonly [string, unknown])[] = [];
  const enable: string[] = [];
  const disable: string[] = [];
  const addDirs: string[] = [];
  let profile: string | undefined;
  let approvalPolicy: ApprovalPolicy | undefined;
  let sandboxMode: SandboxMode | undefined;
  let bypassApprovalsAndSandbox = false;
  let bypassHookTrust = false;
  let exec = false;
  let sawSubcommand = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--') break;
    let name = arg;
    let value: string | undefined;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      name = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    } else if (/^-[cpasmCi].+/.test(arg) && !arg.startsWith('--')) {
      name = arg.slice(0, 2);
      value = arg.slice(2).replace(/^=/, '');
    }
    if (VALUE_OPTIONS.has(name)) {
      if (value === undefined) {
        value = argv[i + 1];
        i++;
      }
      if (value === undefined) break;
      switch (name) {
        case '-c':
        case '--config': {
          const o = parseOverride(value);
          if (o) overrides.push(o);
          break;
        }
        case '-p':
        case '--profile':
          profile = value;
          break;
        case '-a':
        case '--ask-for-approval':
          if (isApproval(value)) approvalPolicy = value;
          break;
        case '-s':
        case '--sandbox':
          if (isSandboxMode(value)) sandboxMode = value;
          break;
        case '--enable':
          enable.push(value);
          break;
        case '--disable':
          disable.push(value);
          break;
        case '--add-dir':
          addDirs.push(value);
          break;
        default:
          break;
      }
      continue;
    }
    if (arg === '--dangerously-bypass-approvals-and-sandbox' || arg === '--yolo') bypassApprovalsAndSandbox = true;
    else if (arg === '--dangerously-bypass-hook-trust') bypassHookTrust = true;
    else if (!arg.startsWith('-') && !sawSubcommand) {
      sawSubcommand = true;
      exec = arg === 'exec' || arg === 'e';
    }
  }
  return {
    overrides,
    ...(profile === undefined ? {} : { profile }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
    ...(sandboxMode === undefined ? {} : { sandboxMode }),
    enable,
    disable,
    addDirs,
    bypassApprovalsAndSandbox,
    bypassHookTrust,
    exec,
  };
}

/** Whether argv looks like a Codex CLI process (the binary or its launcher). */
function looksLikeCodex(argv: readonly string[]): boolean {
  return argv.slice(0, 3).some((a) => /(^|[\\/])codex(\.exe|\.js)?$/.test(a));
}

// ---------------------------------------------------------------------------
// Requirements.
// ---------------------------------------------------------------------------

const RequirementsSchema = z.looseObject({
  allowed_sandbox_modes: z.array(z.enum(['read-only', 'workspace-write', 'danger-full-access'])).optional(),
  allowed_approval_policies: z.array(z.string()).optional(),
  allow_managed_hooks_only: z.boolean().optional(),
  hooks: z.record(z.string(), z.unknown()).optional(),
  rules: z.unknown().optional(),
});

function loadRequirements(io: ConfigIo): Requirements | null {
  const file = path.join(io.systemDir, 'requirements.toml');
  const text = io.readFile(file);
  if (text === undefined) return null;
  const parsed = RequirementsSchema.safeParse(parseTomlFile(text, file));
  if (!parsed.success) throw new ConfigError(`unsupported ${file}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  const r = parsed.data;
  if (r.rules !== undefined) throw new ConfigError(`${file}: [rules] requirements are not supported`);
  const hooks = r.hooks;
  if (hooks && ('managed_dir' in hooks || 'windows_managed_dir' in hooks)) throw new ConfigError(`${file}: hooks.managed_dir is not supported`);
  return {
    file,
    allowManagedHooksOnly: r.allow_managed_hooks_only ?? false,
    ...(r.allowed_sandbox_modes ? { allowedSandboxModes: r.allowed_sandbox_modes } : {}),
    ...(r.allowed_approval_policies ? { allowedApprovalPolicies: r.allowed_approval_policies } : {}),
    ...(hooks ? { hooks } : {}),
  };
}

// ---------------------------------------------------------------------------
// Loading.
// ---------------------------------------------------------------------------

function resolveCodexHome(io: ConfigIo): string {
  const raw = io.env['CODEX_HOME'];
  if (raw !== undefined && raw.trim() !== '') {
    if (!path.isAbsolute(raw)) throw new ConfigError('CODEX_HOME must be an absolute path');
    if (!io.isDir(raw)) throw new ConfigError(`CODEX_HOME ${raw} does not exist`);
    return io.realpath(raw);
  }
  return path.join(io.home, '.codex');
}

function stripTrailingSep(p: string): string {
  return p.length > 1 ? p.replace(/[\\/]+$/, '') : p;
}

function trustKeys(io: ConfigIo, dir: string): string[] {
  const keys = [stripTrailingSep(io.realpath(dir)), stripTrailingSep(dir)];
  return [...new Set(keys)];
}

function ancestors(dir: string): string[] {
  const out: string[] = [];
  let cur = path.resolve(dir);
  for (;;) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) return out;
    cur = parent;
  }
}

const ProjectsSchema = z.record(z.string(), z.looseObject({ trust_level: z.string().optional() }).catch({}));

function projectTrust(merged: TomlTable): Map<string, string> {
  const parsed = ProjectsSchema.safeParse(merged['projects'] ?? {});
  const out = new Map<string, string>();
  if (!parsed.success) return out;
  for (const [k, v] of Object.entries(parsed.data)) if (v.trust_level !== undefined) out.set(stripTrailingSep(k), v.trust_level);
  return out;
}

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined;
}

function featureEnabled(merged: TomlTable, cmd: ParentCommandLine | null, name: string, aliases: readonly string[], dflt: boolean): boolean {
  let value = dflt;
  const features = merged['features'];
  if (isTable(features)) {
    for (const key of [...aliases, name]) {
      const v = features[key];
      if (typeof v === 'boolean') value = v;
    }
  }
  if (cmd) {
    if (cmd.enable.some((f) => f === name || aliases.includes(f))) value = true;
    if (cmd.disable.some((f) => f === name || aliases.includes(f))) value = false;
  }
  return value;
}

/**
 * Loads the Codex configuration that applies to `cwd`. Throws `ConfigError`
 * on anything that cannot be understood (invalid TOML in an active layer,
 * unsupported settings).
 */
export function loadCodexConfig(cwd: string, io: ConfigIo): CodexConfig {
  const notes: string[] = [];
  const codexHome = resolveCodexHome(io);
  const requirements = loadRequirements(io);

  let cmdline: ParentCommandLine | null = null;
  const argv = io.parentArgv();
  if (argv && looksLikeCodex(argv)) cmdline = parseParentCommandLine(argv);
  else notes.push('the parent Codex command line could not be read: -c, --profile, -s and -a given there are not visible');

  const layers: ConfigLayer[] = [];
  const addFileLayer = (source: LayerSource, file: string, folder: string | null, managed: boolean, required = false): void => {
    const text = io.readFile(file);
    if (text === undefined) {
      if (required) throw new ConfigError(`${file} does not exist`);
      return;
    }
    layers.push({ source, file, folder, config: parseTomlFile(text, file), managed });
  };

  addFileLayer('system', path.join(io.systemDir, 'config.toml'), io.systemDir, true);
  // The system folder has hooks.json and rules/ even without a config.toml.
  if (!layers.some((l) => l.source === 'system') && io.isDir(io.systemDir)) {
    layers.push({ source: 'system', file: path.join(io.systemDir, 'config.toml'), folder: io.systemDir, config: {}, managed: true });
  }
  const userFile = path.join(codexHome, 'config.toml');
  addFileLayer('user', userFile, codexHome, false);
  if (!layers.some((l) => l.source === 'user')) layers.push({ source: 'user', file: userFile, folder: codexHome, config: {}, managed: false });
  if (cmdline?.profile !== undefined) {
    if (!/^[A-Za-z0-9_-]+$/.test(cmdline.profile)) throw new ConfigError(`invalid profile name ${JSON.stringify(cmdline.profile)}`);
    addFileLayer('profile', path.join(codexHome, `${cmdline.profile}.config.toml`), null, false, true);
  }

  const baseMerged = layers.reduce<TomlTable>((acc, l) => mergeTables(acc, l.config), {});
  const sessionFlags = overridesTable(cmdline?.overrides ?? []);
  const preProject = mergeTables(baseMerged, sessionFlags);

  // Project root: the nearest ancestor of cwd with a marker (default `.git`), else cwd.
  const markers = stringArray(getPath(preProject, ['project_root_markers'])) ?? ['.git'];
  const absCwd = path.resolve(cwd);
  const projectRoot = ancestors(absCwd).find((d) => markers.some((m) => io.exists(path.join(d, m)))) ?? absCwd;
  const trust = projectTrust(preProject);
  const rootKeys = trustKeys(io, projectRoot);
  const decide = (dir: string): string | undefined => {
    for (const key of [...trustKeys(io, dir), ...rootKeys]) {
      const level = trust.get(key);
      if (level !== undefined) return level;
    }
    return undefined;
  };

  const untrustedProjectFolders: string[] = [];
  const homeReal = io.realpath(codexHome);
  const dirs = ancestors(absCwd);
  const rootIndex = dirs.indexOf(projectRoot);
  const projectDirs = (rootIndex >= 0 ? dirs.slice(0, rootIndex + 1) : [absCwd]).reverse();
  for (const dir of projectDirs) {
    const dotCodex = path.join(dir, '.codex');
    if (!io.isDir(dotCodex)) continue;
    if (dotCodex === codexHome || io.realpath(dotCodex) === homeReal) continue;
    if (decide(dir) !== 'trusted') {
      untrustedProjectFolders.push(dotCodex);
      continue;
    }
    const file = path.join(dotCodex, 'config.toml');
    const text = io.readFile(file);
    layers.push({ source: 'project', file, folder: dotCodex, config: text === undefined ? {} : parseTomlFile(text, file), managed: false });
  }
  if (untrustedProjectFolders.length > 0) notes.push(`untrusted project config ignored: ${untrustedProjectFolders.join(', ')}`);

  if (Object.keys(sessionFlags).length > 0) {
    layers.push({ source: 'session-flags', file: '<session-flags>/config.toml', folder: null, config: sessionFlags, managed: false });
  }
  addFileLayer('managed', path.join(io.systemDir, 'managed_config.toml'), null, true);
  if (io.platform === 'darwin') notes.push('macOS managed preferences (MDM) are not read');

  const merged = layers.reduce<TomlTable>((acc, l) => mergeTables(acc, l.config), {});

  if (merged['profile'] !== undefined) throw new ConfigError('the `profile` config key is not supported by Codex 0.169 (use --profile)');
  if (merged['default_permissions'] !== undefined || merged['permissions'] !== undefined) {
    throw new ConfigError('permission profiles (`default_permissions`, `[permissions]`) are not supported');
  }

  // Sandbox mode and approval policy, command line first.
  let sandboxMode: SandboxMode = 'read-only';
  const cfgSandbox = merged['sandbox_mode'];
  if (cfgSandbox !== undefined) {
    if (!isSandboxMode(cfgSandbox)) throw new ConfigError(`invalid sandbox_mode ${JSON.stringify(cfgSandbox)}`);
    sandboxMode = cfgSandbox;
  }
  let approvalPolicy: ApprovalPolicy = 'on-request';
  const cfgApproval = merged['approval_policy'];
  if (cfgApproval !== undefined) {
    if (isTable(cfgApproval) && 'granular' in cfgApproval) approvalPolicy = 'granular';
    else if (isApproval(cfgApproval)) approvalPolicy = cfgApproval;
    else throw new ConfigError(`invalid approval_policy ${JSON.stringify(cfgApproval)}`);
  }
  if (cmdline) {
    if (cmdline.exec) approvalPolicy = 'never';
    if (cmdline.sandboxMode) sandboxMode = cmdline.sandboxMode;
    if (cmdline.approvalPolicy) approvalPolicy = cmdline.approvalPolicy;
    if (cmdline.bypassApprovalsAndSandbox) {
      sandboxMode = 'danger-full-access';
      approvalPolicy = 'never';
    }
  }
  if (requirements?.allowedSandboxModes && !requirements.allowedSandboxModes.includes(sandboxMode)) {
    const allowed = SANDBOX_MODES.find((m) => requirements.allowedSandboxModes?.includes(m));
    if (allowed === undefined) throw new ConfigError('requirements allow no sandbox mode');
    sandboxMode = allowed;
  }

  const sww = merged['sandbox_workspace_write'];
  const swwTable = isTable(sww) ? sww : {};
  const rawRoots = swwTable['writable_roots'] === undefined ? [] : stringArray(swwTable['writable_roots']);
  if (rawRoots === undefined) throw new ConfigError('sandbox_workspace_write.writable_roots must be a list of strings');
  const writableRoots = [...rawRoots, ...(cmdline?.addDirs ?? [])].map((r) => path.resolve(absCwd, r.startsWith('~/') ? path.join(io.home, r.slice(2)) : r));
  const bool = (key: string): boolean => {
    const v = swwTable[key];
    if (v === undefined) return false;
    if (typeof v !== 'boolean') throw new ConfigError(`sandbox_workspace_write.${key} must be a boolean`);
    return v;
  };

  return {
    codexHome,
    cwd: absCwd,
    projectRoot,
    layers,
    untrustedProjectFolders,
    merged,
    requirements,
    cmdline,
    sandboxMode,
    approvalPolicy,
    writableRoots,
    networkAccess: bool('network_access'),
    excludeTmpdirEnvVar: bool('exclude_tmpdir_env_var'),
    excludeSlashTmp: bool('exclude_slash_tmp'),
    hooksEnabled: featureEnabled(merged, cmdline, 'hooks', ['codex_hooks'], true),
    bypassHookTrust: cmdline?.bypassHookTrust ?? false,
    notes,
  };
}

/** Rule files of the active layers: `<folder>/rules/*.rules`, not recursive. */
export function ruleFiles(config: CodexConfig, io: ConfigIo): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const layer of config.layers) {
    if (layer.folder === null || seen.has(layer.folder)) continue;
    seen.add(layer.folder);
    const dir = path.join(layer.folder, 'rules');
    for (const name of io.listDir(dir).sort()) if (name.endsWith('.rules')) out.push(path.join(dir, name));
  }
  return out;
}
