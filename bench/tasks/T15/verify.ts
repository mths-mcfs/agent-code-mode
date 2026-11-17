import path from 'node:path';
import { checkScope, checkUnchanged, Checks, runHiddenTests, runNodeTests } from '../checks.ts';
import { filesFrom } from '../setup.ts';
import type { VerifyContext, VerifyResult } from '../types.ts';

export const T15_FILES = path.join(import.meta.dirname, 'files');
const HIDDEN = Object.fromEntries(filesFrom(path.join(import.meta.dirname, 'hidden')));

/** The one file the task deletes. */
export const T15_LEGACY = 'src/lib/legacy-http.js';
/**
 * Files that use the names `legacyFetch`/`legacyJson` for another reason and must stay byte for byte:
 * a vendored cache with a `legacyFetch` of its own, its two callers, a text check that spells the
 * calls as strings and a module that only mentions one in a comment.
 */
export const T15_TRAPS = ['src/vendor/cache/legacy.js', 'src/services/catalog/price-cache.js', 'src/services/users/session-cache.js', 'src/tools/lint-legacy.js', 'src/services/billing/tax-rules.js'];

/**
 * Hidden tests check what every migrated function sends and returns (a hand-written table) and that the
 * migration is real: the old module is gone, nothing imports it, each former caller calls `request`
 * itself and no wrapper brings the old helpers back. The traps are compared with the initial tree.
 */
export async function verify(ctx: VerifyContext): Promise<VerifyResult> {
  const checks = new Checks();
  const visible = await runNodeTests(ctx.workspace);
  checks.check(visible.ok && visible.fail === 0, `node --test passes (pass ${visible.pass}, fail ${visible.fail})`);
  const hidden = await runHiddenTests(ctx.workspace, HIDDEN);
  checks.check(hidden.ok && hidden.fail === 0 && hidden.pass > 0, `hidden tests pass (pass ${hidden.pass}, fail ${hidden.fail}${hidden.fail > 0 ? `: ${hidden.failed.join('; ')}` : ''})`);
  await checkUnchanged(checks, ctx.workspace, ctx.initial, T15_TRAPS, 'files that are not callers of legacy-http');
  await checkScope(checks, ctx.workspace, ctx.initial, (f) => f.startsWith('src/services/'), { allowedDeletions: [T15_LEGACY] });
  return checks.result();
}
