import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, getPath, loadCodexConfig, mergeTables, nodeConfigIo, parseOverride, parseParentCommandLine, ruleFiles } from './config.js';
import { discoverHooks } from './hooks.js';
import { memoryIo } from './test-io.js';

const posix = process.platform !== 'win32';

describe.runIf(posix)('loadCodexConfig', () => {
  const trusted = '[projects."/repo"]\ntrust_level = "trusted"\n';

  it('merges system, user and trusted project layers in Codex order', () => {
    const io = memoryIo({
      files: {
        '/etc/codex/config.toml': 'sandbox_mode = "read-only"\n[sandbox_workspace_write]\nnetwork_access = true\n',
        '/home/u/.codex/config.toml': `sandbox_mode = "workspace-write"\n${trusted}`,
        '/repo/.codex/config.toml': '[sandbox_workspace_write]\nwritable_roots = ["/data"]\n',
        '/repo/sub/.codex/config.toml': 'approval_policy = "on-request"\n',
      },
      dirs: ['/repo/.git'],
    });
    const c = loadCodexConfig('/repo/sub', io);
    expect(c.projectRoot).toBe('/repo');
    expect(c.layers.map((l) => l.source)).toEqual(['system', 'user', 'project', 'project']);
    expect(c.sandboxMode).toBe('workspace-write');
    expect(c.networkAccess).toBe(true);
    expect(c.writableRoots).toEqual(['/data']);
    expect(c.approvalPolicy).toBe('on-request');
  });

  it('ignores project config when the project is not trusted', () => {
    const io = memoryIo({
      files: {
        '/home/u/.codex/config.toml': '[projects."/repo"]\ntrust_level = "untrusted"\n',
        '/repo/.codex/config.toml': 'sandbox_mode = "danger-full-access"\n',
        '/repo/.codex/rules/x.rules': 'prefix_rule(pattern=["ls"])\n',
      },
      dirs: ['/repo/.git'],
    });
    const c = loadCodexConfig('/repo', io);
    expect(c.sandboxMode).toBe('read-only');
    expect(c.untrustedProjectFolders).toEqual(['/repo/.codex']);
    expect(ruleFiles(c, io)).toEqual([]);
  });

  it('ignores project config of an unknown project and even its invalid TOML', () => {
    const io = memoryIo({ files: { '/repo/.codex/config.toml': 'this is = = not toml' }, dirs: ['/repo/.git'] });
    const c = loadCodexConfig('/repo', io);
    expect(c.layers.map((l) => l.source)).toEqual(['user']);
  });

  it('fails on invalid TOML in an active layer', () => {
    const io = memoryIo({
      files: { '/home/u/.codex/config.toml': trusted, '/repo/.codex/config.toml': 'sandbox_mode = ' },
      dirs: ['/repo/.git'],
    });
    expect(() => loadCodexConfig('/repo', io)).toThrow(ConfigError);
    expect(() => loadCodexConfig('/x', memoryIo({ files: { '/home/u/.codex/config.toml': '[a' } }))).toThrow(/invalid TOML/);
  });

  it('trusts by the project root key and finds rules of trusted layers', () => {
    const io = memoryIo({
      files: {
        '/home/u/.codex/config.toml': trusted,
        '/home/u/.codex/rules/default.rules': '',
        '/repo/a/.codex/rules/b.rules': '',
        '/etc/codex/rules/sys.rules': '',
      },
      dirs: ['/repo/.git'],
    });
    const c = loadCodexConfig('/repo/a', io);
    expect(ruleFiles(c, io)).toEqual(['/etc/codex/rules/sys.rules', '/home/u/.codex/rules/default.rules', '/repo/a/.codex/rules/b.rules']);
  });

  it('applies the parent command line: -c, --profile, -s, exec, --disable hooks', () => {
    const io = memoryIo({
      files: { '/home/u/.codex/fast.config.toml': 'sandbox_mode = "workspace-write"\n' },
      argv: ['/usr/bin/codex', '-p', 'fast', '-c', 'sandbox_workspace_write.network_access=true', '--disable', 'hooks', 'exec', 'do it'],
    });
    const c = loadCodexConfig('/w', io);
    expect(c.layers.map((l) => l.source)).toEqual(['user', 'profile', 'session-flags']);
    expect(c.sandboxMode).toBe('workspace-write');
    expect(c.networkAccess).toBe(true);
    expect(c.approvalPolicy).toBe('never');
    expect(c.hooksEnabled).toBe(false);
    const yolo = loadCodexConfig('/w', memoryIo({ argv: ['codex', '--yolo'] }));
    expect(yolo.sandboxMode).toBe('danger-full-access');
    expect(yolo.approvalPolicy).toBe('never');
  });

  it('notes when the parent command line is not visible', () => {
    const c = loadCodexConfig('/w', memoryIo({ argv: undefined }));
    expect(c.cmdline).toBeNull();
    expect(c.notes.join(' ')).toMatch(/command line could not be read/);
  });

  it('respects CODEX_HOME and requirements', () => {
    const io = memoryIo({
      env: { CODEX_HOME: '/ch' },
      files: {
        '/ch/config.toml': 'sandbox_mode = "danger-full-access"\n',
        '/etc/codex/requirements.toml': 'allowed_sandbox_modes = ["read-only", "workspace-write"]\nallow_managed_hooks_only = true\n',
      },
    });
    const c = loadCodexConfig('/w', io);
    expect(c.codexHome).toBe('/ch');
    expect(c.sandboxMode).toBe('read-only');
    expect(c.requirements?.allowManagedHooksOnly).toBe(true);
    expect(() => loadCodexConfig('/w', memoryIo({ env: { CODEX_HOME: '/missing' } }))).toThrow(/does not exist/);
  });

  it('rejects settings it cannot reproduce', () => {
    expect(() => loadCodexConfig('/w', memoryIo({ files: { '/home/u/.codex/config.toml': 'default_permissions = "x"\n' } }))).toThrow(/permission profiles/);
    expect(() => loadCodexConfig('/w', memoryIo({ files: { '/home/u/.codex/config.toml': 'sandbox_mode = "yes"\n' } }))).toThrow(/sandbox_mode/);
    const user = (toml: string) => () => loadCodexConfig('/w', memoryIo({ files: { '/home/u/.codex/config.toml': toml } }));
    for (const toml of ['approval_policy = { granular = { rules = false } }\n', 'sandbox_workspace_write = "x"\n', '[features]\nhooks = "yes"\n', 'project_root_markers = ".hg"\n', '[projects."/w"]\ntrust_level = "yes"\n']) {
      expect(user(toml), toml).toThrow(ConfigError);
    }
    const req = (toml: string) => () => loadCodexConfig('/w', memoryIo({ files: { '/etc/codex/requirements.toml': toml } }));
    for (const toml of ['[rules]\nx = 1\n', '[permissions.filesystem]\nx = 1\n', 'allowed_sandbox_modes = ["workspace-write"]\n', 'allowed_approval_policies = [{ granular = {} }]\n', '[features]\nhooks = true\n[feature_requirements]\nhooks = false\n']) {
      expect(req(toml), toml).toThrow(ConfigError);
    }
  });

  it('applies managed config and requirements with their precedence', () => {
    const io = memoryIo({
      files: { '/etc/codex/managed_config.toml': `${trusted}[features]\nhooks = false\n`, '/repo/.codex/config.toml': 'approval_policy = "untrusted"\n', '/etc/codex/requirements.toml': 'allowed_approval_policies = ["on-request", "never"]\n' },
      dirs: ['/repo/.git'],
      argv: ['codex', '--enable', 'hooks'],
    });
    const c = loadCodexConfig('/repo', io);
    expect(c.layers.map((l) => l.source)).toEqual(['system', 'user', 'project', 'managed']);
    expect(c.hooksEnabled).toBe(false);
    expect(c.approvalPolicy).toBe('on-request');
  });

  it('defaults an untrusted project to the untrusted approval policy', () => {
    const io = memoryIo({ files: { '/home/u/.codex/config.toml': '[projects."/repo"]\ntrust_level = "untrusted"\n' }, dirs: ['/repo/.git'] });
    expect(loadCodexConfig('/repo', io).approvalPolicy).toBe('untrusted');
  });

  it('resolves writable roots against the config that set them, and replaces -c leaves', () => {
    const io = memoryIo({
      files: { '/home/u/.codex/config.toml': trusted, '/repo/.codex/config.toml': '[sandbox_workspace_write]\nwritable_roots = ["data"]\n' },
      dirs: ['/repo/.git'],
      argv: ['codex', '--add-dir', 'extra', '-c', 'sandbox_workspace_write={network_access=true}', '-c', 'sandbox_workspace_write={exclude_slash_tmp=true}'],
    });
    const c = loadCodexConfig('/repo', io);
    expect(c.writableRoots).toEqual(['/repo/.codex/data', '/repo/extra']);
    expect(c.networkAccess).toBe(false);
  });

  it('reuses the trust of a linked worktree only after confirming its registration both ways', () => {
    const hook = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }] } });
    const files = {
      '/home/u/.codex/config.toml': trusted,
      '/wt/.git': 'gitdir: /repo/.git/worktrees/wt\n',
      '/wt/.codex/config.toml': 'sandbox_mode = "workspace-write"\n',
      '/wt/.codex/hooks.json': hook,
      '/repo/.codex/hooks.json': hook,
      '/repo/.git/worktrees/wt/commondir': '../..\n',
    };
    const io = memoryIo({ files: { ...files, '/repo/.git/worktrees/wt/gitdir': '/wt/.git\n' }, argv: ['codex', '--dangerously-bypass-hook-trust'] });
    const linked = loadCodexConfig('/wt', io);
    expect(linked.sandboxMode).toBe('workspace-write');
    // Hooks come from the main checkout's matching folder, like Codex.
    expect(discoverHooks(linked, io).hooks.map((h) => h.sourcePath)).toEqual(['/repo/.codex/hooks.json']);
    // Without the registration back to this checkout (or pointing elsewhere), no trust is inherited.
    expect(loadCodexConfig('/wt', memoryIo({ files })).sandboxMode).toBe('read-only');
    expect(loadCodexConfig('/wt', memoryIo({ files: { ...files, '/repo/.git/worktrees/wt/gitdir': '/other/.git\n' } })).sandboxMode).toBe('read-only');
  });

  it('treats a trailing backslash as part of a POSIX trust path', () => {
    const io = memoryIo({ files: { '/home/u/.codex/config.toml': "[projects.'/repo\\']\ntrust_level = \"trusted\"\n", '/repo/.codex/config.toml': 'sandbox_mode = "workspace-write"\n' }, dirs: ['/repo/.git'] });
    expect(loadCodexConfig('/repo', io).sandboxMode).toBe('read-only');
  });
});

