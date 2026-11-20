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
export type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';

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
  readonly allowedApprovalPolicies?: readonly ApprovalPolicy[];
  readonly allowManagedHooksOnly: boolean;
  /** Inline managed hooks (`[hooks]` of requirements.toml), as a TOML table. */
  readonly hooks?: TomlTable;
  /** Pinned feature flags (`[features]` of requirements.toml). */
  readonly features?: TomlTable;
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
  /** Names of the regular files in `dir` (symlinks not followed); [] when `dir` is missing; throws otherwise. */
  listFiles(dir: string): string[];
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
      const out = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(ppid)], { encoding: 'utf8', timeout: 2000 });
      return darwinArgv(out);
    }
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    return undefined;
  }
  return undefined;
}

/**
 * `ps` joins argv with spaces, so a value with spaces cannot be told apart
 * from further options. A Codex command line that sets permission options is
 * therefore refused rather than guessed.
 */
export function darwinArgv(psOutput: string): string[] {
  const argv = psOutput.trim().split(/\s+/);
  if (looksLikeCodex(argv) && argv.slice(1).some((a) => /^-(-(config|profile|ask-for-approval|sandbox|add-dir|enable|disable|dangerously|yolo|full-auto|approve-for-me)|[cpas])/.test(a))) {
    throw new ConfigError('the parent Codex command line sets permission options, which cannot be read exactly on macOS');
  }
  return argv;
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
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
        if (isMissing(err)) return undefined;
        throw new ConfigError(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    listFiles(dir) {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name);
      } catch (err) {
        if (isMissing(err)) return [];
        throw new ConfigError(`cannot list ${dir}: ${err instanceof Error ? err.message : String(err)}`);
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

/** Own property only (never `__proto__` or an inherited member). */
function own(t: TomlTable, k: string): unknown {
  return Object.hasOwn(t, k) ? t[k] : undefined;
}

function setOwn(t: TomlTable, k: string, v: unknown): void {
  Object.defineProperty(t, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/** Deep merge: tables merge recursively, everything else is replaced (Codex `merge_toml_values`). */
export function mergeTables(base: TomlTable, over: TomlTable): TomlTable {
  const out: TomlTable = {};
  for (const [k, v] of Object.entries(base)) setOwn(out, k, v);
  for (const [k, v] of Object.entries(over)) {
    const prev = own(out, k);
    setOwn(out, k, isTable(prev) && isTable(v) ? mergeTables(prev, v) : v);
  }
  return out;
}

/** Value at a dotted path. */
export function getPath(t: TomlTable, keys: readonly string[]): unknown {
  let cur: unknown = t;
  for (const k of keys) {
    if (!isTable(cur)) return undefined;
    cur = own(cur, k);
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

/** `-c` overrides in order: each one replaces the value at its path (Codex `apply_single_override`). */
function overridesTable(overrides: readonly (readonly [string, unknown])[]): TomlTable {
  const out: TomlTable = {};
  for (const [key, value] of overrides) {
    const parts = key.split('.');
    const leafKey = parts.pop() ?? '';
    let cur = out;
    for (const p of parts) {
      const next = own(cur, p);
      if (isTable(next)) cur = next;
      else {
        const t: TomlTable = {};
        setOwn(cur, p, t);
        cur = t;
      }
    }
    setOwn(cur, leafKey, value);
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
          if (!isApproval(value)) throw new ConfigError(`unsupported ${name} ${JSON.stringify(value)} on the Codex command line`);
          approvalPolicy = value;
          break;
        case '-s':
        case '--sandbox':
          if (!isSandboxMode(value)) throw new ConfigError(`unsupported ${name} ${JSON.stringify(value)} on the Codex command line`);
          sandboxMode = value;
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
    // Authorization options whose effect this adapter does not reproduce.
    else if (arg === '--approve-for-me' || arg === '--full-auto') throw new ConfigError(`${arg} on the Codex command line is not supported`);
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
  // `external-sandbox` is valid but never the mode of a session this adapter sees.
  allowed_sandbox_modes: z
    .array(z.enum(['read-only', 'workspace-write', 'danger-full-access', 'external-sandbox']))
    .refine((m) => m.includes('read-only'), 'allowed_sandbox_modes must include read-only')
    .optional(),
  // Granular approval entries are outside the supported subset.
  allowed_approval_policies: z.array(z.enum(['untrusted', 'on-failure', 'on-request', 'never'])).nonempty().optional(),
  allow_managed_hooks_only: z.boolean().optional(),
  hooks: z.record(z.string(), z.unknown()).optional(),
  features: z.record(z.string(), z.unknown()).optional(),
  feature_requirements: z.record(z.string(), z.unknown()).optional(),
});

/** Containment requirements of Codex 0.169 (`config_requirements.rs`) this adapter does not reproduce. */
const UNSUPPORTED_REQUIREMENTS = ['rules', 'allowed_permission_profiles', 'default_permissions', 'permissions', 'remote_sandbox_config', 'network_proxy', 'experimental_network'];

function loadRequirements(io: ConfigIo): Requirements | null {
  const file = path.join(io.systemDir, 'requirements.toml');
  const text = io.readFile(file);
  if (text === undefined) return null;
  const table = parseTomlFile(text, file);
  const unsupported = [...UNSUPPORTED_REQUIREMENTS, ...(io.platform === 'win32' ? ['windows'] : [])].find((k) => Object.hasOwn(table, k));
  if (unsupported !== undefined) throw new ConfigError(`${file}: the \`${unsupported}\` requirement is not supported`);
  const parsed = RequirementsSchema.safeParse(table);
  if (!parsed.success) throw new ConfigError(`unsupported ${file}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  const r = parsed.data;
  const hooks = r.hooks;
  if (hooks && ('managed_dir' in hooks || 'windows_managed_dir' in hooks)) throw new ConfigError(`${file}: hooks.managed_dir is not supported`);
  const features = r.features ?? r.feature_requirements;
  return {
    file,
    allowManagedHooksOnly: r.allow_managed_hooks_only ?? false,
    ...(r.allowed_sandbox_modes ? { allowedSandboxModes: r.allowed_sandbox_modes.filter(isSandboxMode) } : {}),
    ...(r.allowed_approval_policies ? { allowedApprovalPolicies: r.allowed_approval_policies } : {}),
    ...(hooks ? { hooks } : {}),
    ...(features ? { features } : {}),
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

/** Strips trailing separators of the platform (on POSIX a backslash is a file-name character). */
function stripTrailingSep(p: string, platform: NodeJS.Platform): string {
  return p.length > 1 ? p.replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '') : p;
}

function trustKeys(io: ConfigIo, dir: string): string[] {
  const keys = [stripTrailingSep(io.realpath(dir), io.platform), stripTrailingSep(dir, io.platform)];
  return [...new Set(keys)];
}

/**
 * The main repository of a linked git worktree, whose trust Codex reuses:
 * `<root>/.git` is a `gitdir: <common>/.git/worktrees/<name>` file and that
 * folder's `commondir` points back to `<common>/.git`.
 */
function linkedWorktreeMain(io: ConfigIo, root: string): string | undefined {
  const dotGit = path.join(root, '.git');
  if (io.isDir(dotGit)) return undefined;
  const gitdir = /^gitdir:\s*(.+?)\s*$/.exec(io.readFile(dotGit) ?? '')?.[1];
  if (gitdir === undefined) return undefined;
  const worktreeDir = io.realpath(path.resolve(root, gitdir));
  const commonRaw = io.readFile(path.join(worktreeDir, 'commondir'))?.trim();
  if (commonRaw === undefined || commonRaw === '') return undefined;
  const common = io.realpath(path.resolve(worktreeDir, commonRaw));
  const confirmed = path.dirname(path.dirname(worktreeDir)) === common && path.basename(path.dirname(worktreeDir)) === 'worktrees' && path.basename(common) === '.git';
  return confirmed ? path.dirname(common) : undefined;
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

const ProjectsSchema = z.record(z.string(), z.looseObject({ trust_level: z.enum(['trusted', 'untrusted']).optional() }));

function projectTrust(merged: TomlTable, platform: NodeJS.Platform): Map<string, string> {
  const parsed = ProjectsSchema.safeParse(own(merged, 'projects') ?? {});
  if (!parsed.success) throw new ConfigError(`invalid [projects] trust config: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(parsed.data)) if (v.trust_level !== undefined) out.set(stripTrailingSep(k, platform), v.trust_level);
  return out;
}

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined;
}

/** A boolean feature flag: config, then `--enable`/`--disable`, then the managed config and requirements, which win. */
function featureEnabled(merged: TomlTable, cmd: ParentCommandLine | null, pinned: readonly (TomlTable | undefined)[], name: string, aliases: readonly string[], dflt: boolean): boolean {
  let value = dflt;
  const apply = (features: TomlTable | undefined, where: string): void => {
    for (const key of [...aliases, name]) {
      const v = features === undefined ? undefined : own(features, key);
      if (v !== undefined && typeof v !== 'boolean') throw new ConfigError(`${where}.${key} must be a boolean`);
      if (v !== undefined) value = v;
    }
  };
  const features = own(merged, 'features');
  if (features !== undefined && !isTable(features)) throw new ConfigError('[features] must be a table');
  apply(features, 'features');
  if (cmd) {
    if (cmd.enable.some((f) => f === name || aliases.includes(f))) value = true;
    if (cmd.disable.some((f) => f === name || aliases.includes(f))) value = false;
  }
  for (const p of pinned) apply(p, 'managed features');
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
  // The managed config has the highest precedence, also for trust and the project root.
  const managedFile = path.join(io.systemDir, 'managed_config.toml');
  const managedText = io.readFile(managedFile);
  const managedConfig = managedText === undefined ? undefined : parseTomlFile(managedText, managedFile);
  const preProject = mergeTables(mergeTables(baseMerged, sessionFlags), managedConfig ?? {});

  // Project root: the nearest ancestor of cwd with a marker (default `.git`), else cwd.
  const rawMarkers = getPath(preProject, ['project_root_markers']);
  const markers = rawMarkers === undefined ? ['.git'] : stringArray(rawMarkers);
  if (markers === undefined) throw new ConfigError('project_root_markers must be a list of strings');
  const absCwd = path.resolve(cwd);
  const projectRoot = ancestors(absCwd).find((d) => markers.some((m) => io.exists(path.join(d, m)))) ?? absCwd;
  const trust = projectTrust(preProject, io.platform);
  const mainRepo = linkedWorktreeMain(io, projectRoot);
  const rootKeys = [...trustKeys(io, projectRoot), ...(mainRepo === undefined ? [] : trustKeys(io, mainRepo))];
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
  if (managedConfig !== undefined) layers.push({ source: 'managed', file: managedFile, folder: null, config: managedConfig, managed: true });
  if (io.platform === 'darwin') notes.push('macOS managed preferences (MDM) are not read');

  const merged = layers.reduce<TomlTable>((acc, l) => mergeTables(acc, l.config), {});
  const rawManagedFeatures = managedConfig === undefined ? undefined : own(managedConfig, 'features');
  if (rawManagedFeatures !== undefined && !isTable(rawManagedFeatures)) throw new ConfigError(`[features] in ${managedFile} must be a table`);
  const managedFeatures = isTable(rawManagedFeatures) ? rawManagedFeatures : undefined;

  if (own(merged, 'profile') !== undefined) throw new ConfigError('the `profile` config key is not supported by Codex 0.169 (use --profile)');
  if (own(merged, 'default_permissions') !== undefined || own(merged, 'permissions') !== undefined) {
    throw new ConfigError('permission profiles (`default_permissions`, `[permissions]`) are not supported');
  }

  // Sandbox mode and approval policy, command line first.
  let sandboxMode: SandboxMode = 'read-only';
  const cfgSandbox = own(merged, 'sandbox_mode');
  if (cfgSandbox !== undefined) {
    if (!isSandboxMode(cfgSandbox)) throw new ConfigError(`invalid sandbox_mode ${JSON.stringify(cfgSandbox)}`);
    sandboxMode = cfgSandbox;
  }
  // Codex asks for everything in a project explicitly marked untrusted unless a policy is set.
  let approvalPolicy: ApprovalPolicy = decide(absCwd) === 'untrusted' ? 'untrusted' : 'on-request';
  const cfgApproval = own(merged, 'approval_policy');
  if (cfgApproval !== undefined) {
    // Granular approval categories are not reproduced: refused rather than approximated.
    if (!isApproval(cfgApproval)) throw new ConfigError(`unsupported approval_policy ${JSON.stringify(cfgApproval)}`);
    approvalPolicy = cfgApproval;
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
  // Codex starts from the first allowed approval policy when the configured one is not allowed.
  const allowedApprovals = requirements?.allowedApprovalPolicies;
  if (allowedApprovals && !allowedApprovals.includes(approvalPolicy)) approvalPolicy = allowedApprovals[0] ?? approvalPolicy;

  const sww = own(merged, 'sandbox_workspace_write');
  if (sww !== undefined && !isTable(sww)) throw new ConfigError('[sandbox_workspace_write] must be a table');
  const swwTable = sww ?? {};
  const rawRoots = own(swwTable, 'writable_roots') === undefined ? [] : stringArray(own(swwTable, 'writable_roots'));
  if (rawRoots === undefined) throw new ConfigError('sandbox_workspace_write.writable_roots must be a list of strings');
  // Relative roots resolve against the folder of the config file that set them (the cwd for -c); --add-dir against the cwd.
  const rootsLayer = [...layers].reverse().find((l) => getPath(l.config, ['sandbox_workspace_write', 'writable_roots']) !== undefined);
  const rootsBase = rootsLayer === undefined || rootsLayer.source === 'session-flags' ? absCwd : path.dirname(rootsLayer.file);
  const expand = (base: string) => (r: string) => path.resolve(base, r.startsWith('~/') ? path.join(io.home, r.slice(2)) : r);
  const writableRoots = [...rawRoots.map(expand(rootsBase)), ...(cmdline?.addDirs ?? []).map(expand(absCwd))];
  const bool = (key: string): boolean => {
    const v = own(swwTable, key);
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
    hooksEnabled: featureEnabled(merged, cmdline, [managedFeatures, requirements?.features], 'hooks', ['codex_hooks'], true),
    bypassHookTrust: cmdline?.bypassHookTrust ?? false,
    notes,
  };
}

/**
 * Rule files of the active layers: the regular files `<folder>/rules/*.rules`
 * (not recursive, symlinks not followed). A missing `rules/` is empty; any
 * other listing error fails the load.
 */
export function ruleFiles(config: CodexConfig, io: ConfigIo): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const layer of config.layers) {
    if (layer.folder === null || seen.has(layer.folder)) continue;
    seen.add(layer.folder);
    const dir = path.join(layer.folder, 'rules');
    for (const name of io.listFiles(dir).sort()) if (name.endsWith('.rules')) out.push(path.join(dir, name));
  }
  return out;
}
