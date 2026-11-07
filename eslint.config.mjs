// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ESLint 配置。
 *
 * 目标不是风格统一，而是**抓真实缺陷**：漏掉的 await、悬空 Promise、
 * 误用宽松相等。这些在异步代码里最常变成线上事故，而类型检查发现不了。
 *
 * 刻意不开的规则：
 * - `no-unused-vars`：TypeScript 的 noUnusedLocals 已经覆盖，重复报错只增加噪音；
 * - 格式化类规则：交给编辑器/Prettier，不放进 CI 阻断。
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "openapi/**",
      "docs/**",
      // 这些文件不在任何 tsconfig 项目内，类型感知规则会直接报解析错误。
      "**/*.mjs",
      "**/vitest.config.ts",
      "**/scripts/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        // 类型感知规则需要它；no-floating-promises 之类的价值远超这点构建时间。
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "eqeqeq": ["error", "smart"],
      "@typescript-eslint/no-floating-promises": "error",
      // React 事件处理器传 async 函数是惯用写法，把 void 返回值检查关掉；
      // 仍保留对"Promise 用在条件判断里"这类真实误用的检查。
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // 测试文件允许更宽松的写法（断言、mock 常有悬空 Promise）。
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
