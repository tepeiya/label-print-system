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
2. **不自动上报国家 UDI 数据库**：先做标准导出（P1），接口按客户/发码机构确认后再谈。
3. **不宣称真机兼容**：当前只验证了位图通道（bwip + zxing）。ZPL/TSPL 指令通道对 GS1 DataMatrix 的 FNC1 处理需逐机型验收（见 §6）。
4. **不含医院端临床扫码核验**：另一条产品线，不在本套件范围。

## 5. 商业化接入（下一步）

- 模块 code 建议 `udi.compliance`（与 `wms.*` 同构）：`modules` 种一行 + `tenant_modules` 按租户开通，控制器加 `@RequireModule('udi.compliance')`。当前**故意未挂**，避免未开通租户被误拦；正式售卖前加。
- 报价口径：套件 ￥28,000–48,000 + 实施 ￥10,000–20,000 + 年费 ￥6,000–12,000（避开 ￥999 价格锚，锚点是"合规闭环"而非"打印软件"）。

## 6. 后续里程碑（按客户签约价值排序）

| 优先级 | 任务 | 说明 | 预估 |
|---|---|---|---|
| P0 | PDA 扫码复核页 | `apps/pda` 已有 scanner 能力，补"复核/入库/发料"页面，直接调 `/udi/scan-verify` | 3–4 天 |
| P0 | 真机适配 3 台 | 斑马 ZD421 / 汉印 / GODEX，逐机型验 DataMatrix 的 FNC1 与等级 | 3–5 天 |
| P0 | 追溯表与视图 | `udi_units`（单品键）+ 层级包装父子码 + 入库/发料/出库正反向查询 | 5–7 天 |
| P1 | 合规留痕报表 | 打印审计链（谁打/何时/模板版本/重打次数），飞检取证用 | 2–3 天 |
| P1 | 导出 CSV/XML | 最小销售单元 + 包装层级 + 医保耗材代码字段 | 2–3 天 |
| P2 | SSCC 层级赋码 | 箱/托 AI 00，与单品 UDI 关联 | 3 天 |

## 7. 风险与诚实说明

- **ZPL/TSPL 的 GS1 语义**：部分机型需 `^BXN` 配合 `>8`/`^FH` 处理 FNC1，各厂商实现不一。当前 UDI 模板走位图/PDF 通道最稳；指令通道必须在真机验证后才对外承诺。
- **日期两位年**：输出 `YYMMDD`，跨世纪语义按 GS1 手册由业务约定，系统不猜测。
- **批号/序列号字符集**：按 GS1 C 字符集校验，含 `(` 会破坏分段必须拒绝（已有单测）。
- **模板包不是印刷稿**：尺寸/字号按常见规格给，落地时按客户标签纸与法规（如器械标签最小字号）微调。
