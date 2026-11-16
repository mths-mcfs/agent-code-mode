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
