import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globalSetup: ['./test/setup.ts'],
    fileParallelism: false,
    // Real PostgreSQL migrations and Argon2 work can exceed the default 5s on a busy dev machine.
    testTimeout: 15_000,
    hookTimeout: 30_000,
    environment: 'node',
  },
});
