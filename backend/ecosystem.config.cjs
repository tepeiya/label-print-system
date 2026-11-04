/**
 * LabelFlow 后端进程守护配置（PM2）
 *
 * 用法：
 *   npm i -g pm2
 *   cp .env.example .env   # 按实际环境修改
 *   pm2 start ecosystem.config.cjs --only labelflow-api
 *   pm2 start ecosystem.config.cjs --only labelflow-worker
 *   pm2 save && pm2 startup    # 开机自启
 *
 * 也可以一次全起：pm2 start ecosystem.config.cjs
 *
 * 健康检查：pm2 monit / pm2 logs labelflow-api
 * 回滚：pm2 reload labelflow-api
 */
module.exports = {
  apps: [
    // ─── API 服务（NestJS，提供 REST + SSE） ────────────────────────────
    {
      name: 'labelflow-api',
      cwd: __dirname,
      script: 'dist/src/main.js',
      instances: 1,                // 单进程；CPU 密集型（sharp / zxing）占较多资源
      exec_mode: 'fork',
      watch: false,                // 生产关掉；开发可用 --watch
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      node_args: '-r reflect-metadata',
      env_file: '.env',            // 相对 cwd，指向 backend/.env
      env_production: {
        NODE_ENV: 'production',
      },
      error_file: '/tmp/labelflow-api.err.log',
      out_file: '/tmp/labelflow-api.out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },

    // ─── 打印队列 Worker（BullMQ，独立进程避免阻塞 API） ────────────────
    {
      name: 'labelflow-worker',
      cwd: __dirname,
      script: 'dist/worker.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      node_args: '-r reflect-metadata',
      env_file: '.env',
      error_file: '/tmp/labelflow-worker.err.log',
      out_file: '/tmp/labelflow-worker.out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};
