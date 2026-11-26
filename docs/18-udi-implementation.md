# UDI 医疗合规赋码 · 实施记录（里程碑 U1）

> **背景**：商业化路径选定"医药 UDI"（依据见对话结论与 NMPA 2026 年第 21 号公告时间表：
> 全部二类器械 2027-06-01 前赋码、全部一类 2029-06-01 前）。本里程碑先把"码对不对、
> 扫得出、防错料"这条地基做扎实，再谈追溯与上报。
> **代码**：`backend/src/udi/**`、`backend/core/{types,barcode-renderer}.ts`（gs1 通道）。

---

## 1. 本里程碑交付了什么

| # | 能力 | 落点 | 状态 |
|---|---|---|---|
| 1 | UDI 数据构造：GTIN 补位/校验位、GS1 日期、批号/序列号、DI/PI 拆分、HRI、元素串（FNC1） | `udi.calc.ts: buildUdi` | ✅ |
| 2 | UDI 解析：HRI（带括号）与原始元素串（`\u001D` / `<GS>`）双向 | `udi.calc.ts: parseUdi` | ✅ |
| 3 | GS1 DataMatrix 渲染通道（bwip 原生 `gs1datamatrix`） | `core/barcode-renderer.ts`（`gs1: true` 开关） | ✅ |
| 4 | 扫码复核（与工单预期逐字段比对，strict 模式支持整单校验） | `udi.service.ts: scanVerify` | ✅ |
| 5 | 批量构造（Excel 行导入，部分成功口径） | `udi.service.ts: batchEncode` | ✅ |
| 6 | 3 个 UDI 模板包（单件 50×30 / 箱 100×70 / 试剂瓶 30×20） | `udi.templates.ts` + `GET /udi/templates/:code` | ✅ |
| 7 | API 7 个端点 + 模块装配 | `udi.controller.ts` / `udi.module.ts` / `app.module.ts` | ✅ |

## 2. 接口清单（前缀 `/api/v1`）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/udi/status` | 能力与边界自述（销售/实施现场可直接展示） |
| GET | `/udi/templates` | 模板包清单（code/名称/场景/页面/变量） |
| GET | `/udi/templates/:code` | 取模板完整 JSON，直接喂 `POST /templates/import` |
| POST | `/udi/encode` | 构造 UDI，返回 `hri / elementString / di / pi / unitKey / barcode` |
| POST | `/udi/parse` | 解析扫码内容（HRI 或原始串） |
| POST | `/udi/scan-verify` | PDA 复核：`{ code, expect:{gtin,expiry,lot,serial}, strict? }` |
| POST | `/udi/batch` | 批量构造（≤5000 行，逐行返回） |

示例：

```bash
curl -X POST http://localhost:3200/api/v1/udi/encode -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"gtin":"6901234567892","expiry":"2027-12-31","lot":"LOT01","serial":"SN0001"}'
# → hri: (01)06901234567892(17)271231(10)LOT01(21)SN0001
#   elementString: 0106901234567892172712310LOT01␝21SN0001
```

## 3. 验证证据（可复跑，不连库）

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `src/udi/__tests__/udi.calc.test.ts` | 29 | GTIN 补位/校验位/错误提示、日期格式与闰年、构造顺序、FNC1 位置、批号长度/字符集、重复 AI、DI/PI、解析双向、缺 01 |
| `src/udi/__tests__/udi.roundtrip.test.ts` | 2 | **打印回环**：构造 → bwip 渲染 PNG → zxing 解码 → 反解出 DI/PI（这是"扫得出"的硬证据） |
| `src/udi/__tests__/udi.service.test.ts` | 10 | 扫码复核（字段级不符/strict/码不合规）、批量部分成功、模板包自洽（坐标不越界/变量已声明/gs1 必开） |

回归基线：`pnpm typecheck` 零错误；`pnpm test` **732 例 / 725 通过 / 0 失败 / 7 跳过**（U1 前为 691/684/0/7，净增 41 例）。

## 4. 明确不做 / 不承诺（写进销售口径）

1. **不做 ISO/IEC 15415 打印质量等级判定**：需 RJS 等硬件验证仪，系统只保证"解码可读 + 内容合规"。
2. **国家 UDI 直连需要客户自己拿到接口授权**：UDID 系统要求申报方先提交《对接申请表》并审核通过，官方邮件下发凭据；没有凭据时 `mode=api` 明确返回 `NOT_CONFIGURED`，绝不假成功（详见 §8）。**EUDAMED / GUDID 没有开放自助 API**，只提供文件生成（EUDAMED XML / GUDID HL7 SPL 骨架）后人工上传。
3. **不宣称真机兼容**：位图通道（bwip + zxing）已验证可解码；ZPL/TSPL 指令通道现已补齐 GS1 内容转码（见 §4.1），但**仍未上真机打印验收**。
4. **不含医院端临床扫码核验**：另一条产品线，不在本套件范围。


