# LabelFlow 交付化开发计划（v2）

> 编制日期 2026-11-23。依据：对 `tepeiya/label-print-system` 全仓的代码体检（HEAD `0c36553`）。
> 本计划替代 `docs/08-plan.md` 的排期口径：**不再按功能模块推进，按"能不能交付"推进**。
> 规则：只做本计划内的事项；计划外需求以客户原话或合同条款为依据另行立项。

---

## 1. 代码体检结论

### 1.1 规模与构成

| 维度 | 实测 |
|---|---|
| 代码总量 | 65,886 行（`backend/src` + 4 个前端，不含 vendor） |
| 后端模块 | 23 个：`print` 5,151 / `agent` 5,156 / `saas` 4,655 / `inventory` 3,838 / `wms` 3,816 / `udi` 3,071 等 |
| API | `255` 个路由端点，`29` 个 controller |
| 测试 | `74` 个测试文件、`8,404` 行；全量 **860 例 / 853 通过 / 0 失败 / 7 跳过** |
| 前端 | `console`(26 页) / `platform`(9 页) / `pda`(7 页) / `mcp-server` / 老 `web`（已标弃用） |
| 数据表 | `docs/03-database.sql` 19 张 + `backend/scripts/*.sql` 增量 60 张 ≈ 79 张 |
| 迁移 | 30+ 个 SQL 文件，**无 runner、无 manifest、无版本号** |

### 1.2 真正能跑的（有证据）

- `pnpm typecheck` 零错误；`npx tsc -p tsconfig.json` 可产出 `dist/`（256 个 js）。
- 全量测试 853 过 / 0 失败（7 跳过为环境缺外部依赖）。
- `console` / `pda` / `platform` 三个前端 `vue-tsc + vite build` 均通过。
- 核心引擎（公式、校验位、流水号、条码、ZPL/TSPL/EPL、DPI）纯函数层完整，有 golden 与回环测试。
- WMS（收货/上架/齐套/发料/退料）、UDI（构造/解析/追溯/合规报表/扫码拦截）代码链路闭合，服务层有单测。

### 1.3 阻塞交付的六个硬伤（本轮体检新发现，均已复现）

| # | 硬伤 | 证据 | 后果 |
|---|---|---|---|
| H1 | **无任何 Dockerfile** | `find . -name Dockerfile*` 为空；`docker-compose.yml` 里 `api:` 与 `worker:` 写 `build: ./backend` | `docker compose up -d` 直接失败，README 的"一键全家桶"不可用 |
| H2 | **生产构建脚本已坏** | `pnpm build` = `nest build`，实测报 `Collection "@nestjs/schematics" cannot be resolved` | 无 `dist` 产物，只能 dev 跑或手改 `tsc` |
| H3 | **前端不在部署链里** | compose 只有 pg/redis/api/worker/web；console 用 dev 代理 `baseURL: '/api/v1'` | 客户拿到只有 API，没有界面 |
| H4 | **建库靠手工顺序执行** | README §5 只列了 `saas_p*`/`inventory_*`，**未列** `udi_p1_trace.sql`、`wms_p1_inbound.sql`、`wms_p2_issuing.sql`、`wms_u5_*.sql`；顺序只写在文件头注释 | 新机器装库必错，且错在 RLS 顺序上会静默失效 |
| H5 | **多租户 RLS 实际未生效** | `saas_p6_rls.sql` 为 `labelflow_app`（NOBYPASSRLS）建策略；compose 里 API 连的是 `labelflow`（POSTGRES_USER，超管/owner） | 演示环境隔离全靠应用层 WHERE，安全承诺无法对外说 |
| H6 | **运维底线缺失** | 无 `/health` 路由、无限流、`main.ts` 无结构化日志、无 CI、`docs/10 §10.22.4` 自认"主链路还没切到 `labelflow_app`" | 上线后无法定位故障，也无法做 SLA |

### 1.4 产品完整性缺口（非阻塞交付，但影响成单）

- **PDA 无发料页**（只有收货/上架/UDI 复核）→ 医院"收货→上架→发料"现场流程断在最后一环。
- **零真机打印验证**：`WindowsSpoolerProvider` 需 Windows 打印代理，未实现；ZPL/TSPL 的 FNC1 未逐机型实测。
- **真库零验收**：`docs/17` G1–G7、`docs/19` UDI 7 门、`docs/20/21/22` 的 U5 门，全部"未执行"。
- **无演示数据一键载入**（`seed-inventory-demo.sql` 存在，但要手工 psql）。
- 国家 UDI 数据库导出（U6）未做；备份仅逻辑 gzip。

