import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeInteractiveArgs, interactiveEnv, interactiveProgress, parseClaudeInteractiveTranscript, replScriptTools, seededClaudeJson, trimInteractiveTranscript } from '../lib/claude-interactive.ts';
import { costFromUsage, loadPricing } from '../lib/pricing.ts';
import { checkArm, checkSurface } from '../lib/record.ts';
import { classifyScreen } from '../lib/tmux.ts';
import { interactiveReasons } from '../run.ts';

const F = path.join(import.meta.dirname, '..', 'parser-fixtures');
const read = (name: string): string => readFileSync(path.join(F, name), 'utf8');
const lines = (...entries: unknown[]): string => `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;

describe('interactive Claude transcript parser', () => {
  it('reads a real Code Mode run (claude-D.jsonl, Claude Code 2.1.326, T2)', () => {
    const { parsed: p, facts } = parseClaudeInteractiveTranscript(read('claude-D.jsonl'));
    expect(p.requests).toBe(4);
    // Like -p num_turns: the model's tool calls (3 REPL) plus one.
    expect(p.turns).toBe(4);
    expect(p.usage).toEqual({ input: 8, output: 577, cacheCreation: 4104, cacheRead: 44726, reasoning: 0, cacheCreation5m: 0, cacheCreation1h: 4104 });
    expect(p.hostCostUsd).toBeNull();
    expect(p.model).toBe('claude-opus-5-5');
    expect(p.toolCalls).toEqual({ native: 0, run: 0, codeMode: 3, other: 0, byName: { REPL: 3 } });
    // The synthetic entries of the calls the scripts made are inner calls, never model tool calls.
    expect(p.innerCalls).toEqual({ total: 5, byTool: { Bash: 2, Read: 2, Edit: 1 } });
    expect(p.finalAnswer).toMatch(/truncate/);
    expect(p.hostError).toBeNull();
    expect(checkArm('claude', 'D', p.toolCalls)).toEqual({ fallback: false, reasons: [] });
    expect(checkSurface('claude', 'D', p.availableTools ?? [])).toEqual([]);
    expect(checkSurface('claude', 'A', p.availableTools ?? []).join()).toMatch(/expected exactly/);
    expect(facts).toMatchObject({ efforts: ['medium'], permissionModes: ['default'], replMode: true, finished: true, interrupted: false });
    // Cost from the transcript's requests; the session record also counts requests outside the transcript.
    expect(costFromUsage(loadPricing(), 'claude-opus-5-5', p.usage ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, reasoning: null })).toBeCloseTo(0.0533492, 9);
    expect(facts.sessionCost?.totalUsd).toBeCloseTo(0.0603898, 9);
    expect(Object.keys(facts.sessionCost?.byModel ?? {}).sort()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5']);
  });

  it('prices the session cost record per model exactly like pricing.json with the TTL split', () => {
    const pricing = loadPricing();
    for (const name of ['claude-D.jsonl', 'claude-A-interactive.jsonl']) {
      const cost = parseClaudeInteractiveTranscript(read(name)).facts.sessionCost;
      expect(cost).not.toBeNull();
      let total = 0;
      for (const [model, u] of Object.entries(cost?.byModel ?? {})) {
        const usage = { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheCreation: u.cacheCreationEphemeral5mInputTokens + u.cacheCreationEphemeral1hInputTokens, cacheCreation5m: u.cacheCreationEphemeral5mInputTokens, cacheCreation1h: u.cacheCreationEphemeral1hInputTokens, reasoning: null };
        const c = costFromUsage(pricing, model, usage);
        expect(c, model).toBeCloseTo(u.costUSD, 9);
        total += c ?? 0;
      }
      expect(total).toBeCloseTo(cost?.totalUsd ?? -1, 9);
    }
  });

  it('counts one request per message id, however many entries a response is written as', () => {
    // Pilot run (native interactive): one response is written as two entries (two tool calls).
    const text = read('claude-A-interactive.jsonl');
    const assistant = text.split('\n').filter((l) => l.includes('"type":"assistant"'));
    const { parsed: p } = parseClaudeInteractiveTranscript(text);
    expect(assistant.length).toBeGreaterThan(p.requests ?? 0);
    expect(p.requests).toBe(4);
    expect(p.turns).toBe(5);
    expect(p.toolCalls).toEqual({ native: 4, run: 0, codeMode: 0, other: 0, byName: { Bash: 3, Edit: 1 } });
    // A repeated entry changes nothing.
    const again = parseClaudeInteractiveTranscript(`${text}${assistant.join('\n')}\n`).parsed;
    expect(again.requests).toBe(4);
    expect(again.usage).toEqual(p.usage);
    expect(again.toolCalls).toEqual(p.toolCalls);
  });

  it('a run without REPL is not arm D (native interactive pilot, claude-A-interactive.jsonl)', () => {
    const { parsed: p, facts } = parseClaudeInteractiveTranscript(read('claude-A-interactive.jsonl'));
    expect(p.innerCalls).toBeNull();
    expect(facts.replMode).toBe(false);
    expect(checkArm('claude', 'D', p.toolCalls).reasons).toEqual(['Code Mode arm made no REPL call', 'Code Mode arm made 4 direct native file/shell tool call(s)']);
    expect(checkArm('claude', 'A', p.toolCalls)).toEqual({ fallback: false, reasons: [] });
    // The interactive session's harness tools (EndConversation, advisor...) are left out of the comparison.
    expect(checkSurface('claude', 'A', p.availableTools ?? [])).toEqual([]);
    expect(interactiveReasons({ dryRun: true, claudeEffort: 'medium' }, { arm: 'D' }, null, facts)).toContain('the transcript does not record Code Mode (repl-mode)');
  });

  const replUse = (id: string, msg: string, stop: string) => ({ type: 'assistant', message: { id: msg, model: 'claude-opus-5-5', stop_reason: stop, content: [{ type: 'tool_use', id, name: 'REPL', input: { code: 'x' } }], usage: { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5 } } } });
  const inner = (id: string, name: string) => ({ type: 'assistant', isVirtual: true, message: { id: `syn-${id}`, model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'tool_use', id, name, input: {} }], usage: { input_tokens: 0, output_tokens: 0 } } });
  const result = (id: string, content: string, extra: Record<string, unknown> = {}) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: extra['is_error'] ?? false }] }, ...extra });
  const answer = (msg: string) => ({ type: 'assistant', message: { id: msg, model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 2, output_tokens: 3 } } });

  it('counts a denied inner call once (not again from the REPL summary) and reads the end of the turn', () => {
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
    const { parsed: p, facts } = parseClaudeInteractiveTranscript(ended);
    expect(p.denials).toHaveLength(1);
    expect(p.innerCalls).toEqual({ total: 2, byTool: { Bash: 1, Read: 1 } });
    expect(p.usage).toMatchObject({ input: 4, output: 13, cacheRead: 100, cacheCreation: 5 });
    expect(p.hostDurationMs).toBe(1200);
    expect(p.finalAnswer).toBe('done');
    expect(facts.finished).toBe(true);
    // Without the end of the turn, the run did not finish; a turn cut by the user is reported as such.
    expect(parseClaudeInteractiveTranscript(text).parsed.hostError).toBe('turn did not finish');
    const cut = lines({ type: 'user', message: { content: 'task' } }, replUse('toolu_1', 'msg_1', 'tool_use'), result('toolu_1', 'x'), { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
    expect(parseClaudeInteractiveTranscript(cut).parsed.hostError).toBe('turn interrupted');
  });

  it('throws on a transcript without a model response', () => {
    expect(() => parseClaudeInteractiveTranscript(lines({ type: 'user', message: { content: 'task' } }))).toThrow(/no model response/);
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
    // Same numbers (the added shape only adds its tool to the surface).
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
    const env = interactiveEnv(source, { configDir: '/cfg', codeMode: true });
    expect(env).toEqual({ HOME: '/h', PATH: '/bin', LANG: 'C.UTF-8', TERM: 'xterm-256color', CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' });
    expect(interactiveEnv(source, { configDir: '/cfg', codeMode: false })).not.toHaveProperty('CLAUDE_CODE_EXPERIMENTAL_CODE_MODE');
  });

  it('starts claude with the -p flags that exist interactively, REPL only in Code Mode', () => {
    const d = claudeInteractiveArgs({ codeMode: true, model: 'm', effort: 'medium', settingsFile: 's', mcpConfigFile: 'c', sessionId: 'id' });
    expect(d).not.toContain('-p');
    expect(d).not.toContain('--max-turns');
    expect(d).toEqual(expect.arrayContaining(['--setting-sources', 'project', '--permission-mode', 'default', '--strict-mcp-config', '--session-id', 'id', '--effort', 'medium']));
    expect(d.slice(d.indexOf('--tools'))).toEqual(['--tools', 'Bash,Read,Write,Edit,Glob,Grep,REPL', '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep']);
    const a = claudeInteractiveArgs({ codeMode: false, model: 'm', effort: 'medium', settingsFile: 's', mcpConfigFile: 'c', sessionId: 'id' });
    expect(a[a.indexOf('--tools') + 1]).toBe('Bash,Read,Write,Edit,Glob,Grep');
  });

  it('seeds the answers to every first-run dialog for the workspace', () => {
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

describe('interactive run validity', () => {
  const facts = parseClaudeInteractiveTranscript(read('claude-D.jsonl')).facts;
  const seen = { codeMode: true, stop: 'finished', problem: null, codeModeLine: '⚠ Code Mode (experimental) is on', permissionPrompts: 0, plugins: [], serverGone: true };
  const opts = { dryRun: false, claudeEffort: 'medium' as const };
  it('accepts what a valid Code Mode run shows', () => {
    expect(interactiveReasons(opts, { arm: 'D' }, seen, facts)).toEqual([]);
  });
  it('needs observed evidence, not the intended configuration', () => {
    expect(interactiveReasons(opts, { arm: 'D' }, { ...seen, codeModeLine: null }, facts)).toEqual(['Code Mode on was not seen on screen']);
    expect(interactiveReasons(opts, { arm: 'D' }, null, facts)).toEqual(['interactive session not observed']);
    expect(interactiveReasons({ ...opts, claudeEffort: 'high' }, { arm: 'D' }, seen, facts)).toEqual(['requests ran with effort [medium], expected high']);
    expect(interactiveReasons(opts, { arm: 'D' }, { ...seen, stop: 'max-turns' }, facts)).toEqual(['host error: error_max_turns']);
    expect(interactiveReasons(opts, { arm: 'D' }, { ...seen, serverGone: false }, facts)).toEqual(['the tmux server was still running after the run']);
    expect(interactiveReasons(opts, { arm: 'D' }, seen, { ...facts, innerByTool: { ...facts.innerByTool, WebFetch: 1 } })).toEqual(['REPL scripts called tools outside the arm A tools: WebFetch']);
    expect(interactiveReasons(opts, { arm: 'D' }, seen, { ...facts, permissionModes: ['default', 'auto'] })).toEqual(['permission mode auto recorded, expected default']);
    // The native pilot must not have Code Mode on.
    expect(interactiveReasons(opts, { arm: 'A' }, { ...seen, codeMode: false }, facts)).toEqual([
      'Code Mode was on in a native interactive run: ⚠ Code Mode (experimental) is on',
      'the transcript records Code Mode (repl-mode) in a native run',
    ]);
  });
});
