/**
 * ESLint 基线（backend / NestJS 10 + TS, CommonJS）
 *
 * 定位：这是"能重复跑起来"的基线，不是严格规范。存量代码里 any 和
 * `require()` 混用很多，本轮只做结构性和明显死代码的检查。
 *
 * 注：ESLint 10 移除了 eslintrc 时代的 `eslint.configs` 全局对象，
 * flat config 下等价的 JS recommended 集来自 `@eslint/js`。
 */
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'scripts/**', // 一次性运维/数据脚本，不属于服务运行时，暂不纳入基线
      '**/*.sql', // 非 JS/TS 文件
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts', '**/*.cts'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'commonjs',
    },
    rules: {
      // ---- 刻意关闭：存量治理项，本轮不做 ----
      // 存量代码到处是 any。
      '@typescript-eslint/no-explicit-any': 'off',
      // 本轮用的是非 type-checked 的 recommended，`no-unsafe-*` 里只有这两条会被打开，
      // 一并显式钉死为 off，避免后续误开类型检查规则时基线炸量。
      '@typescript-eslint/no-unsafe-declaration-merging': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      // 其余 no-unsafe-argument / assignment / call / member-access / return 等
      // 只存在于 recommendedTypeChecked，本基线未启用。

      // backend 是 CommonJS（tsconfig module=commonjs），测试与运行期代码里
      // `require()` 是既有用法，不该报错。
      '@typescript-eslint/no-require-imports': 'off',

      // ---- no-unused-vars：用 typescript-eslint 版本，允许 `_` 前缀占位 ----
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // catch (err) 里不消费 err 在本仓库很常见（吞异常兜底渲染），
          // 不算死代码风险，基线不报。
          caughtErrors: 'none',
        },
      ],

      // ---- 降级为 warning：有道理但属于风格/健壮性清洗，不改源码 ----
      'prefer-const': 'warn', // 5 处 let→const，纯风格
      'no-useless-assignment': 'warn', // 2 处 try/catch 双赋值的初始值，改动要动结构
      'no-useless-escape': 'warn', // 2 处正则里多余的 \" 转义
      'preserve-caught-error': 'warn', // ESLint 10 新规则，throw 带 cause 属于错误处理专项
    },
  },
);