### 4.1 ZPL 通道的 GS1 DataMatrix 转码（2026-11-26 修复）

**缺陷**：`qrcode` 元素在处理时是 `esc(q.content)` 直接进 `^FD`。模板里写的是 HRI `(01){{gtin}}(17){{expiry}}(10){{lot}}`，渲染后带括号进指令，打印机把括号当普通字符编码——扫出来是字面 `(01)0690…`，**不是合法 GS1 元素串**，医院端/国家平台无法按 AI 解析。`encodeGs1`/`gs1ToProtocol` 早就存在，但只接在 GS1-128 的一维分支，`^BX` 分支没接。

**修复**（`backend/core/zpl-generator.ts: zpl2DContent`）：

| 条件 | 行为 |
|---|---|
| `q.gs1 === true` 且内容以 `(AI)` 开头 | `encodeGs1` 剥离括号 → 变长 AI 间插 `\u001D` → `gs1ToProtocol(...,'zpl')` → `>8`，并在最前加 `>8` 前导（标识 GS1 符号） |
| 非 GS1 / 内容不像 HRI | 原样输出，不误改普通码 |
| AI 非法、定长位数不符、字符集错 | 保留原内容输出 + `[ZPL] DataMatrix GS1 数据存疑` 告警（不静默） |

与 TSPL 侧 `tspl2DContent`（`~1` 口径）一致。UDI 单件模板实测输出：

```
^FO28,134^BXN,189,4,200^FD>801069012345001721727123110LOT-R1>821SN0001^FS
```

（`01` 后 14 位定长直连、`17` 直连、`(10)LOT-R1` 变长后 `>8`、`(21)SN0001` 收尾）

**验证**：`backend/core/__tests__/zpl-gs1-datamatrix.test.ts` 6 例（前导/分隔位置、全定长无冗余分隔、非 GS1 原样、gs1 未开不转码、非法数据告警、`^` 经 `^FH` 转义不截断）；`core/__tests__` 全量 138 例通过，`src/print`+`src/udi` 264 例通过，`tsc --noEmit` 零错误。

**仍未验收**：真实 Zebra 设备打样 + 扫码枪/影像式读码器读回比对（需要硬件）。在此之前 ZPL 直连通道对外只能描述为"已修转码、待真机验收"。

### 4.2 另一处已知缺口：image 通道不出真码

`backend/printer/printer-provider.interface.ts` 的 `ImageProvider` 在未安装 `canvas`（当前仓库 `node_modules` 里确实没有）时回退为**白底占位 PNG**，代码注释也写着"条码/二维码实际应调用 @bwip-js 渲染到 canvas"。也就是说 `image` / `png-base64` 通道目前不能用于交付，UDI 标签只能走 `browser`、矢量 PDF 导出，或先渲染 PNG 再交驱动型打印机。待补：用 bwip 的 PNG 输出直接拼帧（不需要 canvas）。

## 5. 商业化接入（2026-11-24 已接闸）

- 模块 code `udi.compliance`（与 `wms.*` 同构）：`scripts/udi_module_gate.sql` 种 `modules` 一行（`is_core=FALSE`）+ 演示租户 `tenant_modules` trial 授权；**不写入任何 `plan_modules`**，因此没有任何套餐会自动带出 UDI。
- 两个控制器（`udi.controller` / `udi.trace.controller`）已挂 `@RequireModule('udi.compliance')`；`ModuleGuard` 加了中文名映射，未开通返回 `4031` +「当前未开通「医疗 UDI 合规套件」，请联系销售开通」，不暴露 `udi.compliance` 这种 code。
- 菜单「医疗 UDI」整组 + console 路由 `udi-trace` / `udi-compliance` 的 `module` 已改为 `udi.compliance`：未开通租户菜单整组消失，直接敲 URL 会落到 `/blocked?kind=module` 引导页（文案表 `constants/modules.ts` 已补中文名）。
- 授权/收回操作——**运营后台即可完成，不用写 SQL**（`apps/platform` 租户管理）：
  - 签套件 / 给试用：租户列表「加购模块」→ 选「🩺 医疗 UDI 合规套件」→ 来源选 `addon/manual/gift`（正式开通，status=active）或 `trial`（试用，status=trial）→ 确认。依赖模块会自动按同状态补齐。
  - 收回：租户详情抽屉里「停用」，60s 内生效（`ModulesService` 缓存）。
  - `tenant_modules` 无到期字段，试用不会自动失效，到期由运营手动停用（后台弹窗里已写明）。
  - 等价 SQL（批量/脚本场景）：`INSERT INTO tenant_modules (tenant_id, module_code, status, source) VALUES (<tid>, 'udi.compliance', 'active'|'trial', 'purchase'|'trial');`
