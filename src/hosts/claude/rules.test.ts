import { describe, expect, it } from 'vitest';
import { BashAnalyzer } from './bash.js';
import { compilePathSpec, matchesBashSpec, matchesPath, parseRule, splitRule, splitToolList, toNativePath, toPosixPath } from './rules.js';

describe('matchesBashSpec (documented wildcard table)', () => {
  it.each([
    ['npm run build', 'npm run build', true],
    ['npm run build', 'npm run build --watch', false],
    ['npm run *', 'npm run build', true],
    ['npm run *', 'npm run test --watch', true],
    ['npm run *', 'npm run', true],
    ['npm run *', 'npm install', false],
    ['git log * main', 'git log --oneline main', true],
    ['git log * main', 'git log -5 main', true],
    ['git log * main', 'git log main', false],
    ['git log * main', 'git push origin main', false],
    ['git * main', 'git merge main', true],
    ['git * main', 'git log', false],
    ['* --version', 'node --version', true],
    ['* --version', 'node -v', false],
    ['ls *', 'ls -la', true],
    ['ls *', 'ls', true],
    ['ls *', 'lsof', false],
    ['ls*', 'lsof', true],
    ['* --help *', 'npm --help x', true],
    ['* --help *', 'npm --help', false],
    ['ls:*', 'ls -la', true],
    ['ls:*', 'lsof', false],
    ['git:* push', 'git push', false],
  ])('%j vs %j → %s', (spec, command, expected) => {
    expect(matchesBashSpec(spec, command)).toBe(expected);
  });
});

describe('BashAnalyzer', () => {
  it('finds every simple command, including nested ones', () => {
    const forms = BashAnalyzer.analyze('a && b || c; d | e & (f); { g; }; h $(i) `j` <(k) >(l); if m; then n; fi').commands.flatMap((c) => c.denyForms);
    for (const name of 'abcdefghijklmn') expect(forms.some((f) => f === name || f.startsWith(`${name} `))).toBe(true);
  });

  it('strips assignments and wrappers for deny forms; only documented wrappers for allow', () => {
    const [cmd] = BashAnalyzer.analyze('FOO=1 timeout -s KILL 5 nice -n 3 rm -rf x').commands;
    expect(cmd?.denyForms).toContain('rm -rf x');
    expect(cmd?.allowForm).toBeUndefined(); // leading assignment
    expect(BashAnalyzer.analyze('timeout 5 nice -n 3 npm test').commands[0]?.allowForm).toBe('npm test');
    expect(BashAnalyzer.analyze('sudo npm test').commands[0]?.allowForm).toBe('sudo npm test');
    expect(BashAnalyzer.analyze('xargs grep x').commands[0]?.allowForm).toBe('grep x');
    expect(BashAnalyzer.analyze('xargs -n1 grep x').commands[0]?.allowForm).toBe('xargs -n1 grep x');
  });

  it('normalizes quoting before matching', () => {
    const [cmd] = BashAnalyzer.analyze(`r"m" -rf 'x y'`).commands;
    expect(cmd?.denyForms).toContain('rm -rf x y');
  });

  it('marks what cannot be evaluated statically', () => {
    for (const command of ['echo "unbalanced', 'eval x', 'source ./env.sh', '. ./env.sh', 'cat <<EOF\n$(id)\nEOF', '$X', 'r?m x', 'echo hi | sh', 'bash -c "$S"']) {
      expect(BashAnalyzer.analyze(command).uncertain.length, command).toBeGreaterThan(0);
    }
    for (const command of ["cat <<'EOF'\n$(not run)\nEOF", 'bash script.sh', 'echo $HOME', 'ls *.ts']) {
      expect(BashAnalyzer.analyze(command).uncertain, command).toEqual([]);
    }
  });

  it('collects file targets of redirects, tee and file readers', () => {
    const files = BashAnalyzer.analyze('cat a.txt < b.txt > c.txt 2>> d.log | tee e.txt; echo x &> /dev/null; head -n 2 f.txt').files;
    expect(files).toEqual([
      { access: 'read', path: 'a.txt' },
      { access: 'read', path: 'b.txt' },
      { access: 'write', path: 'c.txt' },
      { access: 'write', path: 'd.log' },
      { access: 'write', path: 'e.txt' },
      { access: 'read', path: 'f.txt' },
    ]);
  });
});

