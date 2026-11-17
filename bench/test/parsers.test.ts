import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeIsolationIssues, parseClaudeTranscript } from '../lib/claude.ts';
import { classifyCodexTool, codexToolSurface, extractCodexRequests, parseCodexTranscript } from '../lib/codex.ts';
import { costFromUsage, loadPricing } from '../lib/pricing.ts';
import { checkArm, checkSurface, isAcmArm, type ToolCalls } from '../lib/record.ts';
import { runInnerCalls } from '../lib/run-result.ts';

const F = path.join(import.meta.dirname, '..', 'parser-fixtures');
const read = (name: string): string => readFileSync(path.join(F, name), 'utf8');

describe('Claude transcript parser', () => {
  it('reads the metrics of a real native run (claude-A.jsonl, Claude Code 2.1.325)', () => {
    const p = parseClaudeTranscript(read('claude-A.jsonl'));
    expect(p.turns).toBe(2);
    expect(p.requests).toBe(2);
    expect(p.hostDurationMs).toBe(2414);
    // Cache writes split by TTL: Claude Code writes 1-hour entries.
    expect(p.usage).toEqual({ input: 4, output: 171, cacheCreation: 2187, cacheRead: 12187, reasoning: 0, cacheCreation5m: 0, cacheCreation1h: 2187 });
    expect(p.hostCostUsd).toBeCloseTo(0.0116847, 10);
    // The usage priced with pricing.json (TTL split) is the host-reported cost.
    expect(costFromUsage(loadPricing(), 'claude-sonnet-5-5', p.usage ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, reasoning: null })).toBeCloseTo(0.0116847, 10);
    expect(p.model).toBe('claude-sonnet-5-5');
    expect(p.finalAnswer).toMatch(/ANSWER: 7$/);
    expect(p.toolCalls).toEqual({ native: 1, run: 0, codeMode: 0, other: 0, byName: { Read: 1 } });
    expect(p.innerCalls).toBeNull();
    // Arm A sees exactly the native file/shell tools (`--tools Bash,Read,Write,Edit,Glob,Grep`).
    expect([...(p.availableTools ?? [])].sort()).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
    expect(p.availableTools).not.toContain('mcp__agent-code-mode__run');
    expect(p.evidence['result']).toEqual([6]);
    expect(checkArm('claude', 'A', p.toolCalls).reasons).toEqual([]);
    expect(checkSurface('claude', 'A', p.availableTools ?? [])).toEqual([]);
    expect(checkSurface('claude', 'B', p.availableTools ?? []).length).toBeGreaterThan(0);
    // A surface with any other built-in (Task, ToolSearch, web...) is not the arm A surface.
    expect(checkSurface('claude', 'A', [...(p.availableTools ?? []), 'Task']).join()).toMatch(/expected exactly/);
    expect(checkSurface('claude', 'B', ['mcp__agent-code-mode__run', 'ToolSearch']).join()).toMatch(/expected exactly/);
  });

  it('counts run calls and the inner call log (claude-B.jsonl, synthetic)', () => {
    const p = parseClaudeTranscript(read('claude-B.jsonl'));
    expect(p.toolCalls.run).toBe(1);
    expect(p.toolCalls.native).toBe(0);
    expect(p.innerCalls).toEqual({ total: 3, byTool: { read: 2, grep: 1 } });
    expect(checkArm('claude', 'B', p.toolCalls)).toEqual({ fallback: false, reasons: [] });
    expect(checkSurface('claude', 'B', p.availableTools ?? [])).toEqual([]);
  });

  it('reads a hybrid run: native calls and run calls in one transcript (claude-C.jsonl, synthetic)', () => {
    const p = parseClaudeTranscript(read('claude-C.jsonl'));
    expect(p.toolCalls).toEqual({ native: 1, run: 1, codeMode: 0, other: 0, byName: { Read: 1, 'mcp__agent-code-mode__run': 1 } });
    expect(p.innerCalls).toEqual({ total: 3, byTool: { grep: 1, read: 2 } });
    expect(p.requests).toBe(3);
    expect(checkArm('claude', 'C', p.toolCalls)).toEqual({ fallback: false, reasons: [] });
    expect(checkSurface('claude', 'C', p.availableTools ?? [])).toEqual([]);
    // The same transcript is neither arm A nor arm B.
    expect(checkSurface('claude', 'A', p.availableTools ?? []).join()).toMatch(/expected exactly/);
    expect(checkSurface('claude', 'B', p.availableTools ?? []).join()).toMatch(/expected exactly/);
    expect(checkArm('claude', 'A', p.toolCalls).reasons).toContain('arm made agent-code-mode run calls');
    expect(checkArm('claude', 'B', p.toolCalls).fallback).toBe(true);
  });

  it('the hybrid arm accepts native only, run only and any mix, and nothing outside its surface', () => {
    const calls = (native: number, run: number, extra: Partial<ToolCalls> = {}): ToolCalls => ({ native, run, codeMode: 0, other: 0, byName: {}, ...extra });
    for (const c of [calls(3, 2), calls(5, 0), calls(0, 4), calls(0, 0)]) expect(checkArm('claude', 'C', c)).toEqual({ fallback: false, reasons: [] });
    expect(checkArm('claude', 'C', calls(1, 1, { other: 2 })).reasons).toEqual(['hybrid agent-code-mode arm made 2 call(s) to tools outside its surface']);
    expect(checkArm('claude', 'C', calls(1, 1, { codeMode: 1 })).reasons).toEqual(['hybrid agent-code-mode arm used Codex code mode']);
    // Its surface is exactly the six native tools plus run.
    const surface = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'mcp__agent-code-mode__run'];
    expect(checkSurface('claude', 'C', surface)).toEqual([]);
    expect(checkSurface('claude', 'C', [...surface, 'Task']).join()).toMatch(/expected exactly/);
    expect(checkSurface('claude', 'C', surface.filter((t) => t !== 'Bash')).join()).toMatch(/expected exactly/);
    expect(checkSurface('claude', 'C', surface.slice(0, 6)).join()).toMatch(/expected exactly/);
    // Codex C is still the strict agent-code-mode arm.
    expect(checkArm('codex', 'C', calls(1, 2))).toEqual({ fallback: true, reasons: ['strict agent-code-mode arm made 1 native file/shell tool call(s)'] });
    expect(checkArm('codex', 'C', calls(0, 0)).reasons).toEqual(['agent-code-mode arm made no run call']);
    expect(isAcmArm('claude', 'C')).toBe(true);
    expect(isAcmArm('claude', 'B0')).toBe(true);
    expect(isAcmArm('claude', 'A')).toBe(false);
    expect(isAcmArm('codex', 'B')).toBe(false);
    expect(isAcmArm('codex', 'C0')).toBe(true);
  });

  it('counts a replayed tool result once (same tool_use_id)', () => {
    const raw = read('claude-B.jsonl');
    const replay = raw.split('\n').filter((l) => l.includes('tool_result'));
    expect(replay).toHaveLength(1);
    const p = parseClaudeTranscript(`${raw}\n${replay.join('\n')}\n${replay.join('\n')}`);
    expect(p.innerCalls).toEqual({ total: 3, byTool: { read: 2, grep: 1 } });
  });

  it('reads the compact run response: call counts and the denied calls', () => {
    const compact = { ok: true, result: 1, calls: { total: 5, byTool: { read: 3, bash: 2 }, denied: [{ id: 'c2', tool: 'bash', summary: 'bash rm x', reason: 'rule: no rm' }, '…[1 more]'] } };
    expect(runInnerCalls(JSON.stringify(compact))).toEqual({ total: 5, byTool: { read: 3, bash: 2 }, denials: ['bash bash rm x: rule: no rm'] });
    const full = { ok: true, calls: [{ id: 'c1', tool: 'read', summary: 'read a', decision: 'allowed' }, { id: 'c2', tool: 'bash', summary: 'bash rm x', decision: 'denied', reason: 'rule: no rm' }] };
    expect(runInnerCalls(JSON.stringify(full))).toEqual({ total: 2, byTool: { read: 1, bash: 1 }, denials: ['bash bash rm x: rule: no rm'] });
    expect(runInnerCalls('not json')).toBeNull();
    expect(runInnerCalls('{"ok":true}')).toBeNull();
  });

  it('collects denied calls from hook errors and the run call log', () => {
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e1', is_error: true, content: 'PreToolUse:Edit hook error: src/handlers/reports.js is protected by the repository policy; this change is denied.' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e2', name: 'Read', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e2', is_error: true, content: 'File does not exist.' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r1', name: 'mcp__agent-code-mode__run', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: [{ type: 'text', text: JSON.stringify({ ok: false, calls: [{ id: '1', tool: 'edit', summary: 'edit src/handlers/reports.js', decision: 'denied', reason: 'blocked by hook', durationMs: 1 }] }) }] }] } },
    ].map((l) => JSON.stringify(l));
    const result = read('claude-B.jsonl').split('\n').filter((l) => l.includes('"type": "result"') || l.includes('"type":"result"'));
    const p = parseClaudeTranscript([...lines, ...result].join('\n'));
    expect(p.denials).toEqual([
      'PreToolUse:Edit hook error: src/handlers/reports.js is protected by the repository policy; this change is denied.',
      'edit edit src/handlers/reports.js: blocked by hook',
    ]);
    expect(parseClaudeTranscript(read('claude-A.jsonl')).denials).toEqual([]);
  });

  it('reads the isolation proof from the init event', () => {
    const p = parseClaudeTranscript(read('claude-A.jsonl'));
    expect(p.hostContext).not.toBeNull();
    expect(claudeIsolationIssues(p.hostContext ?? { agents: [], plugins: [], memory: true })).toEqual([]);
    expect(claudeIsolationIssues({ agents: ['claude', 'explorador'], plugins: ['cc-plugin-telemetry@builtin', 'my-plugin@my-marketplace'], memory: true })).toEqual([
      'user agents loaded: explorador',
      'user plugins loaded: my-plugin@my-marketplace',
      'auto memory is on',
    ]);
  });

  it('rejects a transcript without a result event', () => {
    expect(() => parseClaudeTranscript(read('claude-A.jsonl').split('\n').slice(0, 3).join('\n'))).toThrow(/no result event/);
  });
});

