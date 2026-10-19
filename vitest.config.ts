import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/contracts/**/*.test.ts',
      'tests/security/**/*.test.ts',
    ],
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 10_000,
  },
});
