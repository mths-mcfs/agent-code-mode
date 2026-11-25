import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../core/dispatcher.js';
import type { SessionContext } from '../../core/types.js';
import { MemoryToolRuntime } from '../../testing/memory-tool-runtime.js';
import { checkShellCommand, CodexHostAdapter, type CodexPolicy } from './adapter.js';
import { parseRulesFile } from './exec-policy.js';
import { decodeAnsiC } from './shell.js';
import { memoryIo } from './test-io.js';

const RULES = parseRulesFile('prefix_rule(pattern=["rm"], decision="forbidden")\nprefix_rule(pattern=["git", "push"], decision="forbidden")\n', 'default.rules');

function policy(approvalPolicy: CodexPolicy['approvalPolicy']): CodexPolicy {
  return { sandboxMode: 'danger-full-access', approvalPolicy, writableRoots: [], rules: { rules: RULES }, hooks: [], hooksEnabled: true, permissionMode: 'default', codexHome: '/home/u/.codex', notes: [] };
}
const decide = (cmd: string, approval: CodexPolicy['approvalPolicy'] = 'on-request') => checkShellCommand(cmd, policy(approval), ['/bin/bash', '-c']);

/** Each runs the forbidden program in bash; none may be allowed, and with approval never each is denied. */
const EQUIVALENT_FORMS: readonly string[] = [
  'function f { rm -rf x; }; f',
  'function f() { rm -rf x; }; f',
  "$'\\x72m' -rf x",
  "$'\\162m' -rf x",
  "git $'\\x70ush' origin",
  "bash -c -- 'rm -rf x'",
  "bash -c -e 'rm -rf x'",
  "bash -ec 'rm -rf x'",
  "bash -o errexit -c 'rm -rf x'",
  "bash -O extglob -c 'rm -rf x'",
  "bash +O extglob -c 'rm -rf x'",
  "bash --rcfile /dev/null -c 'rm -rf x'",
  `bash -c "sh -o errexit -c 'rm -rf x'"`,
  "zsh -o shwordsplit -c 'rm -rf x'",
  "source /dev/stdin <<< 'rm -rf x'",
  '. /dev/stdin <<EOF\nrm -rf x\nEOF',
  '. <(echo rm -rf x)',
  'bash <(echo rm -rf x)',
  "bash /dev/stdin <<< 'rm -rf x'",
  'bash /dev/fd/3 3<<< "rm -rf x"',
  'coproc rm -rf x',
  'shopt -s expand_aliases\nalias x=rm\nx -rf y',
  'setsid rm -rf x',
  'flock /tmp/lk rm -rf x',
  'ionice -c3 rm -rf x',
  'taskset 1 rm -rf x',
  'chrt -i 0 rm -rf x',
  "script -qc 'rm -rf x' /dev/null",
  "su -c 'rm -rf x' root",
  "watch 'rm x'",
  "ssh host 'rm -rf x'",
  "parallel 'rm {}' ::: a",
  "entr -s 'rm x'",
  "nohup sh -c 'rm x'",
  "xargs sh -c 'rm x'",
  "git -c core.pager='rm x' log",
  "GIT_PAGER='rm x' git log",
  "GIT_PAGER='sh -c \"rm x\"' git log",
  "PAGER='rm x' git log",
  "GIT_EXTERNAL_DIFF=./cleanup.sh git diff",
  "GIT_SSH_COMMAND='rm x' git status",
  "GIT_EDITOR='rm x' git commit",
  "RIPGREP_CONFIG_PATH=./rg.conf rg x",
  "env GIT_PAGER='sh -c x' git log",
  "export GIT_PAGER='sh -c x'; git log",
  "declare -x GIT_PAGER='sh -c x'; git log",
  "env -u HOME GIT_PAGER='sh -c x' git log",
  "sudo GIT_PAGER='sh -c x' git log",
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=sh git log",
  "flock /tmp/lk -c 'rm -rf x'",
  '$"rm" -rf x',
  'IFS=,; c=rm,-rf,x; $c',
  '{rm,-rf,x}',
  'r{m,} -rf x',
  '~/bin/rm -rf x',
  'c=rm; "$c" -rf x',
  "bash <<'EOF'\nrm -rf x\nEOF",
];

/** Forms the splitter models: denied outright by the rule. */
const MODELED: readonly string[] = [
  'rm -rf x',
  '/bin/rm -rf x',
  'r\\m -rf x',
  '"rm" -rf x',
  "'r'm -rf x",
  'env rm -rf x',
  'env -i A=1 -- rm -rf x',
  "env -S 'rm -rf x'",
  'command rm -rf x',
  'command -p -- rm -rf x',
  'exec rm -rf x',
  'exec -a foo rm -rf x',
  'xargs rm -rf',
  'xargs -0 -I{} rm {}',
  'find . -exec rm {} +',
  'find . -execdir /bin/rm {} \\;',
  'nice -n5 rm -rf x',
  'nice --5 rm -rf x',
  'timeout 5 rm -rf x',
  'timeout -sKILL 5 rm -rf x',
  'busybox rm -rf x',
  "bash -c \"sh -c 'rm -rf x'\"",
  "bash -lc 'rm -rf x'",
  '{ rm -rf x; }',
  'f(){ rm -rf x; }; f',
  'f() ( rm -rf x ); f',
  'echo $(rm -rf x)',
  'cat <(rm -rf x)',
  'X=1 rm -rf x',
  'if true; then rm -rf x; fi',
  'case a in a) rm -rf x;; esac',
  'for i in 1; do rm -rf x; done',
  'cat <<EOF\n$(rm -rf x)\nEOF',
  "trap 'rm -rf x' EXIT",
  "eval 'rm -rf x'",
  'git push origin',
  'sudo -u root rm -rf x',
  "$'\\x72m' -rf x",
  "bash -o errexit -c 'rm -rf x'",
];

