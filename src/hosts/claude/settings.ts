import { readdir, readFile, stat } from 'node:fs/promises';
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
      defaultMode: z.string().optional(),
      disableBypassPermissionsMode: z.string().optional(),
    })
    .optional(),
  hooks: HooksSchema.optional(),
  disableAllHooks: z.boolean().optional(),
  allowManagedHooksOnly: z.boolean().optional(),
  allowManagedPermissionRulesOnly: z.boolean().optional(),
  enabledPlugins: z.record(z.string(), z.unknown()).optional(),
  sandbox: z
    .looseObject({
      enabled: z.boolean().optional(),
      filesystem: z
        .looseObject({
          allowWrite: stringList.optional(),
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

export interface LoadedSettings {
  /** Highest precedence first. */
  readonly docs: readonly SettingsDoc[];
  readonly plugins: readonly PluginHooks[];
  /** Whether project (and repository-supplied local) allow rules and additional directories apply. */
  readonly projectTrusted: boolean;
}

export interface SettingsLocations {
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

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return undefined;
    throw new SettingsError(`cannot read ${file}: ${errorMessage(err)}`);
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

/** The managed settings documents in `dir` (`managed-settings.json` and `managed-settings.d/*.json`), highest precedence first. */
export function readManagedSettings(dir: string): Promise<SettingsDoc[]> {
  return readManaged(dir, dir);
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

/** Directories whose trust covers the project: the project root, its git root and the main checkout of a worktree. */
async function trustKeys(projectRoot: string): Promise<string[]> {
  const keys = new Set<string>([projectRoot]);
  let dir = projectRoot;
  for (let i = 0; i < 64; i++) {
    const dotGit = path.join(dir, '.git');
    try {
      const st = await stat(dotGit);
      keys.add(dir);
      if (st.isFile()) {
        const text = await readFile(dotGit, 'utf8');
        const m = /^gitdir:\s*(.+)$/m.exec(text);
        if (m?.[1]) {
          const gitdir = path.resolve(dir, m[1].trim());
          const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
          const at = gitdir.lastIndexOf(marker);
          if (at !== -1) keys.add(gitdir.slice(0, at));
        }
      }
      break;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...keys];
}

async function isProjectTrusted(projectRoot: string, home: string, env: Readonly<Record<string, string | undefined>>): Promise<boolean> {
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
  for (const key of await trustKeys(projectRoot)) {
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
    const managed = opts.managedDir === undefined ? [] : await readManaged(opts.managedDir, projectRoot);
    const flagDocs = await readFlagSettings(opts.flags, opts.parentCwd, projectRoot);
    const local = wants('local') ? await readSettingsFile(path.join(projectRoot, '.claude', 'settings.local.json'), 'local', projectRoot) : undefined;
    const project = wants('project') ? await readSettingsFile(path.join(projectRoot, '.claude', 'settings.json'), 'project', projectRoot) : undefined;
    const user = wants('user') ? await readSettingsFile(path.join(configDir, 'settings.json'), 'user', configDir) : undefined;
    const docs = [...managed, ...flagDocs, ...(local ? [local] : []), ...(project ? [project] : []), ...(user ? [user] : [])];
    const projectTrusted = await isProjectTrusted(projectRoot, opts.home, opts.env);

    // enabledPlugins: highest source that names a plugin decides it.
    const decided = new Map<string, boolean>();
    for (const doc of docs) {
      for (const [name, value] of Object.entries(doc.data.enabledPlugins ?? {})) {
        if (!decided.has(name)) decided.set(name, value === true);
      }
    }
    const enabled = [...decided].filter(([, on]) => on).map(([name]) => name);
    const plugins = await readPluginHooks(enabled, configDir);
    return { docs, plugins, projectTrusted };
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
