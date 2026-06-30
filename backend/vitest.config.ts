import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  root: __dirname,
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [path.resolve(__dirname, './src/test/setup.ts')],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Isolamento via fork unico — evita race no DB de teste compartilhado.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'src/prisma/seed.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/test/**',
        'src/server.ts',
        'src/prisma/seed.ts',
        '**/*.d.ts',
      ],
    },
    env: {
      // Em CI (GitHub Actions) usa postgres:postgres@. Local usa o usuario do OS.
      DATABASE_URL:
        process.env.DATABASE_URL ??
        `postgresql://${process.env.USER ?? 'postgres'}@localhost:5432/gleps_crm_test`,
      NODE_ENV: 'test',
      JWT_SECRET: 'test-jwt-secret-minimo-32-chars-aaaaaaaa',
      REFRESH_TOKEN_SECRET: 'test-refresh-secret-minimo-32-chars-bbbbbb',
      FRONTEND_URL: 'http://localhost:8081',
      FRONTEND_ORIGIN: 'http://localhost:8081',
      EVOLUTION_API_URL: 'http://mock-evolution.test',
      EVOLUTION_API_KEY: 'test-evolution-key',
      RAPIDAPI_KEY: 'test-rapidapi-key',
      // T-026: chave hex de 64 chars (32 bytes) — apenas pra testes.
      ENCRYPTION_KEY:
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
