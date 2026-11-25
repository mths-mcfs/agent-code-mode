import { defineConfig } from 'vitest/config';

// The attack suite drives real file operations through run, which Windows refuses until #28.
const attack = process.platform === 'win32' ? [] : ['test/attack/**/*.test.ts'];

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', ...attack],
    testTimeout: 20_000,
  },
});
