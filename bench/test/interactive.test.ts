import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeInteractiveArgs, interactiveEnv, interactiveProgress, parseClaudeInteractiveTranscript, replScriptTools, seededClaudeJson, trimInteractiveTranscript } from '../lib/claude-interactive.ts';
import { costFromUsage, loadPricing } from '../lib/pricing.ts';
import { checkArm, checkSurface } from '../lib/record.ts';
import { classifyScreen, DENY_NOTE, driveInteractive, serverAlive, tmuxVersion } from '../lib/tmux.ts';
import { codeModeReasons } from '../run.ts';

const F = path.join(import.meta.dirname, '..', 'parser-fixtures');
const read = (name: string): string => readFileSync(path.join(F, name), 'utf8');
const lines = (...entries: unknown[]): string => `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
const NO_USAGE = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, reasoning: null };

describe('interactive Claude transcript parser', () => {
  it('reads a recorded Code Mode run (claude-D.jsonl, Claude Code 2.1.326, T2)', () => {
    const { parsed: p, facts } = parseClaudeInteractiveTranscript(read('claude-D.jsonl'));
    expect(p.requests).toBe(4);
    expect(p.turns).toBe(4);
    expect(p.usage).toEqual({ input: 8, output: 577, cacheCreation: 4104, cacheRead: 44726, reasoning: 0, cacheCreation5m: 0, cacheCreation1h: 4104 });
    expect(p.hostCostUsd).toBeNull();
    expect(p.model).toBe('claude-opus-5-5');
    expect(p.toolCalls).toEqual({ native: 0, run: 0, codeMode: 3, other: 0, byName: { REPL: 3 } });
    expect(p.innerCalls).toEqual({ total: 5, byTool: { Bash: 2, Read: 2, Edit: 1 } });
    expect(p.finalAnswer).toMatch(/truncate/);
    expect(p.hostError).toBeNull();
    expect(checkArm('claude', 'D', p.toolCalls)).toEqual({ fallback: false, reasons: [] });
    expect(checkSurface('claude', 'D', p.availableTools ?? [])).toEqual([]);
    expect(checkSurface('claude', 'A', p.availableTools ?? []).join()).toMatch(/expected exactly/);
    expect(facts).toMatchObject({ efforts: ['medium'], permissionModes: ['default'], replMode: true });
    expect(costFromUsage(loadPricing(), 'claude-opus-5-5', p.usage ?? NO_USAGE)).toBeCloseTo(0.0533492, 9);
    // The session's own record also counts a side request the transcript lacks (the Haiku session title).
    expect(facts.sessionCost?.totalUsd).toBeCloseTo(0.0603898, 9);
    expect(Object.keys(facts.sessionCost?.byModel ?? {}).sort()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5']);
  });

  it('prices the session cost record per model exactly as pricing.json does with the TTL split', () => {
    const pricing = loadPricing();
    const cost = parseClaudeInteractiveTranscript(read('claude-D.jsonl')).facts.sessionCost;
    let total = 0;
    for (const [model, u] of Object.entries(cost?.byModel ?? {})) {
      const usage = { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheCreation: u.cacheCreationEphemeral5mInputTokens + u.cacheCreationEphemeral1hInputTokens, cacheCreation5m: u.cacheCreationEphemeral5mInputTokens, cacheCreation1h: u.cacheCreationEphemeral1hInputTokens, reasoning: null };
      const c = costFromUsage(pricing, model, usage);
      expect(c, model).toBeCloseTo(u.costUSD, 9);
      total += c ?? 0;
    }
    expect(total).toBeCloseTo(cost?.totalUsd ?? -1, 9);
  });

  it('counts one request per message id, however many entries a response is written as', () => {
    const text = read('claude-D.jsonl');
    const real = text.split('\n').filter((l) => l.includes('"type":"assistant"') && !l.includes('<synthetic>'));
    const once = parseClaudeInteractiveTranscript(text).parsed;
    const again = parseClaudeInteractiveTranscript(`${text}${real.join('\n')}\n`).parsed;
    expect(again.requests).toBe(once.requests);
    expect(again.usage).toEqual(once.usage);
    expect(again.toolCalls).toEqual(once.toolCalls);
  });

  const replUse = (id: string, msg: string, stop: string) => ({ type: 'assistant', message: { id: msg, model: 'claude-opus-5-5', stop_reason: stop, content: [{ type: 'tool_use', id, name: 'REPL', input: { code: 'x' } }], usage: { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5 } } } });
  const inner = (id: string, name: string) => ({ type: 'assistant', isVirtual: true, message: { id: `syn-${id}`, model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'tool_use', id, name, input: {} }], usage: { input_tokens: 0, output_tokens: 0 } } });
  const result = (id: string, content: string, extra: Record<string, unknown> = {}) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: extra['is_error'] ?? false }] }, ...extra });
  const answer = (msg: string) => ({ type: 'assistant', message: { id: msg, model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 2, output_tokens: 3 } } });

  it('counts a denied inner call once, not again from the REPL summary, and reads the end of the turn', () => {
    const text = lines(
      { type: 'repl-mode', replMode: true },
      { type: 'user', message: { role: 'user', content: 'task' } },
      replUse('toolu_1', 'msg_1', 'tool_use'),
      inner('repl_a', 'Bash'),
      result('repl_a', 'The user doesn\'t want to proceed with this tool use. The tool use was rejected.', { is_error: true, permissionDecision: { decision: 'reject' } }),
      inner('repl_b', 'Read'),
      result('repl_b', ''),
      result('toolu_1', '<repl-output><refused>Bash refused: denied</refused></repl-output>'),
      answer('msg_2'),
    );
    expect(interactiveProgress(text)).toEqual({ promptSeen: true, outerToolUses: 1, finished: false });
    const ended = `${text}${JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1200 })}\n`;
    expect(interactiveProgress(ended).finished).toBe(true);
    const { parsed: p } = parseClaudeInteractiveTranscript(ended);
    expect(p.denials).toHaveLength(1);
    expect(p.innerCalls).toEqual({ total: 2, byTool: { Bash: 1, Read: 1 } });
    expect(p.usage).toMatchObject({ input: 4, output: 13, cacheRead: 100, cacheCreation: 5 });
    expect(p.hostDurationMs).toBe(1200);
    expect(p.finalAnswer).toBe('done');
    expect(parseClaudeInteractiveTranscript(text).parsed.hostError).toBe('turn did not finish');
    const cut = lines({ type: 'user', message: { content: 'task' } }, replUse('toolu_1', 'msg_1', 'tool_use'), result('toolu_1', 'x'), { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
    expect(parseClaudeInteractiveTranscript(cut).parsed.hostError).toBe('turn interrupted');
  });

  it('throws on a transcript without a model response, or a response without usage', () => {
    expect(() => parseClaudeInteractiveTranscript(lines({ type: 'user', message: { content: 'task' } }))).toThrow(/no model response/);
    const noUsage = { type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] } };
    expect(() => parseClaudeInteractiveTranscript(lines(noUsage))).toThrow(/msg_1 has no usage/);
  });

  it('keeps what the parser reads and drops request blobs and account entries', () => {
    const text = read('claude-D.jsonl');
    const raw = `${lines(
      { type: 'api-request-blob', hash: 'x', message: { content: [{ type: 'text', text: 'system prompt' }] } },
      { type: 'session-owner', accountUuid: 'acc' },
      { type: 'attachment', attachment: { type: 'session_context', context: { userEmail: 'someone@example.com' } } },
      { type: 'attachment', attachment: { type: 'environment', snapshot: { osVersion: 'Linux 1.2.3-distro' } } },
      { type: 'api-request-shape', shape: { system: [{ type: 'text', text: 'long system prompt' }], tools: [{ name: 'Poll', description: 'p' }] } },
    )}${text}`;
    const trimmed = trimInteractiveTranscript(raw);
    expect(trimmed).not.toMatch(/system prompt|someone@example.com|acc"|distro/);
    expect(trimmed).toContain('{"type":"api-request-shape","shape":{"tools":[{"name":"Poll"}]}}');
    const a = parseClaudeInteractiveTranscript(text).parsed;
    const b = parseClaudeInteractiveTranscript(trimmed).parsed;
    expect({ ...b, evidence: {}, availableTools: null }).toEqual({ ...a, evidence: {}, availableTools: null });
    expect([...(b.availableTools ?? [])].sort()).toEqual([...(a.availableTools ?? []), 'Poll'].sort());
    expect(trimInteractiveTranscript(text)).toBe(text);
  });

  it('reads the tools a REPL script can call from the REPL description', () => {
    const description = 'intro\ninterface Tools {\n  Edit(input: {\n  }): Promise<X>\n  Read(input: {\n  }): Promise<Y>\n  // Also callable as tools.<name>(input); describeTool(name) returns each one\'s input schema: EndConversation, Other\n}\n';
    expect(replScriptTools(description).sort()).toEqual(['Edit', 'EndConversation', 'Other', 'Read']);
    expect(replScriptTools('no tools block')).toEqual([]);
  });
});

describe('interactive session setup', () => {
  it('passes an allowlisted environment: nothing of a calling Claude session, no API keys', () => {
    const source = { HOME: '/h', PATH: '/bin', LANG: 'C.UTF-8', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '1', ANTHROPIC_API_KEY: 'k', TMUX: '/tmp/x', OTHER: 'y' };
    expect(interactiveEnv(source, '/cfg')).toEqual({ HOME: '/h', PATH: '/bin', LANG: 'C.UTF-8', TERM: 'xterm-256color', CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' });
  });

  it('starts claude with the -p flags that exist interactively, plus REPL', () => {
    const d = claudeInteractiveArgs({ model: 'm', effort: 'medium', settingsFile: 's', mcpConfigFile: 'c', sessionId: 'id' });
    expect(d).not.toContain('-p');
    expect(d).not.toContain('--max-turns');
    expect(d).toEqual(expect.arrayContaining(['--setting-sources', 'project', '--permission-mode', 'default', '--strict-mcp-config', '--session-id', 'id', '--effort', 'medium']));
    expect(d.slice(d.indexOf('--tools'))).toEqual(['--tools', 'Bash,Read,Write,Edit,Glob,Grep,REPL', '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep']);
  });

  it('seeds the answers to every first-run dialog for the workspace, and nothing of the account', () => {
    const seed = seededClaudeJson('/ws', '2.1.326');
    expect(seed).toMatchObject({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.326', codeModeCaveatsAcceptedV1: true, claudeInChromeDefaultEnabled: false, projects: { '/ws': { hasTrustDialogAccepted: true } } });
    expect(JSON.stringify(seed)).not.toMatch(/oauth|email|userID/i);
  });
});

describe('screen reading', () => {
  const rule = '─'.repeat(40);
  it('sees the ready prompt and the Code Mode line', () => {
    const s = classifyScreen(['  Claude Code v2.1.326', '⚠ Code Mode (experimental) is on · this session can be resumed only with Code Mode on', rule, '❯ Try "fix lint errors"', rule, '  ⏸ manual mode on · ? for shortcuts'].join('\n'));
    expect(s).toMatchObject({ ready: true, dialog: null, permission: null, codeModeUnavailable: null });
    expect(s.codeModeOn).toMatch(/is on/);
    expect(classifyScreen('Code Mode isn\'t available here: for now it only works in the interactive terminal').codeModeUnavailable).toMatch(/isn't available/);
  });

  it('reports a first-run dialog instead of answering it blind', () => {
    const s = classifyScreen([' Quick safety check: Is this a project you created or one you trust?', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'].join('\n'));
    expect(s.dialog).toMatch(/Quick safety check/);
    expect(s.ready).toBe(false);
  });

  it('reads a permission prompt below the answer, not the numbered list above it', () => {
    const s = classifyScreen([
      '● Here is the plan:',
      '  1. Not an option',
      '  2. Neither',
      rule,
      ' Bash command',
      ' touch b.txt',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and always allow access to <dir> from this project',
      '   3. Yes, and switch to auto mode',
      '   4. No',
      ' Esc to cancel · Tab to amend',
    ].join('\n'));
    expect(s.permission).toEqual({ options: [{ n: 1, text: 'Yes' }, { n: 2, text: 'Yes, and always allow access to <dir> from this project' }, { n: 3, text: 'Yes, and switch to auto mode' }, { n: 4, text: 'No' }], selected: 1 });
    expect(s.ready).toBe(false);
  });
});

describe('arm D validity', () => {
  const facts = parseClaudeInteractiveTranscript(read('claude-D.jsonl')).facts;
  const seen = { stop: 'finished', problem: null, codeModeLine: '⚠ Code Mode (experimental) is on', plugins: [], serverGone: true };
  const opts = { dryRun: false, claudeEffort: 'medium' as const };
  it('accepts what a valid Code Mode run shows', () => {
    expect(codeModeReasons(opts, seen, facts)).toEqual([]);
  });
  it('needs observed evidence, not the intended configuration', () => {
    expect(codeModeReasons(opts, { ...seen, codeModeLine: null }, facts)).toEqual(['Code Mode on was not seen on screen']);
    expect(codeModeReasons(opts, null, facts)).toEqual(['interactive session not observed']);
    expect(codeModeReasons({ ...opts, claudeEffort: 'high' }, seen, facts)).toEqual(['requests ran with effort [medium], expected high']);
    expect(codeModeReasons(opts, { ...seen, stop: 'max-turns' }, facts)).toEqual(['host error: error_max_turns']);
    expect(codeModeReasons(opts, { ...seen, plugins: null }, facts)).toEqual(['session .claude.json not readable: plugins not observed']);
    expect(codeModeReasons(opts, { ...seen, serverGone: false }, facts)).toEqual(['the tmux server was still running after the run']);
    expect(codeModeReasons(opts, seen, { ...facts, replMode: false })).toEqual(['the transcript does not record Code Mode (repl-mode)']);
    expect(codeModeReasons(opts, seen, { ...facts, innerByTool: { ...facts.innerByTool, WebFetch: 1 } })).toEqual(['REPL scripts called tools outside the arm A tools: WebFetch']);
    expect(codeModeReasons(opts, seen, { ...facts, permissionModes: ['default', 'auto'] })).toEqual(['permission mode auto recorded, expected default']);
  });
});

describe.skipIf(tmuxVersion() === null)('tmux driver', () => {
  const host = path.join(import.meta.dirname, 'fake-interactive-host.mjs');
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'acm-tmux-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const drive = (name: string, mode: string, maxTurns = 60) => {
    const transcript = path.join(dir, name, 'session.jsonl');
    const env = { ...interactiveEnv({ ...process.env, CLAUDECODE: '1', ANTHROPIC_API_KEY: 'k' }, path.join(dir, name)) };
    return {
      transcript,
      run: driveInteractive({ cwd: dir, command: [process.execPath, host, transcript, path.join(F, 'claude-D.jsonl'), mode], env, prompt: 'Fix the bug.\nLine two.', transcriptFile: () => (existsSync(transcript) ? transcript : null), timeoutMs: 30_000, maxTurns, scratchDir: dir, readyTimeoutMs: 10_000, pollMs: 100 }),
    };
  };

  it('pastes the prompt, waits for the end of the turn in the transcript, exits the host and kills its server', async () => {
    const { transcript, run } = drive('finish', 'finish');
    const out = await run;
    expect(out).toMatchObject({ stop: 'finished', problem: null, exitCode: 0, timedOut: false, permissionPrompts: 0 });
    expect(out.codeModeLine).toMatch(/Code Mode \(experimental\) is on/);
    const text = readFileSync(transcript, 'utf8');
    // One paste, as a terminal sends it (tmux turns LF into CR): the line break inside it does not submit.
    expect(JSON.parse(text.split('\n')[0] ?? '')).toEqual({ type: 'user', message: { role: 'user', content: 'Fix the bug.\rLine two.' } });
    expect(parseClaudeInteractiveTranscript(text).parsed.hostError).toBeNull();
    expect(serverAlive(out.server)).toBe(false);
    expect(existsSync(path.join(process.env['TMUX_TMPDIR'] ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, out.server))).toBe(false);
    const env: string[] = JSON.parse(readFileSync(`${transcript}.env`, 'utf8'));
    expect(env).toContain('CLAUDE_CODE_EXPERIMENTAL_CODE_MODE');
    expect(env.filter((k) => k === 'CLAUDECODE' || k === 'ANTHROPIC_API_KEY' || k === 'TMUX')).toEqual([]);
  }, 60_000);

  it('denies a permission prompt for that call only: No, Tab, the note, Enter', async () => {
    const { transcript, run } = drive('deny', 'deny');
    const out = await run;
    expect(out).toMatchObject({ stop: 'finished', problem: null, exitCode: 0, permissionPrompts: 1 });
    const keys: string = JSON.parse(readFileSync(`${transcript}.keys`, 'utf8'));
    expect(keys.replace(/\x1bO/g, '\x1b[')).toBe(`\x1b[B\x1b[B\t${DENY_NOTE}\r`);
    expect(serverAlive(out.server)).toBe(false);
  }, 60_000);

  it('stops at the turn cap, and reports a prompt that never reached the transcript', async () => {
    const capped = await drive('cap', 'finish', 2).run;
    expect(capped).toMatchObject({ stop: 'max-turns', problem: null });
    const hung = await drive('hang', 'hang').run;
    expect(hung).toMatchObject({ stop: 'not-submitted', problem: 'the task prompt never reached the transcript' });
    expect([capped.server, hung.server].map(serverAlive)).toEqual([false, false]);
  }, 60_000);
});
