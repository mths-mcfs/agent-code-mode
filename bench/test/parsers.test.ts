import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeTranscript } from '../lib/claude.ts';
import { codexToolSurface, extractCodexRequests, parseCodexTranscript } from '../lib/codex.ts';
import { costFromUsage, loadPricing } from '../lib/pricing.ts';
import { checkArm, checkSurface } from '../lib/record.ts';

const F = path.join(import.meta.dirname, '..', 'parser-fixtures');
const read = (name: string): string => readFileSync(path.join(F, name), 'utf8');

describe('Claude transcript parser', () => {
  it('reads the metrics of a real native run (claude-A.jsonl, Claude Code 2.1.325)', () => {
    const p = parseClaudeTranscript(read('claude-A.jsonl'));
    expect(p.turns).toBe(2);
    expect(p.hostDurationMs).toBe(3833);
    expect(p.usage).toEqual({ input: 4, output: 180, cacheCreation: 17117, cacheRead: 42661, reasoning: 0 });
    expect(p.hostCostUsd).toBeCloseTo(0.00394041, 10);
    expect(p.model).toBe('claude-haiku-5-5');
    expect(p.finalAnswer).toMatch(/ANSWER: 7$/);
    expect(p.toolCalls).toEqual({ native: 1, run: 0, codeMode: 0, other: 0, byName: { Read: 1 } });
    expect(p.innerCalls).toBeNull();
    expect(p.availableTools).toContain('Bash');
    expect(p.availableTools).not.toContain('mcp__agent-code-mode__run');
    expect(p.evidence['result']).toEqual([6]);
    expect(checkArm('claude', 'A', p.toolCalls).reasons).toEqual([]);
    expect(checkSurface('claude', 'A', p.availableTools ?? [])).toEqual([]);
    expect(checkSurface('claude', 'B', p.availableTools ?? []).length).toBeGreaterThan(0);
  });

  it('counts run calls and the inner call log (claude-B.jsonl, synthetic)', () => {
    const p = parseClaudeTranscript(read('claude-B.jsonl'));
    expect(p.toolCalls.run).toBe(1);
    expect(p.toolCalls.native).toBe(0);
    expect(p.innerCalls).toEqual({ total: 3, byTool: { read: 2, grep: 1 } });
    expect(checkArm('claude', 'B', p.toolCalls)).toEqual({ fallback: false, reasons: [] });
    expect(checkSurface('claude', 'B', p.availableTools ?? [])).toEqual([]);
  });

  it('rejects a transcript without a result event', () => {
    expect(() => parseClaudeTranscript(read('claude-A.jsonl').split('\n').slice(0, 3).join('\n'))).toThrow(/no result event/);
  });
});

describe('Codex transcript parser', () => {
  it('reads the metrics of a real native run (codex-A, Codex CLI 0.169.0)', () => {
    const p = parseCodexTranscript(read('codex-A.jsonl'), read('codex-A.requests.jsonl'));
    expect(p.turns).toBe(2);
    // turn.completed: input 33269, cached 16384 -> uncached 16885.
    expect(p.usage).toEqual({ input: 16885, output: 53, cacheCreation: 0, cacheRead: 16384, reasoning: 0 });
    expect(p.toolCalls).toEqual({ native: 1, run: 0, codeMode: 0, other: 0, byName: { exec_command: 1 } });
    expect(p.finalAnswer).toMatch(/ANSWER: 7$/);
    expect(checkArm('codex', 'A', p.toolCalls).reasons).toEqual([]);
    const cost = costFromUsage(loadPricing(), 'gpt-6-luna', p.usage ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, reasoning: null });
    expect(cost).toBeCloseTo((16885 * 0.1 + 16384 * 0.01 + 53 * 0.5) / 1e6, 12);
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
    expect(checkArm('codex', 'C', calls)).toEqual({ fallback: true, reasons: [] });
    expect(checkArm('claude', 'B', { ...calls, run: 0 }).reasons).toContain('agent-code-mode arm made no run call');
    expect(checkArm('claude', 'A', calls).reasons).toContain('arm made agent-code-mode run calls');
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
  });

  it('reads the tool names out of prompt-input output', () => {
    const input = JSON.stringify([
      { type: 'message', role: 'user' },
      { type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'exec_command' }, { type: 'custom', name: 'apply_patch' }] }, { type: 'tool_search' }] },
    ]);
    expect(codexToolSurface(input)).toEqual(['functions.exec_command', 'functions.apply_patch', 'tool_search']);
  });
});
