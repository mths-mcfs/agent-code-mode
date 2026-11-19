import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { errorMessage } from '../../core/errors.js';
import type { ClaudeCliFlags } from './parent-args.js';
import { splitToolList, type RuleSourceName } from './rules.js';

/**
 * Claude Code settings files, read and validated at the boundary.
 *
 * Sources (https://code.claude.com/docs/en/settings), highest precedence first:
 * managed (`managed-settings.json` + `managed-settings.d/*.json`), command
 * line (`--settings`, `--allowedTools`, ...), local
 * (`.claude/settings.local.json`), project (`.claude/settings.json`), user
 * (`$CLAUDE_CONFIG_DIR/settings.json` or `~/.claude/settings.json`).
 * Permission rules from every source are combined (deny anywhere wins);
 * scalar settings take the value of the highest source that sets it.
 *
 * Anything that changes authorization and does not validate fails the load:
 * invalid JSON, a wrong type in `permissions`, `hooks.PreToolUse`,
 * `hooks.PostToolUse`, `sandbox`, or a hook handler we cannot read. Unknown
 * keys are kept and ignored.
 */

const stringList = z.array(z.string());

export const HookHandlerSchema = z.looseObject({
  type: z.string(),
  command: z.string().optional(),
  args: stringList.optional(),
  timeout: z.number().positive().optional(),
  if: z.string().optional(),
  async: z.boolean().optional(),
  asyncRewake: z.boolean().optional(),
  shell: z.string().optional(),
  onFailure: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  allowedEnvVars: stringList.optional(),
});
export type HookHandler = z.infer<typeof HookHandlerSchema>;

export const HookMatcherSchema = z.looseObject({
  matcher: z.string().optional(),
  hooks: z.array(HookHandlerSchema),
});
export type HookMatcherEntry = z.infer<typeof HookMatcherSchema>;

export const HooksSchema = z.looseObject({
  PreToolUse: z.array(HookMatcherSchema).optional(),
  PostToolUse: z.array(HookMatcherSchema).optional(),
});

