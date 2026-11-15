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

  it('keeps tool names, relative arguments and numbers', () => {
    const line = JSON.stringify({ name: 'Edit', input: { file_path: 'src/handlers/orders.js' }, usage: { input_tokens: 1234 } });
    expect(sanitize(line, ctx)).toBe(line);
  });
});
