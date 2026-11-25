import { TransactionFinalizeError } from './errors.js';
import type { RollbackReport, Transaction } from './types.js';

const unfinishedWriterOf = new Map<string, Transaction>();

export function claimFile(tx: Transaction, absPath: string): boolean {
  const owner = unfinishedWriterOf.get(absPath);
  if (owner !== undefined && owner !== tx) return false;
  unfinishedWriterOf.set(absPath, tx);
  return true;
}

export function releasingClaims<T extends Transaction>(tx: T): T {
  const rollback = tx.rollback.bind(tx);
  const dispose = tx.dispose.bind(tx);
  const release = (): void => {
    for (const [file, owner] of unfinishedWriterOf) if (owner === tx) unfinishedWriterOf.delete(file);
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
