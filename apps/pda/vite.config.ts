import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  // zxing-wasm 的 .wasm 走自身 import.meta.url 加载，不能被预打包打散
  optimizeDeps: {
    exclude: ['zxing-wasm'],
  },
  server: {
    port: 5185,
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        // 默认 3201（本机 3200 常被其他服务占用，后端会自动顺延）
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:3201',
        changeOrigin: true,
      },
    },
  },
});
