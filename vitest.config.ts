import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { tornStub } from './worker/test/torn-stub.ts';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './worker/wrangler.jsonc' },
      miniflare: {
        bindings: { TOKEN_SECRET: 'test-secret', TORN_API_BASE: 'https://torn.test/v2', SUPERADMINS: '1' },
        outboundService: tornStub,
      },
    }),
  ],
  test: { include: ['worker/test/**/*.test.ts'] },
});
