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
| M9 AI 模板生成 | 图片上传→ZXing 条码→OCR→启发式分类→px→mm→直出 LabelTemplate；再接 Vision LLM 做变量命名与元素裁决 | AI 生成 Tab + 置信度校验 UI | 21 |
| M8 打磨/测试/部署 | 性能压测、并发打号验证、E2E、文档 | GA | 12 |
| **合计** | | | **~141 人日（含 M9 AI 生成 21 人日）** |

> 优先级落地顺序：P0（M0-M6 主线）→ P1（M7 部分 + 多联/双面/SQL数据源）→ P2（插件市场/定时备份对象存储/富文本）。
> **M9 AI 模板生成**可独立于主线推进（详见 `09-ai-template-generation.md`）：P0-MVP（不调 LLM）约 4 天即可跑通闭环，P1-Vision 约 5 天接入多模态模型。

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
  web:      { image: nginx:alpine, volumes: ["./web:/usr/share/nginx/html:ro"], ports: ["5180:80"] }
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

`cd backend && npx tsc -p tsconfig.json --noEmit` → **0 错误**（NestJS 应用骨架 + 核心引擎全部通过类型检查）。前端为 `web/` 原生 HTML5 无构建，`node web/serve.mjs 5180` 静态服务即可运行。

---

## 8.6 P8 收费能力补齐路线（2026-11-13 定稿）

> 输入：与「专业条码打印软件收费功能清单」（BarTender / NiceLabel / CODESOFT / 中琅 / ZebraDesigner 通用）逐项核对当前仓库的结果，逐项证据见 `docs/10-dev-handover.md §10.28`。
> 结论先说：系统在**多租户治理、权限审计、订阅计费、码制覆盖**上强于传统桌面软件；缺口集中在**无人值守自动化、印刷级输出、模板发布治理、本地硬件直连**。

### 8.6.1 排序原则（不要按「看起来重要」排）

1. **依赖闭包**：能复用现有 `jobs/`（BullMQ maintenance 队列）、`PrintService`、`PrintEvents`、`html-renderer`、`approval.calc`、`audit`、`ACL` 的先做；禁止为单个功能另造一套调度器 / 事件总线 / 状态机。
2. **可验收性**：沙盒只有代码运行时，无 PostgreSQL / Redis / 打印机。**优先「纯函数可测 + 零硬件依赖」**；必须真机或真库的项后置，并在交付时写「需真机/真库验收」，不许按「已交付」表述。
3. **收费密度**：优先直击专业版/企业版付费点——无人值守自动化（HotFolder / 触发器 / Webhook）、印刷级输出（整标签矢量 / PDF）、模板发布审批与防重打印。
4. **形态差异不等于缺口**：LabelFlow 是 Web/SaaS 原生，COM / .NET / 加密狗 / 按打印机授权这类**桌面 License 形态不适用**，由 REST API + MCP + CLI + SaaS 席位承担等价职责；但「本地硬件直连」与「离线自动触发」是真缺口，必须补齐，不能拿形态差异搪塞。
5. 每个阶段沿用 P7 / WP2–WP5 的工程口径：**单一真源 + 纯函数可测核心 + 真实接入 + 诚实标注验收边界**。

### 8.6.2 阶段表（按执行顺序）

| 阶段 | 内容 | 为什么排这个位置 | 主要交付物 | 验收口径 | 沙盒边界 |
| --- | --- | --- | --- | --- | --- |
| **P8.0** | 文档与基线 | 先把顺序、验收口径、诚实边界钉死，避免边做边改口径 | 本 §8.6、`docs/10 §10.28`、状态总表同步 | 文档与代码现状一致 | — |
| **P8.1** | 自动化触发层：HotFolder + 事件触发器 + 出站 Webhook | 复用 `jobs`/BullMQ/`PrintService`/`PrintEvents`；纯函数可测；是 ERP/MES「无人值守」的必付费项；零硬件依赖 | `trigger.calc` / `file-parse` / `trigger.service` / `hotfolder.service` / `webhook` / DDL / 端点 / 单测 | 规则匹配、条件求值、循环防护、SSRF 拦截、文件稳定化、去重键全部有单测；端点 typecheck 通过 | 无 Redis → 队列不真实消费；无 PG → 触发器 CRUD / delivery 落库未实跑；`fs.watch` 可在沙盒用临时目录单测 |
| **P8.2** | 印刷级输出：整标签矢量 SVG + PDF 导出 | 复用 `html-renderer` 元素语义、`bwip-js` SVG、`pdf-lib`（已在 dependencies）；专业版收费点；纯软件可验 | `vector-renderer` / `pdf-export` / 导出端点 / 单测 | SVG 结构、mm→pt 换算、拼版矩阵、PDF 页数/尺寸、字节签名有单测 | 无 CMYK/专色/出血/裁切线；PDF 中文依赖嵌入字体，未内嵌字体时明确 warnings；浏览器端真实打印效果未实跑 |
| **P8.3** | 企业治理：模板发布审批 + 防重打印 + 水印/发布锁定 + 数量策略 | 复用 `approval.calc` 状态机、`audit`、`ACL`、`PrintLog`；企业版收费点；但要改模板与打印主链路，风险高于 P8.1/8.2，故后置 | 模板状态机、dedupe 表、审批端点、水印渲染、打印前置校验 | 状态迁移、防重判定、水印位置、越权拦截可单测 | 需真库验证并发防重与审批事务 |
| **P8.4** | 数据源与核心码制深化：MySQL/SQLServer 驱动、SQL 分页/字段查找/自动刷新、GS1 完整 AI 字典与向导、MaxiCode/HIBC/PZN 位图通道 | 高频付费；但需换 SQL 驱动抽象 + 真连库验收 + 码制手册核对，改动面与验证成本最高 | `sql-executor` driver 抽象、GS1 字典、能力表扩充 | 各驱动只读/参数化回归、GS1 AI 校验 golden | 沙盒无第二套数据库；MaxiCode/HIBC/PZN 需真机译码验证 |
| **P8.5** | 硬件层：Windows 本地打印代理（spooler/USB）、RFID 读写、喷码机输出 | 真机依赖最重，沙盒完全无法验收；只能交付协议层 + 客户端骨架 + 明确的真机验收清单，最后做 | `windows_spooler` Provider、本地代理协议、RFID 接口 | 协议单测 + 真机验收清单 | **必须标注「未验收」**，禁止对外承诺可用 |

### 8.6.3 本轮范围与后续

- **本轮执行 P8.0 + P8.1 + P8.2**，P8.3–P8.5 只落路线与验收口径，代码留待后续。
- 本轮实跑结果（2026-11-13）：`typecheck 0 error` / `npm test 349 全绿`（342 pass / 7 skip）/ `lint 0 error 11 warning`（基线一致）/ 全量 `tsc` 编译通过 / DI 图无解析错误 / 真实 SVG→PDF 冒烟产出合法 PDF。逐项交付与待验收边界见 `docs/10 §10.28.5`。
- 每轮收口动作：`npm run typecheck` → `npm test` → `npm run lint` → `tsc -p tsconfig.json` 全量编译 → `git commit`；文档状态总表随代码同步，不写「已完成」而写「代码已落地 / 待真库或真机验收」。
- 新增端点与部署增量必须同步 `docs/05-api.md` 与 `docs/10 §10.28`，避免交接失真。
