import { defineConfig } from 'vitest/config';
import { sharedResolve } from './vitest.shared.js';

export default defineConfig({
  resolve: sharedResolve,
  test: {
    name: 'unit',
    include: ['packages/*/src/**/*.test.ts', 'test/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
