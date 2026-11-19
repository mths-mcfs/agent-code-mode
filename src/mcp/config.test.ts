import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMcpConfig, parseMcpConfig } from './config.js';

describe('parseMcpConfig', () => {
  it('reads stdio servers in the .mcp.json format', () => {
    const r = parseMcpConfig(JSON.stringify({ mcpServers: { inventory: { command: 'node', args: ['server.js'], env: { API_KEY: 'k' } }, plain: { type: 'stdio', command: 'srv' } } }));
    expect(r).toEqual({
      ok: true,
      servers: [
        { name: 'inventory', command: 'node', args: ['server.js'], env: { API_KEY: 'k' } },
        { name: 'plain', command: 'srv', args: [], env: {} },
      ],
    });
  });

  it.each([
    ['not json', '{', 'not valid JSON'],
    ['no mcpServers', '{}', 'mcpServers'],
    ['an unknown top-level key', JSON.stringify({ mcpServers: {}, extra: 1 }), 'extra'],
    ['a remote server', JSON.stringify({ mcpServers: { web: { type: 'http', url: 'https://example.com/mcp' } } }), 'only stdio'],
    ['a url', JSON.stringify({ mcpServers: { web: { url: 'https://example.com/mcp' } } }), 'only stdio'],
    ['no command', JSON.stringify({ mcpServers: { srv: { args: [] } } }), 'command'],
    ['an empty command', JSON.stringify({ mcpServers: { srv: { command: '' } } }), 'must not be empty'],
    ['args that are not strings', JSON.stringify({ mcpServers: { srv: { command: 'x', args: [1] } } }), 'args'],
    ['an unknown server key', JSON.stringify({ mcpServers: { srv: { command: 'x', cwd: '/tmp' } } }), 'cwd'],
    ['a ${VAR} to expand', JSON.stringify({ mcpServers: { srv: { command: 'x', env: { KEY: '${SECRET}' } } } }), 'expands'],
    ['a bad env name', JSON.stringify({ mcpServers: { srv: { command: 'x', env: { 'A-B': 'v' } } } }), 'env.A-B'],
    ['a server name with __', JSON.stringify({ mcpServers: { 'a__b': { command: 'x' } } }), '`__`'],
    ['a server name with a space', JSON.stringify({ mcpServers: { 'a b': { command: 'x' } } }), 'letters, digits'],
    ['a server named __proto__', '{"mcpServers": {"__proto__": {"command": "x"}}}', '__proto__'],
    ['a server declared twice (the first invalid)', '{"mcpServers": {"srv": {"command": 42}, "srv": {"command": "node"}}}', 'appears twice'],
    ['mcpServers twice', '{"mcpServers": {}, "mcpServers": {"srv": {"command": "node"}}}', 'appears twice'],
    ['command twice', '{"mcpServers": {"srv": {"command": "node", "command": "node2"}}}', 'appears twice'],
    ['an env key __proto__', '{"mcpServers": {"srv": {"command": "node", "env": {"__proto__": "value"}}}}', '__proto__'],
    ['an escaped __proto__ key', '{"mcpServers": {"srv": {"command": "node", "env": {"\\u005f_proto__": "value"}}}}', '__proto__'],
  ])('refuses %s', (_label, text, message) => {
    const r = parseMcpConfig(text);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain(message);
  });

  it('equal keys in different objects, and strings that look like keys, are fine', () => {
    const r = parseMcpConfig('{"mcpServers": {"a": {"command": "x", "args": ["command", "{\\"command\\": 1}"], "env": {"command": "y"}}, "b": {"command": "x"}}}');
    expect(r.ok).toBe(true);
  });

  it('refuses the name this server is registered under', () => {
    const r = parseMcpConfig(JSON.stringify({ mcpServers: { 'agent-code-mode': { command: 'x' } } }), { reservedServerNames: ['agent-code-mode'] });
    expect(!r.ok && r.message).toContain('registered under');
  });
});

describe('loadMcpConfig', () => {
  it('names the file in its errors', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'acm-mcp-config-'));
    const file = path.join(dir, 'mcp.json');
    await writeFile(file, '{"mcpServers": {"srv": {}}}');
    const r = await loadMcpConfig(file);
    expect(!r.ok && r.message).toContain(file);
    const missing = await loadMcpConfig(path.join(dir, 'missing.json'));
    expect(!missing.ok && missing.message).toContain('cannot read');
  });
});
