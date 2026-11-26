import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, vi } from 'vitest';
import { DEFAULT_FIXTURE_SEED } from '../fixture/generate.ts';
import { createWorkspace } from '../lib/workspace.ts';
import { TASKS } from '../tasks/index.ts';
import { TASK_IDS } from '../tasks/types.ts';

/**
 * Sets up the verifier tests of one file: the case timeout, a temporary root of the file's own and its cleanup.
 * Call it once at the top level of each verifier test file, before its describes.
 */
export async function verifierWorkspaces() {
  // Every case builds git workspaces and runs node --test on them: past the 20 s default on the slower Windows runner.
  vi.setConfig({ testTimeout: 120_000 });
  const root = await mkdtemp(path.join(os.tmpdir(), 'acm-verify-'));
  // Each workspace is a git repo of 340-560 entries (T12 adds 80 log files). Deleting them takes longer than the
  // 10 s hook default on Windows, where every delete is scanned and a file still held open fails with EBUSY for a
  // moment, so the cleanup gets its own timeout and retries.
  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, 180_000);

  let n = 0;
  async function workspace(task: (typeof TASK_IDS)[number], host: 'claude' | 'codex' = 'codex') {
    n += 1;
    return createWorkspace(path.join(root, `${task}-${n}`), TASKS[task], host, DEFAULT_FIXTURE_SEED);
  }

  return { workspace };
}