describe('a forbidden rule survives equivalent forms', () => {
  it.each(EQUIVALENT_FORMS)('%j is never allowed, and denied with approval never', (cmd) => {
    expect(decide(cmd).kind).not.toBe('allow');
    expect(decide(cmd, 'never')).toMatchObject({ kind: 'deny', source: 'rule' });
  });

  it.each(MODELED)('%j is denied by the rule', (cmd) => {
    expect(decide(cmd)).toMatchObject({ kind: 'deny', source: 'rule' });
  });

  it('still allows commands that name no guarded program', () => {
    for (const cmd of ['ls -la', 'git status', "bash -c 'echo ok'", 'source ./env.sh', 'bash ./build.sh', "printf '%s' a", 'git commit -m "rm old files"', 'echo "use git here"', "printf '%s\\n' 'GIT_PAGER=cat'", 'echo GIT_PAGER=less', 'git commit -m "set GIT_PAGER=cat"', "echo 'git push later'", "printf '%s\\n' 'rm x'", "cat 'rm notes.txt'", "rg -e 'rm -rf' src"]) {
      expect(decide(cmd), cmd).toEqual({ kind: 'allow' });
    }
  });

  it('asks when a guarded program is a whole argument, the price of not listing wrappers', () => {
    for (const cmd of ['grep -c rm a.txt', 'git rm x', 'command -v rm', 'unknownwrapper rm -rf x']) expect(decide(cmd).kind, cmd).toBe('ask');
  });

  it('decodes ANSI-C quoting like bash', () => {
    expect(decodeAnsiC('\\x72m\\t\\101\\n\\\\\\q')).toEqual({ text: 'rm\tA\n\\\\q', exact: true });
    expect(decodeAnsiC('\\u00e9').exact).toBe(false);
  });
});

const tmp = mkdtempSync(path.join(os.tmpdir(), 'acm-codex-forms-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.runIf(process.platform === 'linux')('through the dispatcher with approval never', () => {
  const WS = path.join(tmp, 'ws');
  mkdirSync(WS, { recursive: true });
  const files = { '/home/u/.codex/rules/default.rules': 'prefix_rule(pattern=["rm"], decision="forbidden")\n' };
  const c: SessionContext = { host: 'codex', cwd: WS, roots: [], permissionMode: 'default', sources: {}, sandboxMode: 'danger-full-access' };

  it.each(["$'\\x72m' -rf x", "bash -o errexit -c 'rm -rf x'", 'function f { rm -rf x; }; f', '$"rm" -rf x', "source /dev/stdin <<< 'rm -rf x'"])('commits nothing for %j', async (cmd) => {
    const a = new CodexHostAdapter({ io: () => memoryIo({ files, argv: ['codex', '-s', 'danger-full-access', '-a', 'never'] }), stateDir: '/state', tmpDirs: { slashTmp: '/tmp', tmpdir: null } });
    const tools = new MemoryToolRuntime({ root: WS });
    const reply = await new Dispatcher({ adapter: a, tools, ctx: c, policy: await a.loadPolicy(c) }).dispatch('bash', { command: cmd });
    expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
    expect(tools.commits).toEqual([]);
  });

  it.each(['rm -rf x', "bash -o errexit -c 'rm -rf x'", "$'\\x72m' -rf x"])('denies a hook rewrite to %j', async (to) => {
    const hookFile = path.join(tmp, 'rewrite.mjs');
    writeFileSync(hookFile, `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: ${JSON.stringify(to)} } } }));\n`);
    const hooked = { ...files, '/etc/codex/hooks.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `"${process.execPath}" "${hookFile}"` }] }] } }) };
    const a = new CodexHostAdapter({ io: () => memoryIo({ files: hooked, argv: ['codex', '-s', 'danger-full-access'] }), hookEnv: { ...process.env, SHELL: '/bin/sh' }, stateDir: '/state', tmpDirs: { slashTmp: '/tmp', tmpdir: null } });
    const tools = new MemoryToolRuntime({ root: WS });
    const reply = await new Dispatcher({ adapter: a, tools, ctx: c, policy: await a.loadPolicy(c) }).dispatch('bash', { command: 'echo ok' });
    expect(reply.ok).toBe(false);
    expect(tools.commits).toEqual([]);
  });
});
