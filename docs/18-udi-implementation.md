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
4. **不含终端使用环节的扫码核验**：另属耗材使用侧产品线，不在本套件范围。


### 4.1 ZPL 通道的 GS1 DataMatrix 转码（2026-11-26 修复）

**缺陷**：`qrcode` 元素在处理时是 `esc(q.content)` 直接进 `^FD`。模板里写的是 HRI `(01){{gtin}}(17){{expiry}}(10){{lot}}`，渲染后带括号进指令，打印机把括号当普通字符编码——扫出来是字面 `(01)0690…`，**不是合法 GS1 元素串**，使用端/国家平台无法按 AI 解析。`encodeGs1`/`gs1ToProtocol` 早就存在，但只接在 GS1-128 的一维分支，`^BX` 分支没接。

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

### 4.2 image / png-base64 通道：改为真出图（2026-11-26 修复）

**原缺陷**：`ImageProvider` 优先 `node-canvas`，仓库里没装就回退**白底占位 PNG**；`print.processor` 在图型式协议下 `payload` 还是 `undefined`，连原始元素都没传下来。结果：驱动型打印机打出来是空白纸，而且状态记成功。

**修复**：

| 层 | 改动 |
|---|---|
| 新文件 `src/print/label-png.ts` | `renderLabelPng({elements,widthMm,heightMm,dpi})`：已渲染元素 → `renderLabelSvg`（条码/二维码内联 bwip 矢量路径）→ `sharp` 栅格化到目标 dpi，尺寸 `mm*dpi/25.4` 四舍五入 |
| `printer/printer-provider.interface.ts` | `ImageProvider` 改为用 `frame.elements` 走栅格化；**没有元素时返回 `ok:false`**，不再回退白底；栅格化异常也 `ok:false` 并把原因带出 |
| `src/print/print.processor.ts` | `payload` 恒带 `elements`（zpl/tspl 时另加指令），图型式通道不再收空帧 |
| `src/hardware/hardware.service.ts` | `toJobSource` 改 async：协议非 zpl/tspl 时把元素栅格化成 `pngBase64` 下发代理（代理端 `SpoolerPrinter` 支持 `png-base64`）；拿不到元素则跳过该帧而不是发空 ZPL |

**为什么不用 canvas**：客户机不必装原生依赖；矢量转位图边缘更锐利，203/300/600dpi 都可用。sharp（libvips）已在依赖里，SVG 栅格化由它完成。

**实测产物**（50×30mm @300dpi → 591×354px）：中文标题、规格、GS1 DataMatrix、HRI 四行、生产企业全部正常；zxing 解码得到 `(01)06901234500172…LOT-R1…SN0001`。

**验证**：`src/print/__tests__/label-png.test.ts` 6 例（尺寸精确、非空白、**回环可解码**、ImageProvider 出真码、缺元素显式失败、尺寸/DPI 非法抛错）；`src/print` + `src/hardware` 全量 161 例通过；`tsc --noEmit` 零错误。

**仍未验收**：真实打印机打一张（硬件）。系统字体缺失时中文会退化为方块（warnings 会提示），客户机需装中文字体。
