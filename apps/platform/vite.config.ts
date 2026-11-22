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
  server: {
    // 与 console（5173）错开，两个后台可以同时跑
    port: 5181,
    proxy: {
      '/api': {
        // 默认 3200；端口被占用时可用 VITE_API_TARGET 覆盖
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:3200',
        changeOrigin: true,
      },
    },
  },
});