---

## 2. 计划总览（5 个阶段，约 24 人日）

排序原则：**先让它装得上，再证明它真的对，然后才加东西。**

| 阶段 | 主题 | 核心交付 | 人工日 | 依赖 |
|---|---|---|---|---|
| **D0** | 装得上 | Dockerfile ×4、构建脚本修复、统一建库 runner + manifest、compose 接入前端、README 部署章重写 | 4 | 无 |
| **D1** | 真库验收 | 一次性可重跑的验收脚本，跑通 WMS G1–G8、UDI 门、U5/U5.1/U5.2/U5.3 门，输出 JSON 报告 | 4 | D0 |
| **D2** | 运维底线 | `/health`(DB/Redis/队列)、traceId 全链日志、登录与扫码限流、优雅停机、CI 三 job、RLS 切 `labelflow_app` | 4 | D1 |
| **D3** | 打印真机闭环 | ZPL/TSPL 三款机型实打实扫、Windows 打印代理最小可用、UDI DataMatrix 指令通道验证、无打印机时的 PDF/预览兜底 | 5 | 需真机 |
| **D4** | 医院流程闭环 | PDA 发料页、发料侧包码折算（U5.3 遗留）、`SHIP`/`RETURN` 联动、退货回库存 | 4 | D1 |
| **D5** | 商业化包装 | 一键演示环境、能力清单与白标、U6 国家 UDI 导出（Excel/XML） | 3 | D2 |

### 2.1 每阶段的验收门（必须可机器判定）

**D0 — "装得上"**
1. 全新机器 `docker compose up -d`，**5 分钟内** `curl -s localhost:3200/api/v1/auth/login -d '{"username":"admin","password":"admin123"}'` 返回 token。
2. `docker compose down -v && docker compose up -d` 重来一次仍通过（证明建库不是手工残留）。
3. 浏览器打开 `localhost:5173`（console）能登录、看到菜单；`5181`（platform）同上。
4. `pnpm build` 零报错产出 `dist`，镜像内运行 `node dist/src/main.js` 能起服务。
5. 建库顺序固化在一个 manifest 文件里，脚本逐条执行且幂等；缺表检测脚本返回 0。

**D1 — "真的对"**
1. `bash backend/scripts/db-acceptance.sh` 一条命令跑完，退出码 0，产出 `docs/acceptance/latest.json`。
2. 覆盖：BOM 展开、齐套率、扣库存与 `stock_moves` 台账、重跑不二次扣减、缺料无记录、退料回补、跨租户不可见；UDI 建档/收货/发料/追溯正反向/合规报表；GTIN 拦截、多码整组、`pack_qty` 折算。
3. 报告里每条门标注 `pass/fail/skip` 与耗时，`skip` 必须写明原因。
4. `docs/17`、`docs/19`、`docs/20–23` 的"未验证"标注逐条改判。

**D2 — "坏了能查"**
1. `GET /health` 返回 `{db, redis, queue}` 三态与版本号，DB 断开时返回 503。
2. 日志每行带 `traceId`，响应体 `traceId` 与日志可对齐（抽 1 例验证）。
3. 登录失败 10 次/分钟即 429；扫码接口 300 次/分钟即 429。
4. `SIGTERM` 后 10 秒内退出且不杀正在执行的打印任务（宽限窗口）。
5. GitHub Actions：`typecheck` + `test` + 三前端 `build` 三个 job 全绿（在 PR 上可见）。
6. 应用连库切到 `labelflow_app`，跨租户 SQL 直查返回 0 行（RLS 真生效的实证）。

**D3 — "打得出"**
1. 三款机型（Zebra ZD421 / 汉印 N41 或 SL42 / GODEX RT700i）各出一张 UDI 标签照片。
2. 用 PDA 扫回，`GTIN/批号/序列号/有效期` 四项与打印源一致。
3. Windows 打印代理：一台 Windows 机器装代理后，console 点打印即出纸，断网重连能续传。
4. 无打印机场景：PDF 下载与浏览器预览可用（演示兜底）。

