import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'web/**', '**/.npm-cache/**', 'apps/android/**/build/**', 'apps/android/.gradle/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/**/*.ts', 'packages/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error'
    }
  }
);
