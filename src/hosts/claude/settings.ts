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
      autoAllowBashIfSandboxed: z.boolean().optional(),
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

export interface SettingsDoc {
  readonly source: RuleSourceName;
  readonly file: string | undefined;
  readonly anchorDir: string;
  readonly data: Settings;
}

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
  readonly docs: readonly SettingsDoc[];
  readonly plugins: readonly PluginHooks[];
  /** Install directory of every enabled plugin, with or without hooks. */
  readonly pluginRoots: readonly string[];
  /** Every directory whose skills, subagents and commands were checked for hooks. */
  readonly componentDirs: readonly string[];
  /** The skill, subagent and command files read for that check. */
  readonly componentFiles: readonly string[];
  readonly componentHooks: string | undefined;
  readonly hookControls: ReturnType<typeof hookControls>;
  readonly projectTrusted: boolean;
}

export interface SettingsLocations {
  readonly projectRoots: readonly string[];
  readonly home: string;
  readonly configDir: string;
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

export function claudeConfigDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const dir = env['CLAUDE_CONFIG_DIR'];
  return dir !== undefined && dir !== '' && path.isAbsolute(dir) ? dir : path.join(home, '.claude');
}

class SettingsError extends Error {}

const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;

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

/** The main checkout, where Claude keeps a subdirectory or worktree session's local file. */
async function localSettingsRoot(main: string | undefined, home: string): Promise<string | undefined> {
  const uid = process.getuid?.();
  if (main === undefined || uid === undefined || path.resolve(main) === path.resolve(home)) return undefined;
  for (const p of [main, path.join(main, '.git'), path.join(main, '.claude')]) {
    const st = await lstat(p).catch(() => undefined);
    if (st !== undefined && st.uid !== uid) return undefined;
  }
  return main;
}

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

interface InstalledPlugin {
  readonly plugin: string;
  readonly root: string;
}

async function installedPlugins(enabled: readonly string[], configDir: string): Promise<InstalledPlugin[]> {
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
  return enabled.flatMap((plugin) => {
    const install = index.plugins[plugin]?.[0];
    return install ? [{ plugin, root: install.installPath }] : [];
  });
}

async function readPluginHooks(installed: readonly InstalledPlugin[]): Promise<PluginHooks[]> {
  const out: PluginHooks[] = [];
  for (const { plugin, root } of installed) {
    const manifestText = await readOptional(path.join(root, '.claude-plugin', 'plugin.json'));
    if (manifestText !== undefined) {
      let manifest: z.infer<typeof PluginManifestSchema>;
      try {
        manifest = PluginManifestSchema.parse(JSON.parse(manifestText));
      } catch (err) {
        throw new SettingsError(`plugin ${plugin} manifest cannot be read: ${errorMessage(err)}`);
      }
      if (manifest.hooks !== undefined) {
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

const MAX_COMPONENT_FILES = 2_000;

async function markdownFiles(dir: string, depth: number, found: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return;
    throw new SettingsError(`cannot read ${dir}: ${errorMessage(err)}`);
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    let isFile = entry.isFile();
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      // Claude follows linked skill, agent and command entries: so does the check, and an unreadable target refuses.
      const target = await stat(file).catch((err: unknown) => {
        throw new SettingsError(`cannot read ${file}: ${errorMessage(err)}`);
      });
      isFile = target.isFile();
      isDirectory = target.isDirectory();
    }
    if (isFile && entry.name.endsWith('.md')) found.push(file);
    else if (isDirectory && depth > 0) await markdownFiles(file, depth - 1, found);
    if (found.length > MAX_COMPONENT_FILES) throw new SettingsError(`more than ${MAX_COMPONENT_FILES} skill, agent and command files to check for hooks`);
  }
}

async function findComponentHooks(
  claudeDirs: readonly string[],
  pluginRoots: readonly string[],
  nestedSkillDirs: readonly string[],
): Promise<{ readonly hooks: string | undefined; readonly files: readonly string[] }> {
  const files: string[] = [];
  const skillsOf = async (dir: string): Promise<void> => {
    const skills: string[] = [];
    await markdownFiles(path.join(dir, 'skills'), 1, skills);
    files.push(...skills.filter((f) => path.basename(f) === 'SKILL.md'));
  };
  for (const dir of [...new Set([...claudeDirs, ...pluginRoots])]) {
    await skillsOf(dir);
    await markdownFiles(path.join(dir, 'agents'), 4, files);
    await markdownFiles(path.join(dir, 'commands'), 4, files);
  }
  for (const dir of nestedSkillDirs) await skillsOf(dir);
  for (const file of files) {
    const text = (await readOptional(file)) ?? '';
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text)?.[1];
    if (frontmatter !== undefined && /^["']?hooks["']?\s*:/m.test(frontmatter)) return { hooks: file, files };
  }
  return { hooks: undefined, files };
}

/** Most directories walked below a project root looking for nested `.claude` directories. */
const MAX_NESTED_WALK = 20_000;

/** Directories never walked for nested skills: Claude skips ignored trees such as dependencies. */
const UNWALKED = new Set(['.git', 'node_modules']);

/**
 * The `.claude` directories below `root` (not `root/.claude` itself). Claude loads their skills once it
 * works in that subdirectory, so they count from the start. Too many directories to walk refuses.
 */
async function nestedClaudeDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  const queue = [root];
  for (let walked = 0; queue.length > 0; walked++) {
    if (walked > MAX_NESTED_WALK) throw new SettingsError(`more than ${MAX_NESTED_WALK} directories under ${root} to check for nested skills`);
    const dir = queue.shift() ?? root;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err !== null && typeof err === 'object' && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) continue;
      throw new SettingsError(`cannot read ${dir}: ${errorMessage(err)}`);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || UNWALKED.has(entry.name)) continue;
      const sub = path.join(dir, entry.name);
      if (entry.name === '.claude') {
        if (dir !== root) found.push(sub);
      } else {
        queue.push(sub);
      }
    }
  }
  return found;
}

