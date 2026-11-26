import type { FixtureFacts, Tree } from '../fixture/generate.ts';

export type TaskId = 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8';
export const TASK_IDS: readonly TaskId[] = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'];

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
  readonly size: 'short' | 'long-read' | 'long-edit' | 'debug' | 'policy';
  prompt(facts: FixtureFacts): string;
  setup(tree: Tree, facts: FixtureFacts): Tree;
  readonly protectedHook: boolean;
  readonly verify: Verifier;
  readonly solution: Solution;
}