describe('TOML merging', () => {
  it('uses own properties only', () => {
    const merged = mergeTables({}, JSON.parse('{"__proto__": {"polluted": true}}'));
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(getPath(merged, ['polluted'])).toBeUndefined();
    expect(getPath({}, ['constructor'])).toBeUndefined();
  });
});

describe('command line parsing', () => {
  it('parses -c values as TOML, falling back to strings', () => {
    expect(parseOverride('a.b=true')).toEqual(['a.b', true]);
    expect(parseOverride('x=[1, 2]')).toEqual(['x', [1, 2]]);
    expect(parseOverride('model=gpt-x')).toEqual(['model', 'gpt-x']);
    expect(parseOverride('novalue')).toBeUndefined();
  });

  it('reads option forms and the subcommand', () => {
    const c = parseParentCommandLine(['codex', '--config=a=1', '-cb=2', '--sandbox=read-only', '-a', 'untrusted', '--add-dir', '/d', 'resume']);
    expect(c.overrides).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(c.sandboxMode).toBe('read-only');
    expect(c.approvalPolicy).toBe('untrusted');
    expect(c.addDirs).toEqual(['/d']);
    expect(c.exec).toBe(false);
    expect(parseParentCommandLine(['codex', '-m', 'exec', 'exec']).exec).toBe(true);
  });

  it('refuses authorization options it cannot read exactly', () => {
    const refused = [['codex', '-a', 'bogus'], ['codex', '--sandbox', 'nope'], ['codex', '--approve-for-me'], ['codex', 'exec', '--ignore-rules'], ['codex', '--ignore-user-config'], ['codex', '--trust'], ['codex', '-p'], ['codex', '-c', 'novalue']];
    for (const argv of refused) {
      expect(() => parseParentCommandLine(argv), argv.join(' ')).toThrow(ConfigError);
    }
    expect(parseParentCommandLine(['codex', '--strict-config', 'exec']).exec).toBe(true);
  });

  it('refuses a real parent command line that is not an exact Codex argv', () => {
    // The test runner is not a Codex process, and only Linux exposes an exact argv.
    expect(() => nodeConfigIo().parentArgv()).toThrow(ConfigError);
  });

  it.runIf(posix)('lists only regular rule files', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acm-rules-'));
    writeFileSync(path.join(dir, 'a.rules'), '');
    symlinkSync(path.join(dir, 'a.rules'), path.join(dir, 'b.rules'));
    expect(nodeConfigIo().listFiles(dir)).toEqual(['a.rules']);
    expect(nodeConfigIo().listFiles(path.join(dir, 'missing'))).toEqual([]);
    // A file where the rules folder should be is invalid, not empty.
    expect(() => nodeConfigIo().listFiles(path.join(dir, 'a.rules'))).toThrow(ConfigError);
    rmSync(dir, { recursive: true, force: true });
  });
});
