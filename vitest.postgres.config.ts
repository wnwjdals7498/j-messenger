import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'apps/server/integration/postgres.integration.ts',
      'apps/server/test/bootstrap/application.integration.test.ts',
    ],
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
