/**
 * ESLint 基线（apps/platform / Vue 3 + TS + vite，ESM）
 * 与 apps/console/eslint.config.js 同一套规则：平台后台代码量小，不单独收紧口径。
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
      '@typescript-eslint/no-explicit-any': 'off',

      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none', // catch(err) 不消费不算死代码风险
        },
      ],

      // SFC 里 window/document 等一律交给 tsc 判 undef，否则基线全是误报。
      'no-undef': 'off',

      // 组件名多为 Login.vue / Plans.vue 等单词名，基线不强制多词。
      'vue/multi-word-component-names': 'off',

      // 接口错误提示由 axios 拦截器统一弹，view 里 `try { ... } catch {}` 是有意静默。
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
