import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      eqeqeq: 'warn',
      curly: ['warn', 'all'],
      'dot-notation': 'off',
      'prefer-arrow-callback': 'warn',
      'no-console': 'warn', // use the provided Homebridge log method instead
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
