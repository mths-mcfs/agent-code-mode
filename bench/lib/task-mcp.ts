import { z } from 'zod';
import type { FixtureFacts } from '../fixture/generate.ts';
import type { TaskDef } from '../tasks/types.ts';
import type { StdioServer } from './claude.ts';
import { taskToolName } from './record.ts';
import type { HostId } from './workspace.ts';

export function taskServer(task: Pick<TaskDef, 'mcpServer'>, facts: FixtureFacts, nodePath: string = process.execPath): StdioServer | undefined {
  const m = task.mcpServer;
  return m === undefined ? undefined : { name: m.name, command: nodePath, args: [m.entry, ...m.args(facts)] };
}

/** Helpers a Claude Code Mode script uses to find deferred tools: on an MCP task they lead to its tools. */
export const REPL_DISCOVERY_TOOLS = ['searchTools', 'describeTool'];

export function taskScriptTool(task: Pick<TaskDef, 'mcpServer'>, tool: string): boolean {
  const m = task.mcpServer;
  return m !== undefined && (REPL_DISCOVERY_TOOLS.includes(tool) || taskToolName(tool, m.name) !== null);
}

const ClaudeMessage = z.object({ message: z.object({ content: z.array(z.unknown()) }).passthrough() }).passthrough();
const ClaudeToolUse = z.object({ type: z.literal('tool_use'), input: z.unknown() }).passthrough();
const CodexCall = z.object({ kind: z.literal('call'), args: z.string() }).passthrough();
const CodexCommand = z.object({ type: z.literal('item.completed'), item: z.object({ type: z.literal('command_execution'), command: z.string() }).passthrough() }).passthrough();

function jsonLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
    }
  }
  return out;
}

/**
 * The inputs of every tool call of a run, one per line: Claude `tool_use` inputs (a `run` or REPL call's input is
 * its script), Codex call arguments from the rollout and the commands of the `--json` stream.
 */
export function toolInputsText(host: HostId, stdout: string, requests: string | null): string {
  const out: string[] = [];
  if (host === 'claude') {
    for (const event of jsonLines(stdout)) {
      const msg = ClaudeMessage.safeParse(event);
      if (!msg.success) continue;
      for (const block of msg.data.message.content) {
        const use = ClaudeToolUse.safeParse(block);
        if (use.success) out.push(JSON.stringify(use.data.input ?? null));
      }
    }
    return out.join('\n');
  }
  for (const line of jsonLines(requests ?? '')) {
    const call = CodexCall.safeParse(line);
    if (call.success) out.push(call.data.args);
  }
  for (const event of jsonLines(stdout)) {
    const cmd = CodexCommand.safeParse(event);
    if (cmd.success) out.push(cmd.data.item.command);
  }
  return out.join('\n');
}

export function offLimitsHits(task: Pick<TaskDef, 'mcpServer'>, inputs: string): string[] {
  return (task.mcpServer?.offLimits ?? []).filter((m) => inputs.includes(m));
}
