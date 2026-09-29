import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.turbo/**',
      'packages/contracts/lib/**',
      'packages/contracts/out/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Tooling configs that have to stay CommonJS.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },
  {
    rules: {
      // solveRaffle checks its arity at runtime and then asserts; the
      // alternative is four near-identical overloads that say less.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Entry points whose whole job is to print a report to a terminal. `warn`
    // and `error` go to stderr, which is the wrong stream for output someone
    // asked for.
    files: [
      'apps/api/src/db/migrate.ts',
      'apps/api/src/server.ts',
      'apps/api/src/watcher.ts',
      'scripts/**/*.mjs',
    ],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
      },
    },
    rules: { 'no-console': 'off' },
  },
);
