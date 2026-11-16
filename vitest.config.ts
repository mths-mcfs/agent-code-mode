import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'bench/**/*.test.ts', 'test/attack/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'bench/.work/**'],
    testTimeout: 20_000,
  },
});
