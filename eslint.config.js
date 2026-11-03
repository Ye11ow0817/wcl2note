import js from "@eslint/js";
import ts from "typescript-eslint";
import { builtinModules } from "node:module";

const nodeImports = [
  ...new Set(builtinModules.flatMap((name) => [name, `node:${name}`])),
];
const restrictedImports = (layers, paths = []) => [
  "error",
  {
    paths,
    patterns: [
      {
        regex: `(?:^|/)(?:${layers.join("|")})(?:/|$)`,
        message:
          "请遵守进程与领域边界；跨进程功能通过 shared 协议和 preload 桥接。",
      },
    ],
  },
];

export default ts.config(
  {
    ignores: [
      "dist/**",
      "dist-electron/**",
      "release/**",
      ".cache/**",
      ".tmp/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs}"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        Request: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
        Buffer: "readonly",
      },
    },
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictedImports(
        ["main", "preload"],
        ["electron", ...nodeImports],
      ),
    },
  },
  {
    files: ["src/main/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictedImports(["renderer", "preload"]),
    },
  },
  {
    files: ["src/preload/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictedImports([
        "main",
        "renderer",
        "domain",
      ]),
    },
  },
  {
    files: ["src/domain/**/*.ts", "src/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictedImports(
        ["main", "preload", "renderer"],
        ["electron", "react", "react-dom", ...nodeImports],
      ),
    },
  },
);