describe('path rules', () => {
  const anchors = { cwd: '/ws/proj', sourceDir: '/ws/proj', home: '/home/u' };
  const matches = (spec: string, p: string, kind: 'deny' | 'allow' = 'deny'): boolean => {
    const m = compilePathSpec(spec, kind, anchors);
    if (m.type === 'all') return true;
    if (m.type !== 'path') return false;
    return matchesPath(p, m.patterns, false);
  };

  it.each([
    ['./.env', '/ws/proj/.env', true],
    ['./.env', '/ws/proj/a/.env', false],
    ['.env', '/ws/proj/a/b/.env', true],
    ['.env', '/ws/other/.env', false],
    ['//etc/hosts', '/etc/hosts', true],
    ['~/.ssh/**', '/home/u/.ssh/id_rsa', true],
    ['~/.ssh/**', '/ws/proj/.ssh/id_rsa', false],
    ['/src/**/*.ts', '/ws/proj/src/a/b.ts', true],
    ['/src/**/*.ts', '/ws/proj/lib/src/b.ts', false],
    ['src/*.ts', '/ws/proj/src/a.ts', true],
    ['src/*.ts', '/ws/proj/src/a/b.ts', false],
    ['secrets/**', '/ws/proj/x/secrets/k', true],
    ['secrets/', '/ws/proj/x/secrets/k', true],
    ['build', '/ws/proj/build/out/a.js', true], // a matched directory covers its contents
    ['Finance (2024)/**', '/ws/proj/Finance (2024)/a', true],
    ['!keep.env', '/ws/proj/keep.env', false],
  ])('deny %j vs %j → %s', (spec, p, expected) => {
    expect(matches(spec, p)).toBe(expected);
  });

  it('anchors a single-directory pattern in allow rules', () => {
    expect(matches('src/**', '/ws/proj/vendor/src/a', 'allow')).toBe(false);
    expect(matches('src/**', '/ws/proj/src/a', 'allow')).toBe(true);
  });

  it('normalizes Windows paths to POSIX form', () => {
    expect(toPosixPath('C:\\Users\\a\\.env', 'win32')).toBe('/c/Users/a/.env');
    expect(toPosixPath('/tmp/back\\slash', 'linux')).toBe('/tmp/back\\slash');
    expect(toNativePath('/c/Users/a/.env', 'win32')).toBe('C:\\Users\\a\\.env');
    expect(toNativePath('/c', 'win32')).toBe('C:\\');
    expect(toNativePath(toPosixPath('D:\\w\\x', 'win32'), 'win32')).toBe('D:\\w\\x');
    expect(toNativePath('/tmp/x', 'linux')).toBe('/tmp/x');
    const m = compilePathSpec('//c/**/.env', 'deny', anchors);
    // Native Windows paths are rewritten only on Windows; on POSIX a backslash is part of the name.
    expect(m.type === 'path' && matchesPath('C:\\Users\\a\\.env', m.patterns, true)).toBe(process.platform === 'win32');
  });
});

describe('rule parsing', () => {
  it('splits Tool(spec) with literal parentheses', () => {
    expect(splitRule('Bash(echo (a))')).toEqual({ tool: 'Bash', spec: 'echo (a)' });
    expect(splitRule('Read')).toEqual({ tool: 'Read', spec: undefined });
    expect(splitRule('Bash(oops')).toBeUndefined();
  });

  it('splits CLI tool lists on commas and spaces outside parentheses', () => {
    expect(splitToolList('Bash(git log:*) Read,Edit(src/a b.ts)')).toEqual(['Bash(git log:*)', 'Read', 'Edit(src/a b.ts)']);
  });

  it('recognizes parameter rules only for deny/ask and ignores mcp/Write path rules', () => {
    const anchors = { cwd: '/p', sourceDir: '/p', home: '/h' };
    expect(parseRule('Bash(run_in_background:true)', 'deny', 'user', anchors)?.matcher).toMatchObject({ type: 'param', name: 'run_in_background', value: 'true' });
    expect(parseRule('Bash(run_in_background:true)', 'allow', 'user', anchors)?.matcher).toEqual({ type: 'never' });
    expect(parseRule('Write(docs/**)', 'deny', 'user', anchors)?.matcher).toEqual({ type: 'never' });
    expect(parseRule('Write', 'deny', 'user', anchors)?.matcher).toEqual({ type: 'all' });
    expect(parseRule('mcp__x__y(a)', 'deny', 'user', anchors)?.matcher).toEqual({ type: 'never' });
    expect(parseRule('Bash(*)', 'deny', 'user', anchors)?.matcher).toEqual({ type: 'all' });
  });
});
