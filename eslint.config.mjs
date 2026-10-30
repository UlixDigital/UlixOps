import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const sshOnlyInRunner = "Only apps/runner may open SSH/SFTP connections (docs/ARCHITECTURE.md).";
const noLocalShell =
  "Remote commands run as argv over ssh2 from the allowlist in packages/shared/src/commands.ts, never through a local shell.";

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/next-env.d.ts",
      "apps/api/src/generated/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    languageOptions: { globals: globals.node },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "ssh2", message: sshOnlyInRunner },
            { name: "ssh2-sftp-client", message: sshOnlyInRunner },
            { name: "child_process", message: noLocalShell },
            { name: "node:child_process", message: noLocalShell },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/runner/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "child_process", message: noLocalShell },
            { name: "node:child_process", message: noLocalShell },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks },
    settings: { next: { rootDir: "apps/web" } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
