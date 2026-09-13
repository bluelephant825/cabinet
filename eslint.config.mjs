import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import reactHooks from "eslint-plugin-react-hooks";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/static-components": "warn",
    },
  },
  // Vendored GenOffice document engines are worker-only: nothing outside
  // server/documents/worker*.ts (and tests) may import them.
  {
    files: ["src/**/*.ts", "src/**/*.tsx", "server/**/*.ts"],
    ignores: ["src/vendor/**", "server/documents/worker.ts", "server/documents/worker-ops.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/vendor/genoffice/**", "*/vendor/genoffice/*", "**/src/vendor/genoffice/**"],
              message:
                "GenOffice engines run only in server/documents/worker*.ts — call the document service instead.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
    // User data / archives / generated outputs are not app source code.
    ".audit-shots/**",
    "data/**",
    "data-old*/**",
    "old-data/**",
    "cabinetai/dist/**",
  ]),
]);

export default eslintConfig;
