/**
 * ESLint 基线（apps/console / Vue 3 + TS + vite，ESM）
 *
 * 定位同 backend：能重复跑的基线，不是严格规范。
 * 注：ESLint 10 移除了 eslintrc 时代的 `eslint.configs`，flat 下等价集来自 `@eslint/js`；
 * vue 侧取 plugin-vue 最轻的一档 `flat/essential`。
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'public/**', // 静态资源，无 JS/TS
      '**/*.sql',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    // .vue 的 <script lang="ts"> 需要交给 TS parser 解析，vue-eslint-parser 只做 SFC 拆解。
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    },
  },
  {
    files: ['**/*.ts', '**/*.vue'],
    rules: {
      // 存量代码 any 较多，类型治理是后续独立任务。
      '@typescript-eslint/no-explicit-any': 'off',

      // no-unused-vars：typescript-eslint 版本，允许 `_` 前缀占位。
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none', // 同 backend：catch(err) 不消费不算死代码风险
        },
      ],

      // tseslint 的 eslintRecommended 只对 **/*.ts 关掉 no-undef，.vue 不在其列。
      // SFC 里 window/document/模板 ref 等一律交给 tsc + vue 工具链判 undef，否则基线全是误报。
      'no-undef': 'off',

      // 组件名多为 Login.vue / Dashboard.vue 等单词名，基线不强制多词。
      'vue/multi-word-component-names': 'off',

      // 7 处 `try { ... } catch {} finally { loading = false }` 是有意的静默失败
      // （错误提示由 axios 拦截器统一弹），删掉会改行为，故只放行空 catch。
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
