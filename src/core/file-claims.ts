import { TransactionFinalizeError } from './errors.js';
import type { RollbackReport, Transaction } from './types.js';

/**
 * The unfinished transactional run of this process that journaled each file.
 * A second run must not write such a file: it would take the first run's
 * uncommitted content as its original and put it back when it rolls back
 * after the first did. Runs in other processes are not coordinated.
 */
const owners = new Map<string, Transaction>();

/** Claims `absPath` for `tx`; false when another unfinished transaction holds it. */
export function claimFile(tx: Transaction, absPath: string): boolean {
  const owner = owners.get(absPath);
  if (owner !== undefined && owner !== tx) return false;
  owners.set(absPath, tx);
  return true;
}

/**
 * Makes `tx` release its claims once it is rolled back or finalized; a
 * finalize that left it open keeps them. The same object is returned, because
 * the tool runtime journals only into transactions it created.
 */
export function releasingClaims<T extends Transaction>(tx: T): T {
  const rollback = tx.rollback.bind(tx);
  const dispose = tx.dispose.bind(tx);
  const release = (): void => {
    for (const [file, owner] of owners) if (owner === tx) owners.delete(file);
  };
  return Object.assign(tx, {
    rollback: (): Promise<RollbackReport> => rollback().finally(release),
    dispose: (): Promise<void> =>
      dispose().then(release, (err: unknown) => {
        if (!(err instanceof TransactionFinalizeError) || err.committed) release();
        throw err;
      }),
  });
}
