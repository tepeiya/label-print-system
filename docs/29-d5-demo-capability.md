# D5 验收记录 · 能演示能报价（演示环境 + 能力清单 + U6 国家 UDI 导出）

> 日期 2026-11-24。对应 `docs/24-delivery-plan.md` §2.1 的 D5 三门。
> 本轮（D4+D5）结束时全量验收：**39 门 → 39 pass / 0 fail / 0 skip**（历史 skip 的 G8 收货侧 UDI 拦截已于 2026-11-24 补齐，见 `docs/26 §4.1`；报告 `docs/acceptance/latest.json`）。

## 1. 三门结果

| 门 | 要求 | 结果 | 证据 |
|---|---|---|---|
| D5-1 | 一条命令起演示环境并注入样板数据（20 物料 / 2 工单 / 50 UDI 码） | **pass** | `DEMO-1`（编排器实跑 4.9s，断言 25 物料 ≥20 / 2 工单 / 50 UDI）；`bash backend/scripts/demo-up.sh` 本机实测 33 脚本 4s 建库 + 87 表自检 + API 就绪 + 登录成功 |
| D5-2 | 《能力清单（可承诺 / 不承诺）》，每条与验收门一一对应 | **pass** | 本文 §4 表格，承诺项均回指门号 |
| D5-3 | U6 按国家 UDI 字段模板导出 Excel/XML + 字段映射表 | **pass** | `U6`（6 例单测：14 项映射表 / xlsx 双 sheet 回读 / 空数据 / XML 结构 / 特殊字符转义 / 文件名）+ 真机 curl：xlsx 50 行 14 列、xml 50 records×14 fields |

## 2. 一键演示环境

```bash
bash backend/scripts/demo-up.sh              # 依赖→建库→样板→API→健康检查→登录验证
bash backend/scripts/demo-up.sh --reset-db   # 删库重建（清历史演示痕迹）
bash backend/scripts/demo-up.sh --data-only  # 只准备数据（验收编排器用的就是这条）
bash backend/scripts/demo-up.sh --with-web   # 额外把 web 前端 vite preview 起起来
bash backend/scripts/demo-up.sh --down       # 停 API / web
```

本机实测输出（无 docker 的等价起法）：

```
== 1/5 依赖检查 ==       PostgreSQL 就绪 / Redis 就绪
== 2/5 建库 ==           数据库 labelflow_demo 已存在（保留数据）
== 3/5 建表 + 样板 ==    32/33 脚本 ok，缺表自检 PASS：期望 87 张，实际 91 张
                        物料 25 / 工单 2 / UDI 50 / 批次 15
== 4/5 起后端 ==         tsc ok → node dist/src/main.js → /health/ready 通过 → admin 登录成功
== 5/5 web ==            跳过（需要加 --with-web）
```

两种起法：有 docker 且 daemon 可用 → `docker compose up -d postgres redis`（与交付环境一致）；没有 → 系统 PG 14 + Redis 6 + `node dist`（D0/D1 已证明与 compose 等价）。

样板数据 `scripts/seed-demo-hospital.sql`（幂等，`@demo` 登记在 `db-manifest.txt`）：

- 20 个常用医用耗材（成品与原料）（注射器 5/10/20ml、输液器、留置针 22/24G、导尿管、敷贴 10/20cm、手套、口罩、纱布、棉签、酒精棉片、胶带、采血针、采血管、精密过滤输液器、缝合线），每个都带 GTIN14、规格、单位与 `udi_required` 标记。
- 5 个物料做了"一物料多码"（UNIT 主码 + CARTON 箱码，箱规 20/24/50/100）——直接用来演示 U5.3 折箱。
- 1 个成品（注射器 5ml）+ 4 件套 BOM（含损耗率）+ 10 个批次库存。
- 2 张工单：`WO-DEMO-001` RELEASED（演"齐套→放行→扫码发料"）、`WO-DEMO-002` ISSUING（演"发到一半缺料"）。
- 50 个 UDI 单品（`06901234500011|LOT-2611A|SN0001..SN0050`），前 20 个已 PRINTED，全 50 条有 BUILD / PRINT 事件（共 70 条留痕）。

### 2.1 写这个脚本时踩的 4 个坑（都已修）

