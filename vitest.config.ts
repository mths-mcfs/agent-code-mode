import { defineConfig } from 'vitest/config';

// The attack suite drives real file operations through run, which Windows refuses until #28.
const attack = process.platform === 'win32' ? [] : ['test/attack/**/*.test.ts'];

export default defineConfig({
  test: {
    testTimeout: 20_000,
    projects: [
      { extends: true, test: { name: 'src', include: ['src/**/*.test.ts', ...attack] } },
      // The bench tests spawn many `node --test` runs. They go after the others so that load never starves the
      // timed process helpers in src (the Windows Job Object helper has 60 s to answer).
      { extends: true, test: { name: 'bench', include: ['bench/**/*.test.ts'], exclude: ['bench/.work/**'], sequence: { groupOrder: 1 } } },
    ],
  },
});