- 实测（`labelflow_test`）：trial 状态下 `/udi/status` 200、菜单含 udi；把 status 改 `disabled` 后 403/4031 + 中文提示、菜单消失。
- 报价口径不变：套件 ￥28,000–48,000 + 实施 ￥10,000–20,000 + 年费 ￥6,000–12,000（避开 ￥999 价格锚，锚点是"合规闭环"而非"打印软件"）。**不做月度小订阅**——3 万套件卖不动。

## 6. 后续里程碑（按客户签约价值排序）

| 优先级 | 任务 | 说明 | 预估 |
|---|---|---|---|
| P0 | PDA 扫码复核页 | `apps/pda` 已有 scanner 能力，补"复核/入库/发料"页面，直接调 `/udi/scan-verify` | 3–4 天 |
| P0 | 真机适配 3 台 | 斑马 ZD421 / 汉印 / GODEX，逐机型验 DataMatrix 的 FNC1 与等级 | 3–5 天 |
| ~~P0~~ | ~~追溯表与视图~~ | ~~`udi_units` + 层级包装父子码 + 正反向查询~~ → 已完成（`/udi/units`、`/udi/trace/:code`，见 §8） | ✅ |
| ~~P1~~ | ~~合规留痕报表~~ | ~~打印审计链~~ → 已完成（`/udi/report/print-audit` + 「UDI 合规留痕」页） | ✅ |
| ~~P1~~ | ~~导出 CSV/XML~~ | ~~最小销售单元 + 包装层级~~ → 已完成（`/udi/export/units.csv`、`units.file`） | ✅ |
| ~~P1~~ | ~~DI 主数据台账~~ | ~~一物一 DI + 包装层级 + 提交前校验 + 召回 + 申报~~ → 已完成（见 §8） | ✅ |
| P2 | SSCC 层级赋码 | 箱/托 AI 00，与单品 UDI 关联 | 3 天 |

## 7. 风险与诚实说明

- **ZPL/TSPL 的 GS1 语义**：部分机型需 `^BXN` 配合 `>8`/`^FH` 处理 FNC1，各厂商实现不一。当前 UDI 模板走位图/PDF 通道最稳；指令通道必须在真机验证后才对外承诺。
- **日期两位年**：输出 `YYMMDD`，跨世纪语义按 GS1 手册由业务约定，系统不猜测。
- **批号/序列号字符集**：按 GS1 C 字符集校验，含 `(` 会破坏分段必须拒绝（已有单测）。
- **模板包不是印刷稿**：尺寸/字号按常见规格给，落地时按客户标签纸与法规（如器械标签最小字号）微调。

## 8. 合规闭环（P3，2026-11-24 落地）

> 目标：把「打印得对」升级成「台账全、能自证、出问题查得清、能报上去」。
> 代码：`backend/src/udi/udi.compliance.service.ts` / `udi.nmpa.client.ts` / `udi.compliance.controller.ts`；
> 表：`backend/scripts/udi_p3_compliance.sql`（`udi_di_master`、`udi_submissions`）；
> 前端：`apps/console/src/views/UdiRegistry.vue`（菜单「医疗 UDI → UDI 合规申报」）。