| 坑 | 现象 | 处理 |
|---|---|---|
| `$!` 记的不是 node 的 pid | `--down` 停了 `api.pid`，但旧 node 还占着 3201，新实例端口冲突静默退出 → 导出仍是旧代码结果 | `stop_one` 改成按监听端口找 pid（`ss -lptn sport = :3201`），pidfile 只作兜底 |
| 后台进程继承 stdout | `demo-up.sh \| tail` 永不结束（子进程握着管道） | 启动命令加 `</dev/null` 断开继承 |
| `udi_events` 事件类型 | 用 `REGISTER` 撞 `ck_udi_events_type` | 合法值只有 `BUILD/PRINT/PRINT_FAIL/RECEIVE/ISSUE/SHIP/RETURN/VOID/REPACK`，建档用 `BUILD` |
| `tenant_modules` 模块码 | 写 `udi` 撞外键（`modules` 表没有这个码） | 改成 `wms.inbound / wms.issuing / wms.trace / inventory / print / bom` |

另外两个修正：PG `format('%04s', n)` 不做零填充（序列号出现 `SN   1`），改 `lpad(g::text,4,'0')`；`JOIN (VALUES …) AS x(...)` 后必须显式 `ON true`，否则后续 `WHERE` 报语法错。

## 3. U6 国家 UDI 导出

端点：`GET /api/v1/udi/export/units.file?format=xlsx|xml&since=&until=&status=&gtin=&limit=`

- 响应沿用项目既有信封：`{ format, fileName, contentType, rows, base64 }`，前端解码下载。**没有**用 `@Res()` 直写，因为全局 `ResponseInterceptor` 会二次包装，硬写响应头会让 Nest 报 headers-sent。
- 与 `export/units.csv` 共用同一套筛选条件，导出行为额外写审计（`udi.export.xlsx` / `udi.export.xml`）。
- Excel 两个 sheet：`UDI 明细`（14 列 × N 行）、`字段说明`（字段/格式/导出范围/生成时间/用途）——销售拿这张表就能和客户平台对字段。
- XML：`<UDIData schema="labelflow-udi-export/1" tenant count generatedAt><Record><Field name title>值</Field>…`，14 个 `Field`/条，特殊字符已转义。

### 3.1 字段映射表（`src/udi/udi.export.calc.ts` · `UDI_DB_COLUMNS`）

| # | 中文名 | 键 | 格式 | 来源 |
|---|---|---|---|---|
| 1 | 产品标识（DI/GTIN） | `gtin` | GTIN-14，14 位字符串 | `udi_units.gtin` |
| 2 | 产品名称 | `productName` | ≤100 字符 | `materials.name`（按 GTIN 反查 `material_gtins` → `materials`，兜底 `materials.gtin`） |
| 3 | 规格型号 | `spec` | ≤100 字符 | `materials.spec` |
| 4 | 生产批号 | `lot` | ≤64 字符 | `udi_units.lot` |
| 5 | 序列号 | `serial` | ≤64 字符，单件唯一 | `udi_units.serial` |
| 6 | 生产日期 | `productionDate` | YYYY-MM-DD | `udi_units.production_date` |
| 7 | 有效期止 | `expiryDate` | YYYY-MM-DD | `udi_units.expiry_date` |
| 8 | 包装标识（SSCC） | `packageSscc` | 18 位 | `udi_units.package_sscc` |
| 9 | 生产工单号 | `workOrderNo` | ≤64 字符 | `udi_units.work_order_no` |
| 10 | UDI 单品键 | `udiKey` | `GTIN\|批号\|序列号\|有效期` | `udi_units.udi_key` |
| 11 | 标签模板 | `templateCode` | ≤64 字符 | `udi_units.template_code` |
| 12 | 打印时间 | `printedAt` | ISO8601 | `udi_units.printed_at` |
| 13 | 状态 | `status` | `REGISTERED/PRINTED/ISSUED/…` | `udi_units.status` |
| 14 | 建档时间 | `createdAt` | ISO8601 | `udi_units.created_at` |

实测（演示库 50 条）：

```
xlsx rows 50 | 06901234500011 | 一次性使用无菌注射器 5ml | 5ml | LOT-2611A | SN0001 | 2026-11-01
xml  records 50 fields 700
```

### 3.2 诚实边界

1. **不是官方 schema**。国家/各省 UDI 平台的报文格式、字段名、上报接口各不相同，没有客户所在平台的接口文档就无法承诺"直接可导入"。这里给的是**扁平可映射的导出**（字段名一一对应中文名），交付时按客户模板改名/套 xslt。
2. **不做自动上报**。`docs/24 §3` 已冻结：上报要接口、鉴权、证书、回执对账，属另行立项。
3. GTIN 依赖"物料登记了 GTIN"；没登记的老物料导出来 `产品名称/规格` 为空（不阻断导出，日志与审计里能看出条数）。
4. 演示数据的 GTIN 是示意值（校验位合法，非真实注册证号），只能演示，不能拿去上报。

