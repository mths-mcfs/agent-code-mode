import { describe, expect, it } from 'vitest';
import { sanitize, type SanitizeContext } from '../lib/sanitize.ts';

const ctx: SanitizeContext = {
  paths: [
    { path: '/home/alice/work/bench/.work/runs/x/ws', label: '<workspace>' },
    { path: '/home/alice/work/bench/.work/runs/x', label: '<run>' },
    { path: '/home/alice/work/agent-code-mode', label: '<repo>' },
  ],
  home: '/home/alice',
  username: 'alice',
  hostname: 'alice-laptop',
};

describe('sanitizer', () => {
  it('removes home paths, usernames, hostnames, emails and tokens', () => {
    const transcript = [
      JSON.stringify({ type: 'system', cwd: '/home/alice/work/bench/.work/runs/x/ws', memory: '/home/alice/.claude/projects/p' }),
      JSON.stringify({ type: 'assistant', text: 'Edited /home/alice/work/bench/.work/runs/x/ws/src/a.js on alice-laptop for alice (alice@example.com).' }),
      JSON.stringify({ cmd: 'cat /home/bob/notes.txt', url: 'file:///home/alice/work/bench/.work/runs/x/ws/b.js' }),
      JSON.stringify({ auth: 'Bearer abcdefghijklmnopqrstuvwxyz012345', key: 'sk-ant-api03-abcdefghijklmnopqrstuv', gh: 'ghp_abcdefghijklmnopqrstuvwxyz0123', access_token: 'x.y.z' }),
      JSON.stringify({ memory: '/home/alice/.claude/projects/-home-alice-work-bench--work-runs-x-ws/memory/', other: '-home-carol-x' }),
      JSON.stringify({ win: 'C:\\Users\\alice\\repo', hook: 'node "/home/alice/work/agent-code-mode/bench/hooks/protect-file.mjs"' }),
    ].join('\n');
    const out = sanitize(transcript, ctx);
    expect(out).toContain('~/.claude/projects/<workspace>/memory/');
    for (const leak of ['carol', '/home/alice', 'alice', 'alice-laptop', 'alice@example.com', '/home/bob', 'abcdefghijklmnopqrstuvwxyz012345', 'sk-ant-api03', 'ghp_abc', '"x.y.z"']) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain('<workspace>/src/a.js');
    expect(out).toContain('file://<workspace>/b.js');
    expect(out).toContain('<repo>/bench/hooks/protect-file.mjs');
    expect(out).toContain('~/.claude/projects/p');
    expect(out).toContain('<email>');
    for (const line of out.split('\n')) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('redacts secrets inside escaped JSON and by key name, and decodes URL-encoded paths', () => {
    const nested = JSON.stringify({ payload: JSON.stringify({ api_key: 'arbitrary-secret-value', deeper: JSON.stringify({ password: 'pw-123' }) }) });
    const out = sanitize(nested, ctx);
    expect(out).not.toContain('arbitrary-secret-value');
    expect(out).not.toContain('pw-123');
    expect(JSON.parse(JSON.parse(out).payload).api_key).toBe('<redacted>');
    const byKey = sanitize(JSON.stringify({ authorization: 'opaque', Secret: 'x1', clientSecret: 'x2', creator_user_id: 'user-9', session_id: 's1', input_tokens: 12, token: 'tk' }), ctx);
    expect(JSON.parse(byKey)).toEqual({ authorization: '<redacted>', Secret: '<redacted>', clientSecret: '<redacted>', creator_user_id: '<redacted>', session_id: 's1', input_tokens: 12, token: '<redacted>' });
    const text = sanitize('plain "{\\"api_key\\":\\"v1\\"}" OPENAI_API_KEY=abc123 url %2Fhome%2Falice%2Fsecret.txt C:/Users/alice/x', ctx);
    for (const leak of ['v1', 'abc123', 'alice']) expect(text).not.toContain(leak);
    expect(text).toContain('~/secret.txt');
  });

  it('keeps tool names, relative arguments and numbers', () => {
    const line = JSON.stringify({ name: 'Edit', input: { file_path: 'src/handlers/orders.js' }, usage: { input_tokens: 1234 } });
    expect(sanitize(line, ctx)).toBe(line);
  });
});

describe('environment os label', () => {
  it('records only platform, kernel major.minor and arch', async () => {
    const { osLabel } = await import('../run.ts');
    expect(osLabel('linux', '7.2.15-1-somedistro', 'x64')).toBe('linux 7.2 x64');
    expect(osLabel('darwin', '25.1.0', 'arm64')).toBe('darwin 25.1 arm64');
    expect(osLabel('win32', 'weird', 'x64')).toBe('win32 unknown x64');
  });
});

describe('every file the harness writes is sanitized', () => {
  const denial = 'PreToolUse:Edit hook error: [node "/home/alice/work/agent-code-mode/bench/hooks/protect-file.mjs" "src/handlers/inventory.js"]: src/handlers/inventory.js is protected';
  const record = { schema: 1, host: 'claude', parsed: { denials: [denial], usage: { input: 3, cacheRead: 10 } }, files: { 'auth.txt': 'auth.txt' } };

  it('writes record.json with hook-path denials cleaned and the numbers and shape kept', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { writeSanitized } = await import('../lib/sanitize.ts');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-sanitize-'));
    const file = path.join(dir, 'record.json');
    await writeSanitized(file, JSON.stringify(record), ctx);
    const text = await readFile(file, 'utf8');
    expect(text).not.toMatch(/\/home\/|alice/);
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toEqual({ ...record, parsed: { ...record.parsed, denials: [expect.stringContaining('<repo>/bench/hooks/protect-file.mjs')] } });
  });

  it('cleans an existing results tree in place (record.json, env.json, summary, stderr, transcripts) and leaves .gz alone', async () => {
    const { mkdtemp, mkdir, readFile, writeFile, readdir } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { sanitizeTree } = await import('../lib/sanitize.ts');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-tree-'));
    const run = path.join(dir, 'claude', 'T8', 'A', 'h', '1');
    await mkdir(run, { recursive: true });
    await writeFile(path.join(run, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(path.join(run, 'stderr.txt'), `warning on alice-laptop: /home/alice/x\n`);
    await writeFile(path.join(run, 'transcript.jsonl'), `${JSON.stringify({ cwd: '/home/alice/work/agent-code-mode' })}\n`);
    await writeFile(path.join(dir, 'env.json'), JSON.stringify({ invocations: [{ cwd: '/home/alice/work/agent-code-mode' }] }));
    await writeFile(path.join(dir, 'summary.md'), '| alice | /home/alice |\n');
    await writeFile(path.join(run, 'transcript.jsonl.gz'), 'binary /home/alice');
    const changed = await sanitizeTree(dir, ctx);
    expect(changed).toHaveLength(5);
    const all: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (!p.endsWith('.gz')) all.push(await readFile(p, 'utf8'));
      }
    };
    await walk(dir);
    for (const text of all) expect(text).not.toMatch(/\/home\/|alice/);
    expect(await sanitizeTree(dir, ctx)).toEqual([]);
  });
});