/** `dir` and its parents up to `top` (inclusive); just `dir` when `top` does not contain it. */
function upTo(dir: string, top: string | undefined): string[] {
  const out = [dir];
  const rel = top === undefined ? '..' : path.relative(top, dir);
  // Outside is `..` itself or a `..` component, or another root; a name such as `..app` is inside.
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return out;
  for (let d = dir; d !== top && path.dirname(d) !== d; ) {
    d = path.dirname(d);
    out.push(d);
  }
  return out;
}

export interface LoadSettingsOptions extends SettingsLocations {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly flags: ClaudeCliFlags;
  readonly parentCwd: string | undefined;
  /** Directories added at launch (`--add-dir`), whose `.claude` skills and agents Claude loads too. */
  readonly extraDirs: readonly string[];
}

function defined<T>(value: T | undefined): T[] {
  return value === undefined ? [] : [value];
}

export async function loadSettings(opts: LoadSettingsOptions): Promise<LoadedSettings> {
  try {
    const { configDir } = opts;
    const primary = opts.projectRoots[0];
    if (primary === undefined) throw new SettingsError('no project directory is known');
    const sources = opts.flags.settingSources;
    const wants = (s: string): boolean => sources === undefined || sources.includes(s);
    const roots = await Promise.all([...new Set(opts.projectRoots)].map(async (root) => ({ root, git: await gitLayout(root) })));
    const managed = opts.managedDir === undefined ? [] : await readManaged(opts.managedDir, primary);
    const flagDocs = await readFlagSettings(opts.flags, opts.parentCwd, primary);
    const local: SettingsDoc[] = [];
    const project: SettingsDoc[] = [];
    for (const { root, git } of roots) {
      // Both local files apply; the main checkout's wins a scalar key.
      const localRoots = [...new Set([(await localSettingsRoot(git.main, opts.home)) ?? root, root])];
      if (wants('local')) for (const dir of localRoots) local.push(...defined(await readSettingsFile(path.join(dir, '.claude', 'settings.local.json'), 'local', root)));
      if (wants('project')) project.push(...defined(await readSettingsFile(path.join(root, '.claude', 'settings.json'), 'project', root)));
    }
    const user = wants('user') ? await readSettingsFile(path.join(configDir, 'settings.json'), 'user', configDir) : undefined;
    const docs = [...managed, ...flagDocs, ...local, ...project, ...defined(user)];
    // Trust is the workspace's own or its checkout root's; a linked worktree does not inherit its main checkout's.
    const projectTrusted = (await Promise.all(roots.map(async ({ root, git }) => isProjectTrusted([root, ...(git.root === undefined ? [] : [git.root])], opts.home, opts.env)))).every(Boolean);

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
    const installed = await installedPlugins(enabled, configDir);
    const unverified = controls.commandPluginsBlocked ? installed[0] : undefined;
    if (unverified !== undefined) {
      throw new SettingsError(`plugin ${unverified.plugin} is enabled, and its installation source cannot be verified while command-sourced plugins are disabled`);
    }
    const plugins = await readPluginHooks(installed);
    // Skills of the project roots, their parents up to the repository root, and nested subdirectories.
    const componentDirs = [
      configDir,
      ...(opts.managedDir === undefined ? [] : [path.join(opts.managedDir, '.claude')]),
      ...roots.flatMap(({ root, git }) => upTo(root, git.root).map((dir) => path.join(dir, '.claude'))),
      ...opts.extraDirs.map((dir) => path.join(dir, '.claude')),
    ];
    const nested = (await Promise.all(roots.map(({ root }) => nestedClaudeDirs(root)))).flat();
    const { hooks: componentHooks, files: componentFiles } = await findComponentHooks(componentDirs, installed.map((p) => p.root), nested);
    const pluginRoots = installed.map((p) => p.root);
    return { docs, plugins, pluginRoots, componentDirs: [...new Set([...componentDirs, ...pluginRoots, ...nested])], componentFiles, projectTrusted, hookControls: controls, componentHooks };
  } catch (err) {
    if (err instanceof SettingsError) throw err;
    throw new SettingsError(errorMessage(err));
  }
}

export function firstSetting<T>(docs: readonly SettingsDoc[], pick: (s: Settings) => T | undefined): T | undefined {
  for (const doc of docs) {
    const value = pick(doc.data);
    if (value !== undefined) return value;
  }
  return undefined;
}
