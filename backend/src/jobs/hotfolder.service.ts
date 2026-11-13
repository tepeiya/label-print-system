// =============================================================================
// HotFolderService —— P8.1 热目录监听适配器（BarTender Hot Folder 等价能力）
//
// 工作方式：启动时扫描启用的 hotfolder 规则 → 对配置的目录建 fs.watch →
//   文件到达 → 稳定化判定（size/mtime 连续两次一致 + 500ms 窗口）→ 解析 CSV/TSV/JSON/TXT
//   → 作为 hotfolder.file 事件入 BullMQ 'trigger' 队列 → 由 TriggerService 匹配规则并执行
//   （典型动作：print = 文件到达即自动打印）。
//
// 为什么「入队成功」就归档：归档语义是「已受理」，不是「已打印成功」。
// 打印结果由 trigger_deliveries / print_logs 追溯；把文件留在原目录反而会被反复受理。
//
// 已知边界（写进 docs/10 §10.28.4）：
//   - fs.watch 是单进程监听；多实例部署需共享存储 + 队列 dedupe（jobId 用事件指纹）或分布式锁；
//   - 沙盒无 PostgreSQL / Redis，启动时规则加载与真实入队未实跑，只有纯函数层有单测。
// =============================================================================
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DataSource } from 'typeorm';
import { parseDropFile } from './file-parse';
import {
  STABLE_MS, dropFileKey, fileStable, type FileStat, type TriggerEvent,
} from './trigger.calc';
import { TriggerService } from './trigger.service';

const DATA_EXTS = ['.json', '.csv', '.tsv', '.txt'];

interface HotRule { id: number; tenantId: number; config: Record<string, any> }

@Injectable()
export class HotFolderService implements OnModuleInit, OnModuleDestroy {
  private logger = new Logger('HotFolderService');
  private watchers: fs.FSWatcher[] = [];
  private observed = new Map<string, FileStat>();
  private inFlight = new Set<string>();

  constructor(
    @InjectDataSource() private catalog: DataSource,
    private triggers: TriggerService,
  ) {}

  async onModuleInit() {
    if (String(process.env.HOTFOLDER_ENABLED ?? '1') === '0') {
      this.logger.log('HotFolder 已按环境变量显式关闭（HOTFOLDER_ENABLED=0）');
      return;
    }
    let rows: any[];
    try {
      // 平台级扫描（受控例外）：候选集只用于建 watcher，每条事件显式带 tenant_id
      rows = await this.catalog.query(
        `select id, tenant_id, config from public.print_triggers
         where source = 'hotfolder.file' and enabled = true`, [],
      );
    } catch (e: any) {
      this.logger.warn(`HotFolder 规则加载失败（沙盒无 PG 时属预期，不阻断启动）：${e?.message ?? e}`);
      return;
    }
    for (const r of rows) {
      const cfg = r.config ?? {};
      const dir = String(cfg.directory ?? '').trim();
      if (!dir) { this.logger.warn(`HotFolder 规则 ${r.id} 未配置 directory，跳过`); continue; }
      this.watchDirectory(path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir), {
        id: Number(r.id), tenantId: Number(r.tenant_id), config: cfg,
      });
    }
    this.logger.log(`HotFolder 已启动，监听 ${this.watchers.length} 个目录`);
  }

  onModuleDestroy() {
    for (const w of this.watchers) { try { w.close(); } catch { /* ignore */ } }
    this.watchers = [];
  }

  private watchDirectory(dir: string, rule: HotRule) {
    try {
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); this.logger.log(`已创建热目录 ${dir}`); }
      const watcher = fs.watch(dir, (_evt, filename) => {
        if (filename) void this.onChange(rule, dir, String(filename));
      });
      watcher.on('error', (e) => this.logger.warn(`watch ${dir} 出错：${e?.message ?? e}`));
      this.watchers.push(watcher);
      // 启动时处理目录里已存在的文件（进程重启后不丢单）
      for (const f of fs.readdirSync(dir)) void this.onChange(rule, dir, f);
    } catch (e: any) {
      this.logger.warn(`无法监听热目录 ${dir}：${e?.message ?? e}`);
    }
  }

  private async onChange(rule: HotRule, dir: string, filename: string) {
    if (filename.startsWith('.') || !DATA_EXTS.includes(path.extname(filename).toLowerCase())) return;
    // 归档/失败目录里的文件不再处理
    if (filename.includes(path.sep)) return;
    const full = path.join(dir, filename);
    if (this.inFlight.has(full)) return;

    let st: fs.Stats;
    try { st = fs.statSync(full); if (!st.isFile()) return; }
    catch { return; }

    const now = Date.now();
    const cur: FileStat = { size: st.size, mtimeMs: st.mtimeMs, seenAt: now };
    const prev = this.observed.get(full) ?? null;
    const verdict = fileStable(prev, cur, now);
    this.observed.set(full, cur);
    if (!verdict.stable) {
      // 写入结束后不再有 fs 事件，也要靠这次复查收敛
      const t = setTimeout(() => void this.onChange(rule, dir, filename), STABLE_MS + 50);
      t.unref?.();
      return;
    }

    this.inFlight.add(full);
    try {
      const parsed = parseDropFile(filename, fs.readFileSync(full, 'utf8'));
      const event: TriggerEvent = {
        source: 'hotfolder.file',
        tenantId: rule.tenantId,     // 显式 tenant_id，绝不从目录路径猜
        payload: {
          fileName: filename, directory: dir,
          rowCount: parsed.rows.length, columns: parsed.columns,
          rows: parsed.rows, warnings: parsed.warnings,
        },
        eventId: dropFileKey(rule.id, full, { size: st.size, mtimeMs: st.mtimeMs }),
        depth: 0,
      };
      const r = await this.triggers.enqueue(event);
      if (!r.enqueued) throw new Error(`入队失败：${r.reason ?? 'unknown'}`);
      await this.dispose(String(rule.config?.onSuccess ?? 'archive'), dir, filename, full);
      this.logger.log(`HotFolder 受理 ${filename}（${parsed.rows.length} 行，tenant=${rule.tenantId}）→ ${r.jobId}`);
    } catch (e: any) {
      this.logger.warn(`HotFolder 处理 ${filename} 失败：${e?.message ?? e}`);
      await this.moveTo('failed', dir, filename, full);
    } finally {
      this.inFlight.delete(full);
      this.observed.delete(full);
    }
  }

  /** archive（默认）/ delete / keep */
  private async dispose(mode: string, dir: string, filename: string, full: string) {
    if (mode === 'keep') return;
    if (mode === 'delete') { try { fs.unlinkSync(full); } catch { /* ignore */ } return; }
    await this.moveTo('processed', dir, filename, full);
  }

  private async moveTo(sub: string, dir: string, filename: string, full: string) {
    try {
      const dest = path.join(dir, sub);
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(full, path.join(dest, `${stamp}-${filename}`));
    } catch (e: any) {
      this.logger.warn(`归档 ${filename} 到 ${sub}/ 失败：${e?.message ?? e}`);
    }
  }
}
