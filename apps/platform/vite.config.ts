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
        target: 'http://127.0.0.1:3200',
        changeOrigin: true,
      },
    },
  },
});
