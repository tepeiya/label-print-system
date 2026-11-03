// SQL 数据源连接串加解密 —— AES-256-GCM
// 密钥来源：
//   SQL_SECRET_KEY 环境变量（base64 或 hex）
//   若未设置 → 用一个固定的 dev key（仅开发用，生产务必配 SQL_SECRET_KEY）
import * as crypto from 'crypto';

const DEV_KEY_HEX = '3a9f1b2c4d5e6f7890abcdef1234567890abcdef1234567890abcdef123456789';

/** 取 32 字节密钥：支持 hex / base64 / 原始 utf8 */
function resolveKey(): Buffer {
  const env = process.env.SQL_SECRET_KEY?.trim();
  if (env) {
    // hex（64 字符）/ base64 / 原始
    if (/^[0-9a-f]{64}$/i.test(env)) return Buffer.from(env, 'hex');
    if (/^[A-Za-z0-9+/=]{40,}$/.test(env)) {
      try {
        const b = Buffer.from(env, 'base64');
        if (b.length === 32) return b;
      } catch { /* fallthrough */ }
    }
    // utf8：截前 32 字节
    const buf = Buffer.alloc(32);
    Buffer.from(env, 'utf8').copy(buf);
    return buf;
  }
  console.warn('[WARN] SQL_SECRET_KEY 未设置，使用内置 dev key —— 生产环境请配置 SQL_SECRET_KEY');
  return Buffer.from(DEV_KEY_HEX, 'hex');
}

let _key: Buffer | null = null;
function key(): Buffer {
  if (!_key) _key = resolveKey();
  return _key;
}

/** 加密任意字符串，输出 base64（格式：base64(iv|tag|ciphertext)） */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** 解密 base64 格式 */
export function decrypt(b64: string): string {
  const raw = Buffer.from(b64, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return out.toString('utf8');
}

export function hasProdKey(): boolean {
  return !!process.env.SQL_SECRET_KEY?.trim();
}
