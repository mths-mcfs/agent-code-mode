import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startsThisServer } from './self.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'acm-self-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const entry = path.join(dir, 'cli.js');
writeFileSync(entry, '');

describe('startsThisServer', () => {
  it.each([
    ['npx', ['-y', 'agent-code-mode', 'serve', '--host', 'claude']],
    ['npx', ['agent-code-mode@0.0.0', 'serve']],
    ['agent-code-mode', ['serve']],
    ['/usr/local/bin/agent-code-mode.cmd', []],
    ['node', [entry, 'serve']],
    ['node', ['./cli.js']],
  ])('%s %j is this server', (command, args) => {
    expect(startsThisServer(command, args, dir, entry)).toBe(true);
  });

  it('follows a symlink to the entry file', () => {
    const link = path.join(dir, 'link.js');
    symlinkSync(entry, link);
    expect(startsThisServer('node', [link], dir, entry)).toBe(true);
  });

  it.each([
    ['node', ['server.js']],
    ['npx', ['-y', '@example/agent-code-mode-tools']],
    ['uvx', ['mcp-server-fetch']],
    ['node', ['server.js', '--root', '/work/agent-code-mode']],
  ])('%s %j is another server', (command, args) => {
    expect(startsThisServer(command, args, dir, entry)).toBe(false);
  });
});
