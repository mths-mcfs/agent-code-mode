import type { FixtureFacts, Tree } from '../fixture/generate.ts';

export type TaskId = 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8' | 'T9' | 'T10' | 'T11' | 'T12' | 'T13' | 'T14' | 'T15' | 'T16';
export const TASK_IDS: readonly TaskId[] = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12', 'T13', 'T14', 'T15', 'T16'];
/** The tasks a run without `--tasks` makes. T16 (upstream MCP tools) measures another surface and runs only when asked for. */
export const DEFAULT_TASK_IDS: readonly TaskId[] = TASK_IDS.filter((t) => t !== 'T16');

/** A stdio MCP server that holds a task's data. Every arm of both hosts gets it in the host's own MCP config. */
export interface TaskMcpServer {
  /** Its tools are `mcp__<name>__<tool>`. */
  readonly name: string;
  /** Absolute path of the server entry, run with this Node. */
  readonly entry: string;
  args(facts: FixtureFacts): string[];
  readonly tools: readonly string[];
  /**
   * Text that, in the input of a tool call, shows the agent going around the server: reading its source or
   * the bench's config files next to the workspace, calling the data generator, or reading the process table
   * (the server's command line names its seed). Such a run is invalid.
   */
  readonly offLimits: readonly string[];
}

export interface VerifyContext {
  readonly workspace: string;
  readonly answer: string;
  readonly facts: FixtureFacts;
  readonly initial: Tree;
  readonly denials?: readonly string[] | null;
}

export interface VerifyResult {
  readonly pass: boolean;
  readonly details: readonly string[];
}

export type Verifier = (ctx: VerifyContext) => Promise<VerifyResult>;

export type Solution = (workspace: string, facts: FixtureFacts) => Promise<string>;

export interface TaskDef {
  readonly id: TaskId;
  readonly title: string;
  readonly size: 'short' | 'long-read' | 'long-edit' | 'debug' | 'policy' | 'refactor' | 'feature' | 'mcp';
  readonly mcpServer?: TaskMcpServer;
  readonly hiddenTests?: boolean;
  prompt(facts: FixtureFacts): string;
  setup(tree: Tree, facts: FixtureFacts): Tree;
  readonly protectedHook: boolean;
  readonly verify: Verifier;
  readonly solution: Solution;
}
