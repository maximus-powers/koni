import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const ignoredPaths = [
  "**/dist/**",
  "**/coverage/**",
  "**/node_modules/**",
  "**/.koni/**",
  "private/**",
  "packages/*-profile/koni/baseline/**",
  "packages/core/test/fixtures/profile-prior-releases/**",
  "packages/**/vitest.config.ts",
];

export default tseslint.config(
  {
    ignores: ignoredPaths,
  },
  {
    ...eslint.configs.recommended,
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      globals: globals.node,
      sourceType: "module",
    },
    rules: {
      ...eslint.configs.recommended.rules,
      "no-control-regex": "off",
      "no-useless-assignment": "off",
      "no-useless-escape": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["packages/**/*.ts"],
    languageOptions: {
      globals: globals.node,
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      ...eslint.configs.recommended.rules,
      "no-control-regex": "off",
      "no-undef": "off",
      "no-useless-assignment": "off",
      "no-useless-escape": "off",
      "no-unused-vars": "off",
      "preserve-caught-error": "off",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          fixStyle: "inline-type-imports",
          prefer: "type-imports",
          disallowTypeAnnotations: false,
        },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["packages/**/test/**/*.ts"],
    rules: {
      "no-sparse-arrays": "off",
    },
  },
);
