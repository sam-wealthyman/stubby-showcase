import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // The nonce store is tested against a real Postgres, and the first
    // connection to one — container start, TLS handshake — is slower than the
    // 5s default.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    /*
     * One file at a time, because these share a connection budget.
     *
     * Each file opens its own pool. Run in parallel against Supabase's session
     * pooler they exceeded its 15 clients with "(EMAXCONNSESSION) max clients
     * reached in session mode", which CI never saw because a local Postgres
     * allows 100. That particular ceiling is gone with Supabase (ADR 0009) and
     * this stays anyway: the budget is still finite and still shared, and a
     * suite that fails depending on who else is connected is worse than a
     * slower one. The whole run is under ten seconds.
     */
    fileParallelism: false,
    coverage: { provider: 'v8', include: ['src/**'] },
  },
});