| 能力 | 落点 | 说明 |
|---|---|---|
| DI 主数据台账 | `GET/POST /udi/di`、`DELETE /udi/di/:di`、`GET /udi/di-tree` | 一物一 DI，按 DI upsert（Excel 反复同步不会重复建）；GTIN 校验位不过的行逐行拒绝并回报原因；包装层级 `UNIT/CARTON/PALLET` 用 `parentDi` 串树，有子级时禁止直接删父 |
| 提交前校验 | `POST /udi/validate` | 8 条规则：DI 在台账、GTIN 校验位、产品名称、规格或型号至少一个、注册证号、分类目录且格式 `XX-XX-XX`、发码机构 ∈ GS1/HIBCC/ICCBBA、包装层级与上级一致性 + 挂父必须填内含数量；`error` 阻断、`warn` 提示 |
| 召回范围分析 | `GET /udi/recall`、`GET /udi/recall/export` | 按 `gtin/lot/serial/sscc` + 时间窗反查命中单品、所在包装、以及 `RECEIPT/ISSUE/SHIPMENT` 下游单据（"发给谁、多少件"）；导出 CSV 给质量部门归档 |
| 申报通道 | `POST /udi/submissions`、`GET /udi/submissions`、`GET /udi/submissions/:id` | `mode=validate` 只校验、`mode=file` 生成报文、`mode=api` 真直传；每次尝试都落 `udi_submissions`（含 dis、校验问题、报文、远端返回码、次数、时间），飞检可自证 |
| NMPA 直连 | `NmpaUdidClient`（`GET /udi/nmpa/probe`） | 按《业务申报API标准文档》实现 P001 `/connection/test`、P002 `/token/get`、M001 `/company/identifier/save`、M002 `/company/identifier/submit`；token 缓存到当日 24:00；接口导入的数据在对方系统是**草稿**，需再提交 |

### 8.1 直连的真实前提（写进实施交底）

1. 客户以申报人身份在 UDID 系统提交《对接申请表》并盖公章 → 官方审核 → **邮件下发接口凭据**。
2. 凭据落到环境变量：`UDID_APP_KEY` / `UDID_APP_SECRET`，环境用 `UDID_ENV=prod|beta`（默认 beta）。
3. 没有凭据时：`probe` 仍可探连通性；`mode=api` 一律返回 `NOT_CONFIGURED`，**不会**产生"看起来提交成功"的记录。
4. 本沙箱实测 `probe` 返回：`405` + 对方网关页面 → 说明当前网络链路到 `udid.nmpa.gov.cn` 被 CDN/WAF 拦截（`configured=false`）；现场交付需在客户内网/专线复测，这条不是代码问题。

### 8.2 验证证据（2026-11-24，`labelflow_test`）

```text
GET  /udi/di            → {total:0,items:[]}
POST /udi/di (4 行)     → saved 3, rejected 1
                          "GTIN 模 10 校验位错误：应为 9，实际 1（完整 GTIN-14 应为 1000000000009）"
GET  /udi/di-tree       → UNIT 与 PALLET 为根，CARTON 挂在 PALLET 下（depth 1）
POST /udi/validate      → 补 spec 前：PALLET 报 "规格与型号至少要填一个"；补后 ok=true（只剩 1 条 warn）
GET  /udi/recall?lot=L1 → units 0 / downstream []（无数据时结构完整）
POST /udi/submissions 4 次 → validate=validated、EUDAMED/file=generated、
                          EUDAMED/api=failed(NO_API)、NMPA/api=failed(NOT_CONFIGURED)
GET  /udi/submissions   → 4 条记录，id 倒序，字段齐全
```

单测：`src/udi/__tests__/udi.compliance.service.test.ts` **16 例**（内存仓库替身，不连库）覆盖 upsert/逐行拒绝/层级树/删父保护/8 条校验规则/召回聚合与 CSV/四种申报状态/非法入参。
回归：`pnpm test` **922 例 / 915 通过 / 0 失败 / 7 跳过**（本轮净增 16）；`tsc --noEmit`、`vue-tsc`、`vite build` 全绿。

### 8.3 顺手修掉的导出缺陷

后端所有响应被 `ResponseInterceptor` 包成 `{code,data}`，浏览器直接打开 `.csv` 链接只会看到一段 JSON。新增 `downloadCsvUrl()`（`apps/console/src/api/index.ts`）：fetch 出 `data` 文本再生成 Blob 下载（带 UTF-8 BOM，Excel 中文不乱码），已替换「留痕报表」「单台账」「召回清单」三个导出按钮。

## 9. RFID / EPC（暂不开发，已存档）

系统当前**只有 RFID 的 EPC 数据层**（SGTIN-96 编解码 + 写作业信封 + 写后读回判定，`backend/src/hardware/epc.calc.ts`，
端点 `POST /hardware/rfid/encode|write-job|verify-read`），**没有**前端界面、没有读写器驱动（LLRP / 厂商 SDK）、
真机零验收，因此不能对外说"支持 RFID 标签"。

与 UDI 套件的接线点：EPC 的 CompanyPrefix + ItemReference 就是 GTIN，和 `udi_di_master.di` 同源，
打通后同一个 DI 可同时出条码与 RFID 双载体、共用一套追溯流水。四阶段方案与验收清单见
[docs/33-rfid-epc-plan.md](33-rfid-epc-plan.md)。
