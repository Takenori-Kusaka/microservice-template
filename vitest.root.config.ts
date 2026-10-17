// Root-level vitest projects for cross-cutting test suites under tests/.
// Package-local unit tests are run through turbo (`pnpm test`).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'contract',
          include: ['tests/contract/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'tenant-isolation',
          include: ['tests/tenant-isolation/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'resiliency',
          include: ['tests/resiliency/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
        },
      },
    ],
  },
});
