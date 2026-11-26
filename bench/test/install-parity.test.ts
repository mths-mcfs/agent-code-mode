import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { cliArgv, codexServerBlock, companionHookEntry, mcpJsonEntry } from '../../src/install.js';
import { claudeMcpConfig } from '../lib/claude.ts';
import { codexConfigToml } from '../lib/codex.ts';
import { claudeProjectSettings, companionHookCommand } from '../lib/workspace.ts';
import { generateFixture } from '../fixture/generate.ts';
import { TASKS } from '../tasks/index.ts';

// The local entry `install --local` registers, so both sides name the same server file.
const entry = cliArgv(true)[1] ?? '';
const ServerTable = z.looseObject({ 'agent-code-mode': z.looseObject({ command: z.string(), args: z.array(z.string()) }) });

function codexServer(toml: string): Record<string, unknown> {
  const { env: _env, ...server } = ServerTable.parse(z.looseObject({ mcp_servers: z.unknown() }).parse(parseToml(toml)).mcp_servers)['agent-code-mode'];
  return server;
}

describe('the agent-code-mode arms run the server as the installer configures it', () => {
  it('Codex arm C uses the installed server block', () => {
    const bench = codexConfigToml({ arm: 'C', model: 'm', effort: 'low', codexHome: '/h', catalogFile: null, serverEntry: entry, nodePath: process.execPath, emptyServerEntry: '/e.mjs' });
    expect(codexServer(bench)).toEqual(codexServer(codexServerBlock(true)));
  });

  it('Claude arm B registers the installed server entry and companion hook', () => {
    expect(z.looseObject({ mcpServers: z.record(z.string(), z.unknown()) }).parse(claudeMcpConfig('B', entry)).mcpServers).toEqual({ 'agent-code-mode': mcpJsonEntry(true) });
    const settings = claudeProjectSettings(TASKS.T8, generateFixture(), companionHookCommand(entry));
    const hooks = z.object({ hooks: z.object({ PreToolUse: z.array(z.unknown()) }) }).parse(settings).hooks.PreToolUse;
    expect(hooks).toContainEqual(companionHookEntry(true));
  });
});
