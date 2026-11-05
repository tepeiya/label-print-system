/**
 * 统一配置入口
 * —— 所有需要读环境变量的地方都从这里取，避免散落在各处导致漏改。
 */

/** JWT 密钥：用于 Access/Refresh 签名与验证，**必须在多实例部署时保持一致**。 */
export const JWT_SECRET: string = process.env.JWT_SECRET || 'dev-secret';

/** Access Token 有效期（Nest JwtModule 用字符串） */
export const JWT_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '15m';

/** Refresh Token 有效期 */
export const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

/** 默认监听端口 */
export const PORT = +(process.env.PORT || 3200);

/** SQL 加密密钥（AES-256-GCM，32 字节 hex；不配则用内置 dev key 并打 WARN） */
export const SQL_SECRET_KEY: string = process.env.SQL_SECRET_KEY || 'dev-sql-secret-key-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/**
 * Redis 连接参数 —— 兼容 REDIS_URL（如 redis://localhost:6380）与分项环境变量。
 * app.module 的 BullMQ 与 P5 的 Agent 限流都从这里取，避免两处各写一份口径不一致。
 */
export function redisConnection(): { host: string; port: number; password?: string; db?: number } {
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const u = new URL(url);
      return {
        host: u.hostname || '127.0.0.1',
        port: +(u.port || 6379),
        password: u.password ? decodeURIComponent(u.password) : undefined,
        db: u.pathname && u.pathname.length > 1 ? +u.pathname.slice(1) : 0,
      };
    } catch { /* 回退到分项配置 */ }
  }
  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: +(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  };
}
