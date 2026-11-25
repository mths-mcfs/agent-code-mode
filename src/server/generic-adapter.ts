import path from 'node:path';
import type { Decision, HostAdapter, PolicySnapshot, PreparedCall, SessionContext } from '../core/types.js';

/** Why the generic policy refuses mutations; shown in the call log and to the script. */
export const GENERIC_ASK_REASON =
  'no Claude Code or Codex host was detected (start the server with --host claude or --host codex), so its permission rules and hooks cannot be applied: only read, grep and glob inside the workspace are allowed';

/**
 * The policy for a client that is neither Claude Code nor Codex. The server
 * cannot see that client's rules or hooks, so it allows only what cannot
 * change anything: `read`, `grep` and `glob` inside the workspace roots (the
 * tool runtime's jail enforces the roots). `bash`, `write` and `edit` ask,
 * which the dispatcher turns into a deny.
 */
export class GenericHostAdapter implements HostAdapter<null> {
  readonly host = 'generic' as const;
  readonly #stateDir: string;

  constructor(opts: { readonly stateDir: string }) {
    this.#stateDir = opts.stateDir;
  }

  async loadPolicy(ctx: SessionContext): Promise<PolicySnapshot<null>> {
    return {
      host: 'generic',
      bashContainment: { mode: 'none' },
      protectedPaths: [path.join(this.#stateDir, '**'), ...[ctx.cwd, ...ctx.roots].map((root) => path.join(root, '.mcp.json'))],
      payload: null,
    };
  }

  checkStatic(prepared: PreparedCall): Decision {
    switch (prepared.tool) {
      case 'read':
      case 'grep':
      case 'glob':
        return { kind: 'allow' };
      case 'bash':
      case 'write':
      case 'edit':
        return { kind: 'ask', reason: GENERIC_ASK_REASON };
    }
  }

  async authorize(): Promise<Decision> {
    return { kind: 'allow' };
  }
}
