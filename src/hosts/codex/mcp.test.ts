import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PreparedMcpCall } from '../../core/types.js';
import { codexMcpDecision, discoverCodexMcp } from './mcp.js';

const cwd = path.resolve('/work/project');
const env = { HOME: '/home/u', PATH: '/usr/bin', TOKEN: 't-1', UNRELATED: 'x' };

function mcp(server: string, tool: string): PreparedMcpCall {
  return { id: 'c1', tool: 'mcp', args: { server, tool, input: {} }, effect: { server, tool, qualifiedName: `mcp__${server}__${tool}`, input: {}, timeoutMs: 60_000 } };
}

describe('Codex MCP servers', () => {
  it('starts a server as Codex does: its command, the default variables, env_vars and env, and its timeouts', () => {
    const { mcp: policy } = discoverCodexMcp(
      { mcp_servers: { a: { command: 'node', args: ['s.js'], env_vars: ['TOKEN'], env: { MODE: 'x' }, cwd: 'sub', startup_timeout_sec: 3, tool_timeout_sec: 9 } } },
      cwd,
      env,
      'config.toml',
    );
    expect(policy.servers).toEqual([
      { name: 'a', command: 'node', args: ['s.js'], env: { HOME: '/home/u', PATH: '/usr/bin', TOKEN: 't-1', MODE: 'x' }, cwd: path.join(cwd, 'sub'), startupTimeoutMs: 3_000, toolTimeoutMs: 9_000, origin: 'config.toml', autostart: false },
    ]);
  });

  it('leaves out disabled, remote and unreadable entries, and env_vars this server does not have', () => {
    const { mcp: policy } = discoverCodexMcp(
      {
        mcp_servers: {
          off: { command: 'node', enabled: false },
          remote: { url: 'https://x' },
          odd: { command: 'node', transport: 'x' },
          bad: { command: ['node'] },
          lost: { command: 'node', env_vars: ['NOPE'] },
          ok: { command: 'node' },
        },
      },
      cwd,
      env,
      'config.toml',
    );
    expect(policy.servers.map((s) => s.name)).toEqual(['ok']);
    expect(policy.notes).toHaveLength(4);
    expect(policy.notes.join(' ')).toContain('env_vars names NOPE');
  });

  it.each([
    ['approve', {}, 'on-request', 'allow'],
    ['prompt', {}, 'on-request', 'ask'],
    ['prompt', {}, 'never', 'deny'],
    ['auto', {}, 'on-request', 'deny'],
    [undefined, {}, 'never', 'deny'],
    ['approve', { disabled_tools: ['t'] }, 'on-request', 'deny'],
    ['approve', { enabled_tools: ['other'] }, 'on-request', 'deny'],
    ['approve', { enabled_tools: ['t'] }, 'on-request', 'allow'],
  ] as const)('approval_mode %s with %j under %s: %s', (mode, extra, approvalPolicy, kind) => {
    const tools = mode === undefined ? {} : { t: { approval_mode: mode } };
    const { rules } = discoverCodexMcp({ mcp_servers: { s: { command: 'node', tools, ...extra } } }, cwd, env, 'config.toml');
    expect(codexMcpDecision(mcp('s', 't'), rules, approvalPolicy).kind).toBe(kind);
  });

  it('starts with the session only a server with an approved tool it may call', () => {
    const { mcp: policy } = discoverCodexMcp(
      {
        mcp_servers: {
          yes: { command: 'node', tools: { t: { approval_mode: 'approve' } } },
          prompt: { command: 'node', tools: { t: { approval_mode: 'prompt' } } },
          off: { command: 'node', disabled_tools: ['t'], tools: { t: { approval_mode: 'approve' } } },
        },
      },
      cwd,
      env,
      'config.toml',
    );
    expect(Object.fromEntries(policy.servers.map((s) => [s.name, s.autostart]))).toEqual({ yes: true, prompt: false, off: false });
  });

  it('refuses a server Codex does not configure', () => {
    expect(codexMcpDecision(mcp('s', 't'), {}, 'on-request')).toMatchObject({ kind: 'deny', source: 'rule' });
  });
});
