import { defineConfig, globalIgnores } from "eslint/config";
import next from "eslint-config-next/core-web-vitals";
import ts from "eslint-config-next/typescript";
// Sibling Git worktrees are separate checkouts, not source of this project.
export default defineConfig([...next, ...ts, globalIgnores([".next/**", ".local/**", ".superpowers/**", ".worktrees/**", "artifacts/**", "next-env.d.ts"])]);