**D4 — "流程闭合"**
1. PDA 上完成 收货→上架→发料 全链，工单行状态从 `ISSUING` 到 `ISSUED`。
2. 发料扫包码：台账扣减为单品件数，与 U5.3 收货口径一致。
3. 退货：`RETURN` 事件 + 库存回补 + 批次可追溯，重复提交幂等。

**D5 — "能演示能报价"**
1. 一条命令起演示环境并注入样板数据（3 家医院常见的 20 个物料、2 张工单、50 个 UDI 码）。
2. 交付一份《能力清单（可承诺 / 不承诺）》，每条与验收门一一对应。
3. U6 导出：按国家 UDI 数据库字段模板输出 Excel/XML，字段映射表随附。

---

## 3. 明确不做（Out of Scope，本轮冻结）

以下事项即使有人提，也不在本计划内；要做得有客户原话或合同条款：

- 新功能：SSCC 箱码、托盘层级递归换算、AI 更多工具、模板市场、多语言、主题换肤、更花哨看板。
- 已弃用 `web/` 目录的任何增强（D0 顺带标记为只读）。
- 税务发票、支付自动扣款、退款红字、多币种（`docs/10` 已列缺口，属 P3 商业条款）。
- 独立库租户的物理备份/PITR（只保留逻辑导出，写入运维文档）。
- 性能压测与大规模并发优化（无客户量级数据前不做）。

---

## 4. 停手线（什么时候算"做完了"）

**对外报价的底线是 D0 + D1 + D2 完成**：装得上、验得过、坏了能查。这三步之后系统就是一个可以给医院 IT 装、可以出验收报告的产品。

D3 之后才谈"能卖"：打印出纸是医疗 UDI 场景的硬门槛，没有真机标签，客户不会签。
D4 之后才谈"能长期用"：发料不断链，医院才会续费。
D5 是销售动作，不是开发动作。

每完成一个阶段，`README §6` 的进度表与本文档的验收门同步更新；未达标不进下一阶段。

---

## 4.1 执行进度（2026-11-24）

| 阶段 | 状态 | 验收记录 |
|---|---|---|
| D0 装得上 | ✅ 完成（`f2a3789`） | `docs/25-d0-acceptance.md`（docker 真跑 BLOCKED，等价实证通过） |
| D1 真库验收 | ✅ 完成（`e712495`；G8 于 2026-11-24 补齐） | `docs/26-d1-acceptance.md`（G1–G7 + G8 全绿，见 §4.1） |
| D2 运维底线 | ✅ 完成（`0e809df`） | `docs/27-d2-hardening.md`（R1–R3 全绿；CI 需 workflow scope） |
| D3 打印真机 | ⏭️ 暂缓 | 用户 2026-11-24：暂无打印机，先做 D4/D5 |
| D4 流程闭合 | ✅ 完成 | `docs/28-d4-flow-closure.md`（D4-1…D4-3 真库五门全绿） |
| D5 演示与报价 | ✅ 完成 | `docs/29-d5-demo-capability.md`（DEMO-1 / U6 门通过，能力清单 §4） |
| D6 自助答疑 | ✅ 完成 | 平台端知识库（16 篇）+ AI 助手悬浮球；`/kb/*` 平台身份守卫；配置四级回退 + 无模型降级；`docs/30` |
| D7 打印代理 | ✅ 完成（`6f59de4`…） | Windows 本地代理（`apps/print-agent`，winspool RAW 直发）+ 租约 TTL/拉取上限可配 + 过期任务定时回收；租户控制台「一键安装」一行命令（`/agent/setup.ps1`）→ 下载/装机/选队列/存密码/开机自启全自动，注册即自动建打印机；`docs/31` |

最新全量验收：**39 门 → 39 pass / 0 fail / 0 skip**（G8 收货侧 UDI 拦截已补真库夹具），`docs/acceptance/latest.json`。

## 5. 执行规则

1. 每个阶段先写"阶段开工单"（改哪些文件、验哪些门），做完写"阶段验收记录"（`docs/24` 附录递增）。
2. 每阶段结束跑一遍全量 `pnpm test` + `pnpm typecheck` + 三前端 build，数字写进记录，退化即回滚。
3. 提交按阶段一个 commit，message 带阶段号；推送前按当轮指令。
4. 涉及真机、真库、真域名的门，若环境不可得，标记 `BLOCKED(缺硬件)` 并明确"谁提供、什么条件下补验"，不用单测冒充。