## 4. 能力清单（可承诺 / 不承诺）

### 4.1 可承诺（有门、有证据）

| # | 能力 | 对应门 | 证据形态 |
|---|---|---|---|
| 1 | 装得上：容器化部署、建库一条命令、缺表自检 | D0-1…D0-5（`docs/25`） | 87 表自检 PASS、33 脚本 4s、等价起法实测；docker 真跑 **BLOCKED(环境无 daemon)** |
| 2 | 建库幂等、可整体重跑 | D0-5 | `db-init.sh` 连跑两次 0 差异 |
| 3 | 真库验收一键出报告 | D1-1…D1-4（`docs/26`） | `docs/acceptance/latest.json`（39 门） |
| 4 | 发料链路真的对：BOM 展开/齐套/扣库存/重跑不二次扣/缺料 | G1–G7 | 真 PG 集成 7 例 |
| 5 | 收货链路：跨租户隔离、重复过账拒绝、打印降级、过账失败不留脏数据、订阅门 | T1–T5 | 真 PG 集成 5 例 |
| 6 | UDI 建档/解析/GS1 回环/追溯正反向/合规留痕/扫码旁路 | U1、U2、U5 | UDI 定向单测 |
| 7 | GTIN 只收 13/14 位、一物料多码整组匹配、拆箱换算 | U5.1–U5.3 | 单测 + 演示数据可复现 |
| 8 | PDA 收货→上架→发料→退料全链，行状态 ISSUING→ISSUED | D4-1、D4-3 | 真 PG 5 例；PDA 页面已构建 |
| 9 | 发料扫箱码按单品件数扣台账（与收货同口径） | D4-2 | `stock_moves` qty=-48 / after=452 |
| 10 | 退料 RETURN + 回补 + 批次可追溯 + 重复提交幂等 | D4-3 | 二次提交 `idempotent:true`，库存只补一次 |
| 11 | 运维底线：`/health/live|ready`、traceId 单行 JSON 日志、限流、优雅停机 | D2-1…D2-4（`docs/27`） | 实测 503 摘流、429 触发、shutdown_ok |
| 12 | 多租户 RLS 真兜底（`DB_RLS_ENFORCE=1` + `labelflow_app`） | R1–R3 | 无 GUC 0 行、带 GUC 只见本租户、WITH CHECK 拒越权写 |
| 13 | 一条命令起演示环境 + 医疗样板数据 | D5-1 | `demo-up.sh` 实测 |
| 14 | 国家 UDI 台账导出 Excel/XML + 字段映射表 | D5-3 / U6 | 50 行 × 14 列实测 |
| 15 | 全量单测 959 例回归（952 pass / 0 fail / 7 skip；含质量闸门 21 例） | UNIT-ALL | 2026-11-25 实测 |
| 16 | 收货侧 UDI 强制拦截（`udi_required` 必须带码、码不符拒收、箱码折件数） | G8 | 真库 6 例（`docs/26 §4.1`） |
| 17 | 成品发运闭环：发货单建档→FIFO 推荐→拣货→出库过账（扣库存+写台账）→签收；缺量记 `SHORT` 不假装发齐 | WMS 阶段三（`docs/35`） | 真库实测：SH-20261125-0001 扣 400+100、库存 2400→2000、重复过账与已出库作废均 400 拒绝 |
| 18 | 出库联动 UDI：单品码逐个置 `SHIPPED`，托盘 SSCC 整包递归置 `SHIPPED` | O1（`docs/35 §4`） | 真库实测：2 码 `RECEIVED→SHIPPED`、1 箱 2 单元 `units:2/failed:0`；`shippedCount` 不再是 0 |
| 19 | 收货即入待检：`qc_required` 物料收货批次置 `PENDING`，领料/发货一律被拦（报「另有 N 件…未通过质量闸门」而非「没货」） | P0-1（`docs/36`） | 真库实测：待检批次发货 400 + 库存零变动；判合格后同单 201 |
| 20 | 成品放行：检验合格 ≠ 可销售，须 QA 凭本人密码电子签批；未放行批次发货被 400 拦 | P0-2（`docs/36 §3.2`） | 真库实测：FQC 判 PASS 后批次仍 `PENDING`；错密码 401；签批后 `RELEASED` 才发货成功 |
| 21 | 批记录最小版：一批一条（唯一约束）、工序/设备/操作人/时间/参数/结果、缺项与 FAIL 无备注拒提交、质量批准，且聚合该批 UDI 码与检验单数 | P0-3（`docs/36 §3.3`） | 真库实测：`BR-20261125-0002` 3 道工序 → 提交 → APPROVED；21 例定向单测 |

