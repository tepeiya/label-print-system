// =============================================================================
// agent-release.calc.ts —— 「租户自助下载打印代理」的纯计算部分
//
// 后端只做两件事：读 backend/assets/print-agent/release.json（由
// scripts/print-agent-release.sh 生成），把 zip 流出去。这里把「清单可信度」
// 的判断抽成纯函数，便于单测：清单缺失 / 损坏 / 字段非法 / 文件不在，都要
// 优雅降级成 available:false，而不是给前端一个坏链接。
//
// 安全要点：fileName 来自磁盘清单，但仍然必须白名单校验（只能 [A-Za-z0-9._-]
// 且 .zip 结尾），否则一个被改坏的清单就能让 Content-Disposition 变成路径穿越。
// =============================================================================

export interface PrintAgentRelease {
  available: boolean;
  version: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  builtAt: string;
  /** 不可用时的原因（给接口提示用，不包含内部路径） */
  reason?: string;
}

const EMPTY: PrintAgentRelease = {
  available: false, version: '', fileName: '', sizeBytes: 0, sha256: '', builtAt: '',
};

const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.zip$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** 版本号：只允许数字点段，可选后缀（1.0 / 1.2.3 / 1.0-beta） */
export function isValidVersion(v: unknown): boolean {
  return typeof v === 'string' && /^[0-9]+(\.[0-9]+){1,3}([-.][A-Za-z0-9]{1,16})?$/.test(v);
}

/** 清单里的文件名是否可安全回填到 Content-Disposition */
export function isSafeArchiveName(name: unknown): boolean {
  return typeof name === 'string' && FILE_NAME_RE.test(name) && !name.includes('..');
}

/**
 * 解析发行清单。
 *
 * @param jsonText  release.json 内容（读不到传 null）
 * @param zipSize   磁盘上 zip 的实际字节数（文件不存在传 null）
 */
export function parseReleaseManifest(jsonText: string | null, zipSize: number | null): PrintAgentRelease {
  if (!jsonText) return { ...EMPTY, reason: '发行包清单未就位：管理员需运行 scripts/print-agent-release.sh' };
  if (zipSize === null) return { ...EMPTY, reason: '发行包文件不存在：清单有记录但 zip 已丢失' };

  let raw: any;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return { ...EMPTY, reason: '发行包清单损坏（JSON 解析失败）' };
  }
  if (!raw || typeof raw !== 'object') return { ...EMPTY, reason: '发行包清单格式异常' };

  if (!isValidVersion(raw.version)) return { ...EMPTY, reason: '发行包版本号非法' };
  if (!isSafeArchiveName(raw.fileName)) return { ...EMPTY, reason: '发行包文件名非法（只允许 .zip 且不含路径）' };
  if (typeof raw.sha256 !== 'string' || !SHA256_RE.test(raw.sha256)) {
    return { ...EMPTY, reason: '发行包 sha256 缺失或格式非法' };
  }

  // 大小以磁盘实际文件为准：清单可能比文件旧（重新打包忘了更新清单）
  const declared = Number(raw.sizeBytes);
  const sizeBytes = zipSize > 0 ? zipSize : Number.isFinite(declared) ? declared : 0;

  return {
    available: true,
    version: raw.version,
    fileName: raw.fileName,
    sizeBytes,
    sha256: raw.sha256.toLowerCase(),
    builtAt: typeof raw.builtAt === 'string' ? raw.builtAt.slice(0, 40) : '',
  };
}
