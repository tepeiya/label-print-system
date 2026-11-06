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
        target: 'http://127.0.0.1:3200',
        changeOrigin: true,
      },
    },
  },
});
