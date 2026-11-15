import { describe, expect, it } from 'vitest';
import { isDangerousCommand, matchRules, parseRulesFile, RulesParseError, strictest } from './exec-policy.js';
import { shellQuote, shlexSplit, splitShellCommands } from './shell.js';

describe('rules parser (Starlark subset)', () => {
  it('parses every documented token form', () => {
    const rules = parseRulesFile(
      `# comment
prefix_rule(
    pattern = ["git", ["push", "fetch"], "origin"],
    decision = "prompt",
    justification = 'network access',
    match = ["git push origin main", ["git", "fetch", "origin"]],
    not_match = ["git pull origin"],
)
prefix_rule(pattern=[["rm", "rmdir"]], decision="forbidden")
prefix_rule(["ls"])  # positional pattern, default decision allow
prefix_rule(pattern=["npm", ["test"]],); prefix_rule(pattern=["echo"], decision="allow")
`,
      'default.rules',
    );
    expect(rules.map((r) => [r.program, r.rest, r.decision])).toEqual([
      ['git', [['push', 'fetch'], ['origin']], 'prompt'],
      ['rm', [], 'forbidden'],
      ['rmdir', [], 'forbidden'],
      ['ls', [], 'allow'],
      ['npm', [['test']], 'allow'],
      ['echo', [], 'allow'],
    ]);
    expect(rules[0]?.justification).toBe('network access');
    expect(rules[0]?.source).toBe('default.rules:2');
  });

  it('runs match / not_match examples at load time', () => {
    expect(() => parseRulesFile('prefix_rule(pattern=["git", "push"], match=["git status"])', 'a.rules')).toThrow(/match example "git status" does not match/);
    expect(() => parseRulesFile('prefix_rule(pattern=["git"], not_match=["git push"])', 'a.rules')).toThrow(/not_match example/);
    // Absolute program paths match by basename, like Codex.
    expect(() => parseRulesFile('prefix_rule(pattern=["git"], match=["/usr/bin/git status"])', 'a.rules')).not.toThrow();
    expect(() => parseRulesFile('prefix_rule(pattern=["git"], match=["git \'unterminated"])', 'a.rules')).toThrow(/invalid shell syntax/);
  });

  it('rejects anything outside the subset', () => {
    const bad = [
      'network_rule(host="x", protocol="https", decision="allow")',
      'host_executable(name="git", paths=["/usr/bin/git"])',
      'prefix_rule(pattern=["git"], canonical_matching=True)',
      'x = ["git"]\nprefix_rule(pattern=x)',
      'prefix_rule(pattern=[f"git"])',
      'load("other.rules", "x")',
      'def f():\n  pass',
      'for p in ["a"]:\n  prefix_rule(pattern=[p])',
      'prefix_rule(pattern=["a" + "b"])',
      'prefix_rule(pattern=[])',
      'prefix_rule(pattern=[[]])',
      'prefix_rule(pattern=[["a", ["b"]]])',
      'prefix_rule(pattern=["a"], decision="deny")',
      'prefix_rule(pattern=["a"], justification=" ")',
      'prefix_rule(pattern=["a"], match=[[]])',
      'prefix_rule(pattern=["a"], decision=1)',
      'prefix_rule(pattern=["a"]) prefix_rule(pattern=["b"])',
      'prefix_rule(pattern=["a"]',
      'prefix_rule(pattern=["a\\q"])',
    ];
    for (const src of bad) expect(() => parseRulesFile(src, 'bad.rules'), src).toThrow(RulesParseError);
  });

  it('accepts triple-quoted strings and line continuations', () => {
    const rules = parseRulesFile('prefix_rule(pattern=["a"], justification="""two\nlines""")\n', 'a.rules');
    expect(rules[0]?.justification).toBe('two\nlines');
  });
});

describe('rule evaluation', () => {
  const policy = { rules: parseRulesFile('prefix_rule(pattern=["rm"], decision="forbidden")\nprefix_rule(pattern=["ls"])\nprefix_rule(pattern=["git", "push"], decision="prompt")', 'r.rules') };
  const decide = (cmd: string) => strictest(splitShellCommands(cmd).commands.flatMap((argv) => matchRules(policy, argv)))?.decision;

  it('evaluates each command of a compound command; strictest wins', () => {
    expect(decide('ls && rm -rf x')).toBe('forbidden');
    expect(decide('ls; git push origin')).toBe('prompt');
    expect(decide('ls -la | wc -l')).toBe('allow');
    expect(decide('echo $(rm -rf x)')).toBe('forbidden');
    expect(decide('echo `rm x`')).toBe('forbidden');
    expect(decide('sh -c "rm -rf /tmp/x"')).toBe('forbidden');
    expect(decide('(cd /tmp && rm x)')).toBe('forbidden');
    expect(decide('FOO=1 rm x')).toBe('forbidden');
    expect(decide('/bin/rm x')).toBe('forbidden');
    expect(decide('cat <<EOF\n$(rm -rf x)\nEOF\n')).toBe('forbidden');
    expect(decide("cat <<'EOF'\n$(rm -rf x)\nEOF\n")).toBeUndefined();
    expect(decide('diff <(rm -rf x) b')).toBe('forbidden');
    expect(decide('ls>out;rm x')).toBe('forbidden');
    expect(decide('echo rm')).toBeUndefined();
    expect(decide("echo 'rm -rf x'")).toBeUndefined();
  });

  it('flags forced rm like Codex', () => {
    expect(isDangerousCommand(['rm', '-rf', 'x'])).toBe(true);
    expect(isDangerousCommand(['sudo', 'env', 'A=1', 'rm', '--force', 'x'])).toBe(true);
    expect(isDangerousCommand(['rm', '-r', 'x'])).toBe(false);
    expect(isDangerousCommand(['rm', '--', '-f'])).toBe(false);
  });
});

describe('shell splitter', () => {
  it('splits operators, keeps quoted words and tracks plain scripts', () => {
    expect(splitShellCommands(`git commit -m "a && b" && echo 'x;y' || true`)).toEqual({
      commands: [['git', 'commit', '-m', 'a && b'], ['echo', 'x;y'], ['true']],
      plain: true,
    });
    expect(splitShellCommands('ls > out.txt 2>&1').commands).toEqual([['ls']]);
    expect(splitShellCommands('ls > out.txt').plain).toBe(false);
    expect(splitShellCommands('a\nb # c d\n').commands).toEqual([['a'], ['b']]);
    expect(splitShellCommands('if true; then rm x; fi').commands).toEqual([['true'], ['rm', 'x']]);
  });

  it('fails on what it cannot tokenize', () => {
    for (const bad of ["echo 'x", 'echo "x', 'echo $(ls', 'cat <<EOF\nno end', 'echo `x']) {
      expect(() => splitShellCommands(bad), bad).toThrow();
    }
  });

  it('quotes for the shell and splits like shlex', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shlexSplit(shellQuote("a 'b' c"))).toEqual(["a 'b' c"]);
    expect(shlexSplit('a "b c" d\\ e')).toEqual(['a', 'b c', 'd e']);
  });
});
