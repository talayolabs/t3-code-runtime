import { defineConfig } from 'vitest/config';
import { sharedResolve } from './vitest.shared.js';

export default defineConfig({
  resolve: sharedResolve,
  test: {
    name: 'integration',
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
