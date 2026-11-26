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
  ids: new Map(),
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

  it('maps session, thread, event and API ids to stable placeholders across the files of a run', () => {
    const run = { ...ctx, ids: new Map<string, string>() };
    const session = '12345678-1234-4123-8123-123456789012';
    const transcript = [
      JSON.stringify({ type: 'system', session_id: session, uuid: '87654321-4321-4321-8321-210987654321' }),
      JSON.stringify({ type: 'assistant', message: { id: 'msg_FAKEfakeFAKEfake01', content: [{ type: 'tool_use', id: 'toolu_FAKEfakeFAKEfake01' }] }, request_id: 'req_FAKEfakeFAKEfake01', session_id: session }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_FAKEfakeFAKEfake01' }] }, session_id: session }),
    ].join('\n');
    const lines = sanitize(transcript, run).split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ type: 'system', session_id: '00000000-0000-4000-8000-000000000001', uuid: '00000000-0000-4000-8000-000000000002' });
    expect(lines[1]).toEqual({ type: 'assistant', message: { id: 'msg_000000000000000000000001', content: [{ type: 'tool_use', id: 'toolu_000000000000000000000001' }] }, request_id: 'req_000000000000000000000001', session_id: '00000000-0000-4000-8000-000000000001' });
    expect(lines[2].message.content[0].tool_use_id).toBe('toolu_000000000000000000000001');
    expect(sanitize(`stderr: session ${session} ended`, run)).toBe('stderr: session 00000000-0000-4000-8000-000000000001 ended');
    expect(sanitize(sanitize(transcript, run), { ...ctx, ids: new Map() })).toBe(sanitize(transcript, run));
  });

  it('redacts assignments and header lines of every name ending in TOKEN or KEY', () => {
    const text = sanitize(['token=tk-1', 'NPM_TOKEN=npm_FAKE0001', 'export HF_TOKEN="hf_FAKE0002"', 'GH_TOKEN: ghx-3', '> x-api-key: sk-FAKE-0004', 'api-key: k5', 'PRIVATE_KEY=pk6', 'OPENAI_API_KEY=abc7'].join('\n'), ctx);
    for (const leak of ['tk-1', 'npm_FAKE0001', 'hf_FAKE0002', 'ghx-3', 'sk-FAKE-0004', 'k5', 'pk6', 'abc7']) expect(text).not.toContain(leak);
    expect(text).toContain('NPM_TOKEN=<redacted>');
    expect(text).toContain('> x-api-key: <redacted>');
    const prose = 'monkey=3 keyboard: x tokens: 5 max_tokens=100 the key: value input_tokens: 12';
    expect(sanitize(prose, ctx)).toBe(prose);
  });

  it('redacts whole quoted values and whole Authorization header values, also inside JSON', () => {
    expect(sanitize("HF_TOKEN='opaque value' cmd", ctx)).toBe('HF_TOKEN=<redacted> cmd');
    expect(sanitize('HF_TOKEN="opaque value" cmd', ctx)).toBe('HF_TOKEN=<redacted> cmd');
    expect(sanitize('run "HF_TOKEN=\\"opaque value\\" cmd"', ctx)).toBe('run "HF_TOKEN=<redacted> cmd"');
    expect(JSON.parse(sanitize(JSON.stringify({ cmd: "HF_TOKEN='x y' cmd" }), ctx))).toEqual({ cmd: 'HF_TOKEN=<redacted> cmd' });
    expect(JSON.parse(sanitize(JSON.stringify({ cmd: 'HF_TOKEN="x y" cmd' }), ctx))).toEqual({ cmd: 'HF_TOKEN=<redacted> cmd' });
    expect(JSON.parse(sanitize(JSON.stringify({ payload: JSON.stringify({ cmd: "NPM_TOKEN='a b' npm publish" }) }), ctx))).toEqual({ payload: JSON.stringify({ cmd: 'NPM_TOKEN=<redacted> npm publish' }) });
    expect(sanitize('> Authorization: Basic dXNlcjpwdw==', ctx)).toBe('> Authorization: <redacted>');
    expect(JSON.parse(sanitize(JSON.stringify({ out: 'Proxy-Authorization: Basic YTpi\nnext' }), ctx))).toEqual({ out: 'Proxy-Authorization: <redacted>\nnext' });
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