### 4.2 不承诺（明确不做的，或没有证据的）

| # | 不承诺项 | 原因 / 状态 |
|---|---|---|
| 1 | 真机打印出纸（Zebra / 汉印 / GODEX 各一张） | 仍未做；`docs/24 §4` 写明"没有真机标签，客户不会签" |
| 2 | ~~Windows 打印代理~~ | **已补齐**：`apps/print-agent` 已交付，协议/装机/回执/离线补打见 `docs/31`；仍缺真机矩阵逐台验收 |
| 3 | PDF / 浏览器预览兜底 | 代理侧 PDF 帧仍回 `failed`（缺 PDFium 等渲染依赖）；`browser` 通道可用 |
| 4 | ~~收货侧 UDI 强制拦截的端到端证据~~ | **已补齐**：G8 转绿（无码/码不符拒收、正确码放行、箱码折件数），`docs/26 §4.1` |
| 5 | 国家 UDI 平台自动上报 | 冻结（`docs/24 §3`），只做导出 |
| 6 | 官方 XML schema 直通 | 只做映射导出，真实平台格式需客户提供模板后适配 |
| 7 | CI 在 GitHub 上真跑 | workflow 文件在 `deploy/ci/`，当前凭据无 `workflow` scope，无法落到 `.github/workflows/`（`docs/27 §4`） |
| 8 | docker 真 build / 真 up | 环境无 daemon，只做了等价实证（`docs/25`） |
| 9 | 高并发 / 性能压测 | 冻结（无客户量级数据） |
| 10 | ~~SSCC 托盘递归~~、模板市场、多语言、看板增强 | SSCC 递归**已实现**（出库按包层级联动，`docs/35 §4`）；模板市场/多语言/看板增强仍冻结 |
| 11 | 备份 PITR / 独立库物理备份 | 冻结，仅逻辑导出 |
| 12 | 按单个 UDI 码退料、扫码枪前端实测 | 未做，需现场需求 |
| 13 | 发货单/装箱单打印、客户主数据、物流轨迹回传、波次拣货 | 未做（`docs/35 §8`） |
| 14 | 不合格品处置单（评审/返工/让步接收/销毁审批） | 未做：当前只有「判不合格 → 隔离 → 报废」最短路径（`docs/36 §8-2`） |
| 15 | 放行强制绑定批记录 APPROVED | 未做：放行只校验「有 PASS 检验单」，不校验批记录状态（`docs/36 §8-3`） |
| 16 | PDA 检验判定页、冻结（FROZEN）批量操作页 | 未做：检验判定在 PC 端完成；冻结只能走 API（`docs/36 §8-1/5`） |
| 17 | 物料免检清单按客户确认 | 待确认：当前按 `udi_required` 默认要检（13 个耗材），上线前须与质量部核对（`docs/36 §9`） |

### 4.3 报价口径建议

- **可以报"可交付"的部分**：D0+D1+D2（装得上、验得过、坏了能查）+ D4（流程闭合）+ D5（演示与导出）。这是当前仓库的真实状态。
- **D3 是签单硬门槛**：对外话术应是"标签排版与打印指令已就绪，真机出纸需按客户机型做一次联调（1–2 天/机型）"，不要承诺"拿来就打"。
- **不承诺项一律写成"待客户确认后立项"**，尤其是国家平台上报与官方 XML 直通——这两项没有客户平台文档就是无底洞。

## 5. 复跑

```bash
# 演示环境
bash backend/scripts/demo-up.sh --reset-db

# 导出（token 从登录取）
TOKEN=$(curl -s -X POST localhost:3201/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | sed -nE 's/.*"accessToken":"([^"]+)".*/\1/p')
curl -s "localhost:3201/api/v1/udi/export/units.file?format=xlsx" -H "Authorization: Bearer $TOKEN" -o u.json
node -e 'const d=require("./u.json").data;require("fs").writeFileSync("udi.xlsx",Buffer.from(d.base64,"base64"))'

# 门
cd backend && node --import tsx --test src/udi/__tests__/udi.export.test.ts
cd backend && DB_PORT=5432 DB_NAME=labelflow_test DB_RLS_PASSWORD=app_pw_123 node scripts/acceptance-run.mjs
```
