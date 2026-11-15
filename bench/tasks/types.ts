import type { FixtureFacts, Tree } from '../fixture/generate.ts';

export type TaskId = 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8';
export const TASK_IDS: readonly TaskId[] = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'];

export interface VerifyContext {
  /** Absolute path of the final workspace. */
  readonly workspace: string;
  /** The agent's final answer text. */
  readonly answer: string;
  readonly facts: FixtureFacts;
  /** The tree as committed before the agent started (fixture plus task setup). */
  readonly initial: Tree;
}

export interface VerifyResult {
  readonly pass: boolean;
  /** One line per check, prefixed with `ok` or `FAIL`. */
  readonly details: readonly string[];
}

export type Verifier = (ctx: VerifyContext) => Promise<VerifyResult>;

/** Applies the reference solution to a workspace and returns the final answer it would give. */
export type Solution = (workspace: string, facts: FixtureFacts) => Promise<string>;

export interface TaskDef {
  readonly id: TaskId;
  readonly title: string;
  readonly size: 'short' | 'long-read' | 'long-edit' | 'debug' | 'policy';
  /** Prompt given to the agent. */
  prompt(facts: FixtureFacts): string;
  /** Changes the fixture tree before the initial commit (bug injection). */
  setup(tree: Tree, facts: FixtureFacts): Tree;
  /** True when the task installs the protect-file hook. */
  readonly protectedHook: boolean;
  readonly verify: Verifier;
  readonly solution: Solution;
}