export const SettingsSchema = z.looseObject({
  permissions: z
    .looseObject({
      allow: stringList.optional(),
      ask: stringList.optional(),
      deny: stringList.optional(),
      additionalDirectories: stringList.optional(),
      defaultMode: z.enum(['default', 'manual', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions']).optional(),
      disableBypassPermissionsMode: z.literal('disable').optional(),
      disableAutoMode: z.literal('disable').optional(),
      blockReadsOutsideWorkingDirectories: z.boolean().optional(),
      blockWritesOutsideWorkingDirectories: z.boolean().optional(),
    })
    .optional(),
  hooks: HooksSchema.optional(),
  disableAllHooks: z.boolean().optional(),
  allowManagedHooksOnly: z.boolean().optional(),
  allowManagedPermissionRulesOnly: z.boolean().optional(),
  disableCommandPluginSources: z.boolean().optional(),
  allowedHttpHookUrls: stringList.optional(),
  httpHookAllowedEnvVars: stringList.optional(),
  enabledPlugins: z.record(z.string(), z.boolean()).optional(),
  sandbox: z
    .looseObject({
      enabled: z.boolean().optional(),
      filesystem: z
        .looseObject({
          allowWrite: stringList.optional(),
          denyWrite: stringList.optional(),
          denyRead: stringList.optional(),
          allowRead: stringList.optional(),
          disabled: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** One loaded settings document. */
export interface SettingsDoc {
  readonly source: RuleSourceName;
  /** File it came from; undefined for inline `--settings` JSON and CLI flags. */
  readonly file: string | undefined;
  /** Anchor of `/path` rules from this source. */
  readonly anchorDir: string;
  readonly data: Settings;
}

/** Hooks of an enabled plugin. */
export interface PluginHooks {
  readonly plugin: string;
  readonly root: string;
  readonly hooks: z.infer<typeof HooksSchema>;
}

/** Which hooks run (https://code.claude.com/docs/en/hooks#hook-locations), resolved once from every source. */
function hookControls(docs: readonly SettingsDoc[]) {
  const managed = docs.filter((d) => d.source === 'managed');
  const managedHooksOnly = firstSetting(managed, (s) => s.allowManagedHooksOnly) === true;
  const commandSources = firstSetting(managed, (s) => s.disableCommandPluginSources);
  return {
    /** Managed `disableAllHooks`: no hook runs. */
    allOff: firstSetting(managed, (s) => s.disableAllHooks) === true,
    /** Only managed hooks and plugins managed settings enable run. */
    managedOnly: managedHooksOnly || firstSetting(docs.filter((d) => d.source !== 'managed'), (s) => s.disableAllHooks) === true,
    /** Command-sourced plugins are disabled (unset under `allowManagedHooksOnly`): a plugin's source, not recorded here, cannot be verified. */
    commandPluginsBlocked: commandSources === true || (commandSources === undefined && managedHooksOnly),
  };
}

export interface LoadedSettings {
  /** Highest precedence first. */
  readonly docs: readonly SettingsDoc[];
  readonly plugins: readonly PluginHooks[];
  readonly hookControls: ReturnType<typeof hookControls>;
  /** Whether project (and repository-supplied local) allow rules and additional directories apply. */
  readonly projectTrusted: boolean;
}

export interface SettingsLocations {
  /** The session's primary directory: holds project and local settings and anchors their `/path` rules. */
  readonly projectRoot: string;
  readonly home: string;
  /** `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  readonly configDir: string;
  /** Managed settings directory (holds `managed-settings.json` and `managed-settings.d`). */
  readonly managedDir: string | undefined;
}

/** Managed settings directory for a platform, as documented. */
export function managedSettingsDir(platform: NodeJS.Platform = process.platform): string | undefined {
  switch (platform) {
    case 'linux':
      return '/etc/claude-code';
    case 'darwin':
      return '/Library/Application Support/ClaudeCode';
    case 'win32':
      return 'C:\\Program Files\\ClaudeCode';
    default:
      return undefined;
  }
}

/** `$CLAUDE_CONFIG_DIR` when absolute, else `~/.claude`. */
export function claudeConfigDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const dir = env['CLAUDE_CONFIG_DIR'];
  return dir !== undefined && dir !== '' && path.isAbsolute(dir) ? dir : path.join(home, '.claude');
}

class SettingsError extends Error {}

/** Largest settings, plugin or git metadata file read. */
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;

/** Reads a regular file of at most `MAX_SETTINGS_BYTES`; undefined when it does not exist. */
async function readOptional(file: string): Promise<string | undefined> {
  let handle;
  try {
    // Non-blocking open: a FIFO under the name cannot stall the load.
    handle = await open(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK));
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return undefined;
    throw new SettingsError(`cannot read ${file}: ${errorMessage(err)}`);
  }
  try {
    if (!(await handle.stat()).isFile()) throw new SettingsError(`${file} is not a regular file`);
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > MAX_SETTINGS_BYTES) throw new SettingsError(`${file} is larger than ${MAX_SETTINGS_BYTES} bytes`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    throw err instanceof SettingsError ? err : new SettingsError(`cannot read ${file}: ${errorMessage(err)}`);
  } finally {
    await handle.close();
  }
}

function parseSettingsText(text: string, where: string): Settings {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new SettingsError(`${where} is not valid JSON: ${errorMessage(err)}`);
  }
  const parsed = SettingsSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SettingsError(`${where} has an invalid value at ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}`);
  }
  return parsed.data;
}

async function readSettingsFile(file: string, source: RuleSourceName, anchorDir: string): Promise<SettingsDoc | undefined> {
  const text = await readOptional(file);
  if (text === undefined) return undefined;
  return { source, file, anchorDir, data: parseSettingsText(text, file) };
}

async function readManaged(dir: string, projectRoot: string): Promise<SettingsDoc[]> {
  const docs: SettingsDoc[] = [];
  const base = await readSettingsFile(path.join(dir, 'managed-settings.json'), 'managed', projectRoot);
  if (base) docs.push(base);
  const dropDir = path.join(dir, 'managed-settings.d');
  let names: string[];
  try {
    names = await readdir(dropDir);
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) names = [];
    else throw new SettingsError(`cannot read ${dropDir}: ${errorMessage(err)}`);
  }
  // Drop-ins apply in alphabetical order, later files on top: highest precedence first means reverse order.
  const files = names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  const drops: SettingsDoc[] = [];
  for (const name of files) {
    const doc = await readSettingsFile(path.join(dropDir, name), 'managed', projectRoot);
    if (doc) drops.push(doc);
  }
  return [...drops.reverse(), ...docs];
}

/** Settings documents from command-line flags. */
async function readFlagSettings(flags: ClaudeCliFlags, parentCwd: string | undefined, projectRoot: string): Promise<SettingsDoc[]> {
  const docs: SettingsDoc[] = [];
  for (const value of [...flags.settings].reverse()) {
    const trimmed = value.trim();
    if (trimmed.startsWith('{')) {
      docs.push({ source: 'flag-settings', file: undefined, anchorDir: projectRoot, data: parseSettingsText(trimmed, '--settings JSON') });
      continue;
    }
    let file = trimmed;
    if (!path.isAbsolute(file)) {
      if (parentCwd === undefined) throw new SettingsError(`--settings ${JSON.stringify(value)} is relative and the Claude process cwd is unknown`);
      file = path.resolve(parentCwd, file);
    }
    const doc = await readSettingsFile(file, 'flag-settings', path.dirname(file));
    if (!doc) throw new SettingsError(`--settings file ${file} does not exist`);
    docs.push(doc);
  }
  if (flags.allowedTools.length > 0 || flags.disallowedTools.length > 0) {
    docs.push({
      source: 'cli',
      file: undefined,
      anchorDir: projectRoot,
      data: {
        permissions: {
          allow: flags.allowedTools.flatMap(splitToolList),
          deny: flags.disallowedTools.flatMap(splitToolList),
          ...(flags.addDirs.length > 0 ? { additionalDirectories: [...flags.addDirs] } : {}),
        },
      },
    });
  } else if (flags.addDirs.length > 0) {
    docs.push({ source: 'cli', file: undefined, anchorDir: projectRoot, data: { permissions: { additionalDirectories: [...flags.addDirs] } } });
  }
  return docs;
}

const TrustFileSchema = z.looseObject({
  projects: z.record(z.string(), z.looseObject({ hasTrustDialogAccepted: z.boolean().optional() }).catch({})).optional().catch(undefined),
});

/** The git checkout holding `dir` and its main checkout: itself, or for a linked worktree the verified one. */
async function gitLayout(dir: string): Promise<{ readonly root: string | undefined; readonly main: string | undefined }> {
  for (let i = 0; i < 64; i++) {
    const dotGit = path.join(dir, '.git');
    const st = await stat(dotGit).catch(() => undefined);
    if (st) return { root: dir, main: st.isFile() ? await verifiedMainCheckout(dotGit) : dir };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: undefined, main: undefined };
}

/**
 * The main checkout, where Claude keeps a subdirectory or worktree session's local file; undefined
 * at home, on Windows, or when the checkout, its `.git` or `.claude` is not owned by this user.
 */
async function localSettingsRoot(main: string | undefined, home: string): Promise<string | undefined> {
  const uid = process.getuid?.();
  if (main === undefined || uid === undefined || path.resolve(main) === path.resolve(home)) return undefined;
  for (const p of [main, path.join(main, '.git'), path.join(main, '.claude')]) {
    const st = await lstat(p).catch(() => undefined);
    if (st !== undefined && st.uid !== uid) return undefined;
  }
  return main;
}

/**
 * A linked worktree's main checkout, only when git metadata agrees both ways and is this user's: the `.git`
 * file (not a link) names `<main>/.git/worktrees/<name>`, a directory of this user whose `gitdir` file (not a
 * link) points back at that very `.git` file, and `<main>/.git` is a directory of this user. Never on Windows.
 */
async function verifiedMainCheckout(dotGit: string): Promise<string | undefined> {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  try {
    const self = await lstat(dotGit);
    if (!self.isFile() || self.uid !== uid) return undefined;
    const m = /^gitdir:\s*(.+)$/m.exec((await readOptional(dotGit)) ?? '');
    if (!m?.[1]) return undefined;
    const gitdir = await realpath(path.resolve(path.dirname(dotGit), m[1].trim()));
    const at = gitdir.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
    const st = await lstat(gitdir);
    if (at === -1 || !st.isDirectory() || st.uid !== uid) return undefined;
    const backFile = path.join(gitdir, 'gitdir');
    const backSt = await lstat(backFile);
    if (!backSt.isFile() || backSt.uid !== uid) return undefined;
    const back = ((await readOptional(backFile)) ?? '').trim();
    if (back === '') return undefined;
    // The backlink names this workspace's own `.git` entry: the same file, not a link to it or a copy.
    const named = await lstat(path.resolve(gitdir, back));
    if (!named.isFile() || named.dev !== self.dev || named.ino !== self.ino) return undefined;
    const main = gitdir.slice(0, at);
    const mainGit = await lstat(path.join(main, '.git'));
    return mainGit.isDirectory() && mainGit.uid === uid ? main : undefined;
  } catch {
    return undefined;
  }
}

async function isProjectTrusted(trustKeys: readonly string[], home: string, env: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  const configDir = env['CLAUDE_CONFIG_DIR'];
  const trustFile = configDir !== undefined && configDir !== '' && path.isAbsolute(configDir) ? path.join(configDir, '.claude.json') : path.join(home, '.claude.json');
  let text: string | undefined;
  try {
    text = await readOptional(trustFile);
  } catch {
    return false;
  }
  if (text === undefined) return false;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return false;
  }
  const parsed = TrustFileSchema.safeParse(json);
  if (!parsed.success || !parsed.data.projects) return false;
  const projects = parsed.data.projects;
  for (const key of trustKeys) {
    if (projects[key]?.hasTrustDialogAccepted === true) return true;
  }
  return false;
}

const InstalledPluginsSchema = z.looseObject({
  plugins: z.record(z.string(), z.array(z.looseObject({ installPath: z.string() }))),
});

const PluginHooksFileSchema = z.looseObject({ hooks: HooksSchema });

const PluginManifestSchema = z.looseObject({ hooks: z.unknown().optional() });

async function readPluginHooks(enabled: readonly string[], configDir: string): Promise<PluginHooks[]> {
  if (enabled.length === 0) return [];
  const indexFile = path.join(configDir, 'plugins', 'installed_plugins.json');
  const text = await readOptional(indexFile);
  if (text === undefined) return []; // nothing installed: enabled names load nothing natively either
  let index: z.infer<typeof InstalledPluginsSchema>;
  try {
    index = InstalledPluginsSchema.parse(JSON.parse(text));
  } catch (err) {
    throw new SettingsError(`${indexFile} cannot be read: ${errorMessage(err)}`);
  }
  const out: PluginHooks[] = [];
  for (const plugin of enabled) {
    const install = index.plugins[plugin]?.[0];
    if (!install) continue;
    const root = install.installPath;
    const manifestText = await readOptional(path.join(root, '.claude-plugin', 'plugin.json'));
    if (manifestText !== undefined) {
      let manifest: z.infer<typeof PluginManifestSchema>;
      try {
        manifest = PluginManifestSchema.parse(JSON.parse(manifestText));
      } catch (err) {
        throw new SettingsError(`plugin ${plugin} manifest cannot be read: ${errorMessage(err)}`);
      }
      if (manifest.hooks !== undefined) {
        // Hooks declared in the manifest (inline or as extra files) are not evaluated: refuse rather than miss them.
        throw new SettingsError(`plugin ${plugin} declares hooks in its manifest, which agent-code-mode cannot evaluate`);
      }
    }
    const hooksFile = path.join(root, 'hooks', 'hooks.json');
    const hooksText = await readOptional(hooksFile);
    if (hooksText === undefined) continue;
    try {
      out.push({ plugin, root, hooks: PluginHooksFileSchema.parse(JSON.parse(hooksText)).hooks });
    } catch (err) {
      throw new SettingsError(`plugin ${plugin} hooks file ${hooksFile} is invalid: ${errorMessage(err)}`);
    }
  }
  return out;
}

export interface LoadSettingsOptions extends SettingsLocations {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly flags: ClaudeCliFlags;
  readonly parentCwd: string | undefined;
}

/** Loads every settings source. Rejects with a message when a source cannot be understood. */
export async function loadSettings(opts: LoadSettingsOptions): Promise<LoadedSettings> {
  try {
    const { projectRoot, configDir } = opts;
    const sources = opts.flags.settingSources;
    const wants = (s: string): boolean => sources === undefined || sources.includes(s);
    const git = await gitLayout(projectRoot);
    const managed = opts.managedDir === undefined ? [] : await readManaged(opts.managedDir, projectRoot);
    const flagDocs = await readFlagSettings(opts.flags, opts.parentCwd, projectRoot);
    // Both local files apply; the main checkout's wins a scalar key.
    const localRoots = [...new Set([(await localSettingsRoot(git.main, opts.home)) ?? projectRoot, projectRoot])];
    const local = wants('local') ? await Promise.all(localRoots.map((root) => readSettingsFile(path.join(root, '.claude', 'settings.local.json'), 'local', projectRoot))) : [];
    const project = wants('project') ? await readSettingsFile(path.join(projectRoot, '.claude', 'settings.json'), 'project', projectRoot) : undefined;
    const user = wants('user') ? await readSettingsFile(path.join(configDir, 'settings.json'), 'user', configDir) : undefined;
    const docs = [...managed, ...flagDocs, ...local.filter((d) => d !== undefined), ...(project ? [project] : []), ...(user ? [user] : [])];
    const projectTrusted = await isProjectTrusted([projectRoot, ...[git.root, git.main].filter((k) => k !== undefined)], opts.home, opts.env);

    // enabledPlugins: highest source that names a plugin decides it. Hook controls apply before hook files
    // are read; managed-enabled plugins survive `allowManagedHooksOnly` and a lower `disableAllHooks`.
    const decided = new Map<string, { readonly on: boolean; readonly managed: boolean }>();
    for (const doc of docs) {
      for (const [name, on] of Object.entries(doc.data.enabledPlugins ?? {})) {
        if (!decided.has(name)) decided.set(name, { on, managed: doc.source === 'managed' });
      }
    }
    const controls = hookControls(docs);
    const enabled = controls.allOff ? [] : [...decided].filter(([, d]) => d.on && (d.managed || !controls.managedOnly)).map(([name]) => name);
    const plugins = await readPluginHooks(enabled, configDir);
    return { docs, plugins, projectTrusted, hookControls: controls };
  } catch (err) {
    if (err instanceof SettingsError) throw err;
    throw new SettingsError(errorMessage(err));
  }
}

/** First value of a scalar setting, by precedence. */
export function firstSetting<T>(docs: readonly SettingsDoc[], pick: (s: Settings) => T | undefined): T | undefined {
  for (const doc of docs) {
    const value = pick(doc.data);
    if (value !== undefined) return value;
  }
  return undefined;
}