describe('Codex transcript parser', () => {
  it('reads the metrics of a real native run (codex-A, Codex CLI 0.169.0)', () => {
    const p = parseCodexTranscript(read('codex-A.jsonl'), read('codex-A.requests.jsonl'));
    expect(p.turns).toBe(2);
    // turn.completed: input 21008, cached 10240 -> uncached 10768.
    expect(p.usage).toEqual({ input: 10768, output: 57, cacheCreation: 0, cacheRead: 10240, reasoning: 0 });
    expect(p.toolCalls).toEqual({ native: 1, run: 0, codeMode: 0, other: 0, byName: { exec_command: 1 } });
    expect(p.finalAnswer).toMatch(/ANSWER: 7$/);
    expect(checkArm('codex', 'A', p.toolCalls).reasons).toEqual([]);
    const cost = costFromUsage(loadPricing(), 'gpt-6-luna', p.usage ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, reasoning: null });
    expect(cost).toBeCloseTo((10768 * 0.1 + 10240 * 0.01 + 57 * 0.5) / 1e6, 12);
  });

  it('tells Codex code mode from direct tools (codex-B, real code_mode_only run)', () => {
    const p = parseCodexTranscript(read('codex-B.jsonl'), read('codex-B.requests.jsonl'));
    expect(p.turns).toBe(2);
    expect(p.toolCalls.codeMode).toBe(1);
    expect(p.toolCalls.native).toBe(0);
    expect(p.innerCalls).toEqual({ total: 1, byTool: { command_execution: 1 } });
    expect(checkArm('codex', 'B', p.toolCalls).reasons).toEqual([]);
    expect(checkArm('codex', 'A', p.toolCalls).reasons).toContain('native arm used Codex code mode');
  });

  it('counts MCP run calls and their call log (codex-C, synthetic)', () => {
    const p = parseCodexTranscript(read('codex-C.jsonl'), read('codex-C.requests.jsonl'));
    expect(p.turns).toBe(3);
    expect(p.usage).toEqual({ input: 19000, output: 140, cacheCreation: 0, cacheRead: 33000, reasoning: 40 });
    expect(p.toolCalls.run).toBe(1);
    expect(p.toolCalls.other).toBe(1);
    expect(p.innerCalls).toEqual({ total: 1, byTool: { read: 1 } });
    expect(checkArm('codex', 'C', p.toolCalls)).toEqual({ fallback: false, reasons: [] });
  });

  it('falls back to the --json items when there is no rollout, with unknown turns', () => {
    const p = parseCodexTranscript(read('codex-A.jsonl'), null);
    expect(p.turns).toBeNull();
    expect(p.toolCalls.native).toBe(1);
  });

  it('flags fallback and missing run calls', () => {
    const calls = { native: 2, run: 1, codeMode: 0, other: 0, byName: {} };
    expect(checkArm('codex', 'C', calls).fallback).toBe(true);
    expect(checkArm('claude', 'B', { ...calls, run: 0 }).reasons).toContain('agent-code-mode arm made no run call');
    expect(checkArm('claude', 'A', calls).reasons).toContain('arm made agent-code-mode run calls');
  });

  it('strict arms reject any native file/shell call, even next to run calls', () => {
    const withBash = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'native-escape' }] } });
    const p = parseClaudeTranscript(`${withBash}\n${read('claude-B.jsonl')}`);
    expect(p.toolCalls.native).toBe(1);
    expect(p.toolCalls.run).toBe(1);
    const check = checkArm('claude', 'B', p.toolCalls);
    expect(check.fallback).toBe(true);
    expect(check.reasons).toEqual(['strict agent-code-mode arm made 1 native file/shell tool call(s)']);
    expect(checkArm('codex', 'C', { native: 2, run: 1, codeMode: 0, other: 0, byName: {} }).reasons).toHaveLength(1);
  });

  it('counts native command items from --json even when the rollout misses them (Codex C)', () => {
    const json = [
      { type: 'item.completed', item: { id: 'x', type: 'command_execution', command: 'cat config/app.json' } },
      { type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call', server: 'agent-code-mode', tool: 'run' } },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 2 } },
    ].map((e) => JSON.stringify(e)).join('\n');
    const req = [
      { kind: 'request', usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 2 } },
      { kind: 'call', type: 'function_call', name: 'run', namespace: 'mcp__agent-code-mode' },
    ].map((e) => JSON.stringify(e)).join('\n');
    const p = parseCodexTranscript(json, req);
    expect(p.toolCalls.run).toBe(1);
    expect(p.toolCalls.native).toBe(1);
    expect(checkArm('codex', 'C', p.toolCalls).reasons).toHaveLength(1);
  });

  it('classifies only the agent-code-mode run tool as run', () => {
    expect(classifyCodexTool('mcp__agent-code-mode__run')).toBe('run');
    expect(classifyCodexTool('mcp__agent_code_mode__run')).toBe('run');
    expect(classifyCodexTool('run', 'mcp__agent-code-mode__')).toBe('run');
    expect(classifyCodexTool('mcp__unrelated_agent_code_mode__overrun')).toBe('other');
    expect(classifyCodexTool('mcp__agent-code-mode__rerun')).toBe('other');
  });

  it('keeps hook denials from the rollout and reports them', () => {
    const rollout = [
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Update File: src/handlers/reports.js' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c', output: 'Command blocked by PreToolUse hook: src/handlers/reports.js is protected by the repository policy; this change is denied.. Command: *** Begin Patch' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'd', output: 'Process exited with code 0\nOutput: ok' } }),
      JSON.stringify({ type: 'token_usage_record', payload: { usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } } }),
    ].join('\n');
    const requests = extractCodexRequests(rollout);
    expect(requests.trim().split('\n').map((l) => JSON.parse(l).kind)).toEqual(['call', 'denial', 'request']);
    const json = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } });
    const p = parseCodexTranscript(json, requests);
    expect(p.denials).toHaveLength(1);
    expect(p.denials?.[0]).toContain('src/handlers/reports.js is protected');
    expect(parseCodexTranscript(json, null).denials).toBeNull();
    expect(parseCodexTranscript(read('codex-A.jsonl'), read('codex-A.requests.jsonl')).denials).toEqual([]);
  });

  it('keeps only usage and call names from a rollout', () => {
    const rollout = [
      JSON.stringify({ type: 'session_meta', payload: { creator_user_id: 'user-123', base_instructions: 'secret prompt' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: 'c1' } }),
      JSON.stringify({ type: 'token_usage_record', payload: { usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } } }),
      'not json',
    ].join('\n');
    const out = extractCodexRequests(rollout);
    expect(out).not.toContain('user-123');
    expect(out).not.toContain('secret prompt');
    expect(out.trim().split('\n').map((l) => JSON.parse(l).kind)).toEqual(['call', 'request']);
  });

  it('each Codex arm config gives the tool surface it claims (codex-surfaces.json, from codex debug prompt-input)', () => {
    const surfaces = JSON.parse(read('codex-surfaces.json'));
    for (const arm of ['A', 'B', 'C'] as const) expect(checkSurface('codex', arm, surfaces[arm])).toEqual([]);
    expect(checkSurface('codex', 'C', surfaces.A).length).toBeGreaterThan(0);
    expect(checkSurface('codex', 'A', surfaces.B).length).toBeGreaterThan(0);
    expect(checkSurface('codex', 'B', surfaces.C).length).toBeGreaterThan(0);
    // Arm C sees run directly (not behind tool_search) and no account apps.
    expect(surfaces.C).toContain('mcp__agent_code_mode.run');
    expect(checkSurface('codex', 'C', surfaces.C.filter((t: string) => !t.includes('agent_code_mode')))).toContain('agent-code-mode arm does not see the run tool directly (deferred behind tool_search, or server not configured)');
    expect(checkSurface('codex', 'A', [...surfaces.A, 'mcp__codex_apps__mail._send']).join()).toMatch(/account apps/);
    // Same non-file tools in every arm: any extra one (view_image, clock, multi-agent...) fails the check.
    for (const [arm, extra] of [['A', 'functions.view_image'], ['B', 'clock.sleep'], ['C', 'collaboration.spawn_agent'], ['B', 'exec.view_image']] as const) {
      expect(checkSurface('codex', arm, [...surfaces[arm], extra]).join(), extra).toMatch(/non-file tools/);
    }
    // B reaches the file/shell tools only through exec.
    expect(surfaces.B).toEqual(expect.arrayContaining(['exec.exec_command', 'exec.apply_patch', 'functions.exec']));
  });

  it('lists the tools nested in code-mode exec', () => {
    const description = 'Run JavaScript\n```ts\ndeclare const tools: { exec_command(args: {\n cmd: string }): Promise<unknown>; };\n```\ndeclare const tools: { apply_patch(input: string): Promise<unknown>; };';
    const input = JSON.stringify([{ type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec', description }, { type: 'function', name: 'wait' }] }] }]);
    expect(codexToolSurface(input)).toEqual(['functions.exec', 'functions.wait', 'exec.exec_command', 'exec.apply_patch']);
  });

  it('reads the tool names out of prompt-input output', () => {
    const input = JSON.stringify([
      { type: 'message', role: 'user' },
      { type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'exec_command' }, { type: 'custom', name: 'apply_patch' }] }, { type: 'tool_search' }] },
    ]);
    expect(codexToolSurface(input)).toEqual(['functions.exec_command', 'functions.apply_patch', 'tool_search']);
  });
});

describe('model requests', () => {
  it('counts distinct Claude assistant message ids, not num_turns', () => {
    const usage = { input_tokens: 2, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 };
    const lines = [
      { type: 'assistant', message: { id: 'msg_1', usage, content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: {} }] } },
      { type: 'assistant', message: { id: 'msg_1', usage, content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: {} }] } },
      { type: 'assistant', message: { id: 'msg_1', usage, content: [{ type: 'tool_use', id: 't3', name: 'Edit', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'assistant', message: { id: 'msg_2', usage, content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 4, duration_ms: 10, total_cost_usd: 0.001, result: 'done', usage },
    ];
    const p = parseClaudeTranscript(lines.map((l) => JSON.stringify(l)).join('\n'));
    expect(p.turns).toBe(4);
    expect(p.requests).toBe(2);
  });
});
