import type {
  BashContainment,
  Decision,
  HostAdapter,
  HostCall,
  HostKind,
  HostResult,
  McpPolicy,
  PolicyLoadError,
  PolicySnapshot,
  SessionContext,
} from '../core/types.js';

/** Verdict of one static rule; undefined means the rule does not apply. */
export type RuleVerdict = { readonly kind: 'deny' | 'ask' | 'allow'; readonly reason: string } | undefined;

/** A static rule as a predicate over the prepared call. Rules are checked deny → ask → allow, like the hosts. */
export type StaticRule = (prepared: HostCall, ctx: SessionContext) => RuleVerdict;

/** What the fake PreToolUse hook does. */
export type HookBehavior =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'ask'; readonly reason: string }
  | { readonly kind: 'updatedArgs'; readonly args: unknown; readonly bindsPreparedFile?: true }
  | { readonly kind: 'throw'; readonly message: string }
  | { readonly kind: 'hang' }
  | { readonly kind: 'malformed' };

export interface StaticHostAdapterOptions {
  readonly host?: HostKind;
  readonly recordCalls?: boolean;
  readonly rules?: readonly StaticRule[];
  /** Fixed behavior, or one chosen per call. Default allow. */
  readonly hook?: HookBehavior | ((prepared: HostCall) => HookBehavior);
  /** When set, `loadPolicy` returns this error. */
  readonly policyError?: string;
  readonly bashContainment?: BashContainment;
  readonly protectedPaths?: readonly string[];
  readonly mcp?: McpPolicy;
}

/**
 * Host adapter for tests: static rules as predicates and a scripted fake
 * hook. Records every call it sees.
 */
export class StaticHostAdapter implements HostAdapter<null> {
  readonly host: HostKind;
  readonly authorized: HostCall[] = [];
  readonly staticChecked: HostCall[] = [];
  readonly postToolUses: { prepared: HostCall; result: HostResult }[] = [];
  readonly #opts: StaticHostAdapterOptions;

  constructor(opts: StaticHostAdapterOptions = {}) {
    this.#opts = opts;
    this.host = opts.host ?? 'generic';
  }

  async loadPolicy(_ctx: SessionContext): Promise<PolicySnapshot<null> | PolicyLoadError> {
    if (this.#opts.policyError !== undefined) return { error: this.#opts.policyError };
    return {
      host: this.host,
      bashContainment: this.#opts.bashContainment ?? { mode: 'none' },
      protectedPaths: this.#opts.protectedPaths ?? [],
      ...(this.#opts.mcp === undefined ? {} : { mcp: this.#opts.mcp }),
      payload: null,
    };
  }

  checkStatic(prepared: HostCall, ctx: SessionContext): Decision {
    if (this.#opts.recordCalls !== false) this.staticChecked.push(prepared);
    const verdicts = (this.#opts.rules ?? []).map((rule) => rule(prepared, ctx));
    const deny = verdicts.find((v) => v?.kind === 'deny');
    if (deny) return { kind: 'deny', source: 'rule', reason: deny.reason };
    const ask = verdicts.find((v) => v?.kind === 'ask');
    if (ask) return { kind: 'ask', reason: ask.reason };
    return { kind: 'allow' };
  }

  authorize(prepared: HostCall, _ctx: SessionContext, _policy: PolicySnapshot<null>, signal: AbortSignal): Promise<Decision> {
    if (this.#opts.recordCalls !== false) this.authorized.push(prepared);
    const hook = this.#opts.hook;
    const behavior: HookBehavior = typeof hook === 'function' ? hook(prepared) : (hook ?? { kind: 'allow' });
    switch (behavior.kind) {
      case 'allow':
        return Promise.resolve({ kind: 'allow' });
      case 'deny':
        return Promise.resolve({ kind: 'deny', source: 'hook', reason: behavior.reason });
      case 'ask':
        return Promise.resolve({ kind: 'ask', reason: behavior.reason });
      case 'updatedArgs':
        return Promise.resolve(
          behavior.bindsPreparedFile ? { kind: 'allow', updatedArgs: behavior.args, bindsPreparedFile: true } : { kind: 'allow', updatedArgs: behavior.args },
        );
      case 'throw':
        throw new Error(behavior.message);
      case 'malformed':
        // Simulates a buggy adapter that resolves something that is not a Decision.
        return Promise.resolve(JSON.parse('{"kind":"maybe"}'));
      case 'hang':
        // Never settles on its own; ignores the signal on purpose.
        void signal;
        return new Promise<Decision>(() => undefined);
    }
  }

  async postToolUse(prepared: HostCall, result: HostResult): Promise<void> {
    if (this.#opts.recordCalls !== false) this.postToolUses.push({ prepared, result });
  }
}
