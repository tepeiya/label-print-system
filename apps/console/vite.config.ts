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
    port: 5173,
    // 预览/反向代理会带自己的 Host 头，Vite 默认只允许 localhost
    allowedHosts: true,
    proxy: {
      '/api': {
        // 默认 3200；端口被占用时可用 VITE_API_TARGET 覆盖
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:3200',
        changeOrigin: true,
      },
    },
  },
});
