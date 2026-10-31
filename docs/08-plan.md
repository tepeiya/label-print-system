# 8. 分阶段开发计划与测试要点

## 8.1 里程碑与工时估算（按 1 名全栈 + 1 名前端 + 1 名后端，单位：人日）

| 阶段 | 范围 | 关键交付 | 工时 |
| --- | --- | --- | --- |
| M0 基建 | 项目脚手架、PG/Redis/Docker Compose、JWT+多租户守卫、统一响应/异常/分页 | 可启动服务、登录、租户隔离中间件 | 8 |
| M1 模板服务 | 模板 CRUD/复制/收藏/搜索、JSONB 存储、版本快照、导入导出 .ziptpl、缩略图 | 模板 API + 迁移器 | 12 |
| M2 设计器前端 | Konva 画布（mm/缩放/标尺/网格/参考线）、12 类元素、属性面板、撤销重做、对齐吸附 | 可拖拽设计出 JSON | 25 |
| M3 变量/公式/流水号 | 变量定义、公式引擎（AST+循环检测）、流水号服务（行锁+号段） | 三者引擎 + 单测 | 15 |
| M4 条码/二维码 | 校验位算法、服务端出图、前端实时预览、中文 UTF-8 | 渲染适配层 | 10 |
| M5 打印引擎 | PrinterProvider 抽象、RawTcp/Image/Browser/本地代理、打印机管理、BullMQ 队列、批量/重打 | 端到端打印 | 18 |
| M6 数据源/批量 | CSV/Excel 导入映射、SQL 数据源、批量校验预览 | 批量打印闭环 | 10 |
| M7 备份/审计/权限 | 整租户备份恢复、审计日志、资源级 ACL 共享 | 合规能力 | 10 |
| M8 打磨/测试/部署 | 性能压测、并发打号验证、E2E、文档 | GA | 12 |
| **合计** | | | **~120 人日（约 6 个月，3 人）** |

> 优先级落地顺序：P0（M0-M6 主线）→ P1（M7 部分 + 多联/双面/SQL数据源）→ P2（插件市场/定时备份对象存储/富文本）。

## 8.2 测试要点（附用例）

### 8.2.1 并发打号（流水号不重号）
- **场景**：1000 并发请求各分配 1 号；以及 20 并发各批量分配 100 号。
- **预期**：`serial_usage_log` 中 `value` 全局唯一、连续、无缺口（rollback_policy=consume 时允许跳号但连续消费）。
- **断言**：
  ```sql
  -- 无重复
  SELECT value, COUNT(*) FROM serial_usage_log WHERE sequence_id=?
  GROUP BY value HAVING COUNT(*)>1;  -- 期望 0 行
  -- 连续性（consume 模式允许缺口，但 issued 段不重叠）
  ```
- **注入验证**：中途 kill worker，确认下次分配不重复旧号（号段游标已持久化）。

### 8.2.2 条码校验位
- **EAN-13**：`690123456789` 前 12 位 → 校验位应为 `0`（用 `gtinCheckDigit` 断言）。
- **Code39**：`ABC` → 校验字符 `'X'`（`code39CheckChar` 断言）。
- **Code128-B**：`'ABC123'` → `code128CheckValue%103` 与 bwip-js 编码一致（对拍测试）。
- **非法字符集**：`validateBarcode('EAN13','12A4')` 返回 `ok:false`；`validateBarcode('QR', 'x'.repeat(3000))` 返回超长错误。

### 8.2.3 DPI 换算
- **公式**：`dots = mm * dpi / 25.4`。断言：
  - `mmToDots(1, 203) ≈ 8`、`mmToDots(1,300) ≈ 11.81`、`mmToDots(1,600) ≈ 23.62`。
  - 逆向 `dotsToMm(8,203) ≈ 1.0`，误差 < 0.01mm。
- **清晰度**：同一标签在 203dpi 与 600dpi 出图，600dpi 位图尺寸应为 203 的 ~2.96 倍且文字更锐利（截图像素对比）。

### 8.2.4 多租户隔离
- 租户 A 用其 JWT 访问 `GET /templates/:id`（id 属于租户 B）→ 期望 404（不暴露存在性）。
- 直接 SQL 注入尝试 `?id=1 OR 1=1` → 由于 `WHERE id=$1 AND tenant_id=$2` 参数化，无效。
- `SELECT` 全表审计：任意业务查询执行计划应命中 `(tenant_id, ...)` 索引（EXPLAIN 验证）。

### 8.2.5 公式引擎
- 循环依赖：`{a:'{{b}}+1', b:'{{a}}+1'}` → `detectCircularDeps` 返回 `[a,b]`，保存被拒（错误码 2002）。
- 注入防护：`safeEval('process.exit()', {})` → 无 `process` 标识符，抛「未知变量/函数」，绝不等价执行。
- 错误不阻断：`safeEval('1/0', {})` → `{ok:false, error:'...'}`，元素显示 `{{ERROR}}` 占位并记日志。

### 8.2.6 打印队列
- 1000 条批量任务：入 BullMQ 后 API 立即返回 202，Worker 异步消费，主线程渲染 P95 < 200ms/张。
- 失败重试：故意断网打印机 → 任务 `failed`，重试 3 次后仍失败标记 `failed`，不阻塞兄弟任务。

## 8.3 部署（Docker Compose 摘要）

```yaml
services:
  postgres: { image: pgvector/pgvector:16, environment: { POSTGRES_DB: labelflow } }
  redis:    { image: redis:7 }
  api:      { build: ./backend, environment: [DB_URL, REDIS_URL], depends_on: [postgres, redis] }
  worker:   { build: ./backend, command: npm run worker, depends_on: [redis] }
  web:      { build: ./frontend, ports: ["80:80"] }
```

## 8.4 已实现并验证（截至当前）

| 项 | 结果 |
| --- | --- |
| 核心引擎单元测试 | **16/16 通过**（公式/校验位/流水号并发/DPI/ZPL/TSPL/条码出图/渲染管线） |
| 流水号号段预分配 | 测试验证不重号、不重叠、前缀补零格式正确 |
| 公式沙箱 | 测试验证 `process.exit` 等非法标识符被拒、除零返回错误占位不阻断 |
| 条码自包含出图 | Code128 经内置编码器 + PNG 写出，测试校验 PNG 签名有效 |
| 渲染管线 | 变量占位/公式/流水号按行切片均覆盖 |

> 运行：`cd backend && node --import tsx --test core/__tests__/*.test.ts`

## 8.5 后端类型检查

`cd backend && npx tsc -p tsconfig.json --noEmit` → **0 错误**（NestJS 应用骨架 + 核心引擎全部通过类型检查）。前端设计器为 Vite+React 骨架，需 `cd frontend && npm i` 后 `npm run build` 验证。
