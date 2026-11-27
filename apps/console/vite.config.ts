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
  build: {
    chunkSizeWarningLimit: 1200,
    // 三方库单独成块：业务代码小包先到，UI 库/图标由浏览器并行缓存下载，
    // 升级业务代码时不必让用户重新下载 1MB 的 Element Plus。
    rollupOptions: {
      output: {
        // rolldown 只接受函数式 manualChunks
        manualChunks(id: string): string | undefined {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('icons-vue')) return 'vendor-icons';
          if (id.includes('echarts') || id.includes('zrender')) return 'vendor-charts';
          if (id.includes('element-plus')) return 'vendor-element';
          if (id.includes('vue-router') || id.includes('pinia')) return 'vendor-vue';
          if (id.includes('/vue/') || id.includes('@vue/')) return 'vendor-vue';
          // 其余三方依赖跟随各自路由懒加载，不要提升到首屏
          return undefined;
        },
      },
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
