import { globalIgnores } from 'eslint/config'
import prettier from 'eslint-config-prettier/flat'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.ts'],
  })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-deprecated': 'error',
    },
  },
  globalIgnores(['.notes/**', 'coverage/**', 'dist/**']),
  prettier,
)
