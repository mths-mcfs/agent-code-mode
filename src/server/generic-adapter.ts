import path from 'node:path';
import type { Decision, HostAdapter, HostCall, PolicySnapshot, SessionContext } from '../core/types.js';

export const GENERIC_DENY_REASON =
  'no Claude Code or Codex host was detected (start the server with --host claude or --host codex), so its permission rules and hooks cannot be applied: only read, grep and glob inside the workspace are allowed';

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

  checkStatic(prepared: HostCall): Decision {
    switch (prepared.tool) {
      case 'mcp':
        return { kind: 'deny', source: 'unsupported-config', reason: 'upstream MCP calls need the Claude Code or Codex host, whose MCP configuration and rules they follow' };
      case 'read':
      case 'grep':
      case 'glob':
        return { kind: 'allow' };
      case 'bash':
      case 'write':
      case 'edit':
        return { kind: 'deny', source: 'rule', reason: GENERIC_DENY_REASON };
    }
  }

  async authorize(): Promise<Decision> {
    return { kind: 'allow' };
  }
}
