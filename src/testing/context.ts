import type { SessionContext } from '../core/types.js';

/** A `SessionContext` for tests rooted at `cwd`. */
export function makeContext(cwd = '/ws', overrides: Partial<SessionContext> = {}): SessionContext {
  return { host: 'generic', cwd, roots: [cwd], permissionMode: 'default', sources: { cwd: 'default' }, ...overrides };
}
