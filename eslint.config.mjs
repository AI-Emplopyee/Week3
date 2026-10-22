import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    // This repository keeps its Worker and development gate in build/.
    "!build/",
    "!build/**",
    "next-env.d.ts",
    "outputs/**",
    "dist/**",
    ".aicd-local/**",
    ".wrangler/**",
  ]),
]);

export default eslintConfig;
