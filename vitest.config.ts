import { configDefaults, defineConfig } from 'vitest/config';

/** Suites that drive rooted file operations, which refuse on Windows (`src/tools/rooted.ts`); `rooted.test.ts` checks that refusal there. */
const ROOTED_SUITES = [
  'src/tools/fs-ops.test.ts',
  'src/tools/hardening.test.ts',
  'src/tools/integration.test.ts',
  'src/tools/journal.test.ts',
  'src/tools/recovery-*.test.ts',
  'src/tools/runtime.test.ts',
  'src/tools/transaction-review.test.ts',
];

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(process.platform === 'win32' ? ROOTED_SUITES : [])],
    testTimeout: 20_000,
  },
});
