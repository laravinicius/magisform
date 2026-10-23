import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
  const migrations=await readD1Migrations('./cloudflare/migrations');
  return {
    test: {
      include: ['cloudflare/tests/**/*.test.ts'],
      testTimeout: 30_000,
      hookTimeout: 30_000,
      pool: '@cloudflare/vitest-pool-workers' as const,
      poolOptions: {
        workers: {
          main: './cloudflare/worker.ts',
          wrangler: { configPath: './wrangler.test.jsonc' },
          isolatedStorage: true,
          miniflare: { bindings: { TEST_MIGRATIONS: JSON.stringify(migrations) } },
        },
      },
    },
  };
});
