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
| POST | `/udi/pack-print` | **主从层级打印**：一箱 N 件，出 N 张单件标 + 1 张箱标，编号与装箱关系同事务写入台账 |
| GET | `/templates/:id/print-form` | **打印时表单**：模板里 `atPrint=true` 的变量→表单字段定义（label/必填/类型/校验） |
| GET | `/udi/pack-print/meta` | 表单元信息：上限件数、公司前缀、单件模板 `unitTemplates` / 箱级模板 `cartonTemplates` / 全部模板 |

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

### 4.3 主从层级打印（2026-11-28 新增，P0-1）

商业条码软件里这条叫「主从/层级打印」（master-detail）：操作员填一次 DI + 批号 + 有效期 + 件数，系统自动生成 N 个不同序列号的单件码、一个箱码 SSCC，并把"N 件在这一箱里"的关系同时落到台账与打印任务里，避免手工扫 N 次录 N 次。

| 环节 | 行为 |
|---|---|
| 入参 | `gtin / lot / expiry / production / qty / serial{mode:auto\|list} / sscc / unitTemplateCode / cartonTemplateCode / printerId / copiesUnit / copiesCarton / fieldMap.extra / dryRun / register` |
| 序列号 | `auto`：起始号 + 补零 + 件数，按尾号递增；**溢出（从 9999 起 3 件）直接拒，不静默进位**；`list`：逐行给号，重复号拦截（`MAX_UNIT_QTY=500`） |
| 箱码 | 手给则校验 SSCC 校验位；不填则按库内同前缀最大流水 +1 生成，返回 `ssccAuto` |
| 台账 | 先 `upsertPackages` 建箱，再逐件 `registerUnits` 挂 `packageSscc`；**任一登记失败即中止，不下发打印任务**，不出现"打了标签但台账没有" |
| 打印 | `print.createJob` 起两个任务（单件 N 份 / 箱标 1 份），`requirePrinter:true`，无打印机直接 400 |
| 模板自检 | 模板引用但本次没给的变量（`productName`/`spec`/`manufacturer`…）进 `warnings`，用 `fieldMap.extra` 补齐 |
| 试算 | `dryRun:true` 只算号段与 SSCC、不写库不打印，界面先看号段再下单 |

前端入口：console「医疗 UDI → UDI 批次赋码打印」（`/udi-pack-print`，模块门 `udi.compliance`）。表单默认选中第一张**单件**模板与第一张**箱级**模板；meta 已把箱标（`UDI_CARTON_*`、`*CARTON*`）从单件下拉里剔除，防止把 100×70 箱标当 50×30 单件打。

**真机验证（2026-11-28，Windows 本机 API + PG，image 通道）**：建 image 打印机 → 6 件 `dryRun` 号段 `SN1001~SN1006` + SSCC `069012340000000016`、`warnings:[]` → 正式提交 `registered{created:6,existed:0,failed:0}`、单件任务 `success total=6`、箱标任务 `success total=1`、`GET /udi/packages/:sscc` 返回 6 件子项；验证后已清理（templates 保留 1/2/8/9，units 仅剩历史批，packages/jobs/printers 归零）。

单测：`src/udi/__tests__/udi.batchprint.calc.test.ts` 16 例（起号/补零/溢出/清单查重/箱标行/SSCC 流水与校验位/上限）。

**仍未验收**：真打印机出纸（本机 printers 为空，需现场配机）；箱标模板 `UDI_CARTON_V1` 的 HRI 仍缺 `(00)` 明文与单件 HRI 缺 `(11)` 生产日期（模板内容问题，不影响扫码解析）。

### 4.4 打印时表单（2026-11-28 新增，P0-2）

问题：UDI 单件标的批号、有效期、序列号是**每次打印才确定**的，过去只能在打印页的「数据行」里手填 JSON/表格，车间操作员用不了。

定稿口径：**字段定义只有一份**——模板 `content.variables` 里标了 `atPrint: true` 的变量就是「打印时录入」字段，复用既有的 `required / label / validation / regex / defaultValue`。后端算字段、后端做校验、前端照后端结果渲染表单，避免前后端两套口径漂移。

| 环节 | 行为 |
|---|---|
| 取字段 | `GET /templates/:id/print-form` → `{templateId, templateName, hasForm, fields:[{name,label,type,required,defaultValue?,validation?,regex?,maxLength?}]}`；`expr` 计算变量不取 |
| 校验 | `POST /print/jobs` 带 `formValues`：先校验当场填的值（必填/数字/整数/日期/长度/正则），再并入每行，最后逐行兜底校验；不通过 400，`fields[]` 点名哪个字段、第几行 |
| 合并 | 表单值优先并入行，空值不覆盖行里已有值，`defaultValue` 兜底；`POST /print/preview`、`POST /print/commands` 同样并入（预览所见即所得） |
| 放行 | pack-print / WMS 自动打印由数据行给值，不会被打印表单挡住（校验口径一致） |
| 模板正则 | 模板里的正则写坏时报「模板里的正则无效，请回设计器改」，不让操作员看到正则源码 |

前端：设计器「变量」面板每个变量有「打印时录入」勾选（`expr` 变量给"不生效"提示）；打印页按 type 渲染 date-picker / input-number / input，必填红星、正则「规则」角标、字段级错误、`沿用上次` / `记住本次填写`（localStorage）。

内置 UDI 模板已标 atPrint 并补中文 label：单件 `有效期 (YYMMDD) / 批号 / 序列号（留空=不带 21）`，箱标 `有效期 / 批号 / SSCC 箱码`。

**真机验证（2026-11-28，Windows 本机 API + PG，image 通道）**：`GET /templates/8/print-form` 返回三字段（`expiry` 正则 `^\d{6}$`、`lot` 最长 20、`serial` 选填）；必填齐 + 序列号留空 → 任务 `success done=1`；三字段全填 → `success`；完全不填 → 400 `标签必填字段缺失或不合法：有效期 (YYMMDD)（expiry）：必填，整批都没有值；批号（lot）…`；`expiry='2027-10-31'` → 400 点名格式不合规；预览接口返回的渲染结果里能查到填入的 `271031 / PF2601 / SN9002`。

单测：`src/print/__tests__/print-form.calc.test.ts` 14 例（字段提取/对象式与字符串式 validation/必填/数字/日期/长度/正则/逐行兜底/合并优先级/错误文案）。

### 4.5 空值 AI 段剔除（2026-11-28 修复，真机暴露）

模板里把 `(21){{serial}}` 写死时，操作员不填序列号 → 下发内容成了 `…(21)`，bwip 抛 `GS1valueTooShort` 让**整单打印失败**，故障点还落在打印环节而不是录入环节。

修法：渲染第三遍对 GS1 码内容与 HRI 文本剔除「后面没有值」的 AI 段（`core/gs1-ai.ts` 的 `stripEmptyGs1Ais`），码与 HRI 同步改，保证"码里有什么、人眼读什么"。只处理 HRI 形态（至少两段 `(AI)`）的文本，避免误伤普通标签文字；纯数据流原样返回。

真机验证：单件模板 8 序列号留空 → 任务 `success done=1`（修复前 `failed`，日志 `[DATAMATRIX] 编码失败：bwipp.GS1valueTooShort#3842: AI 01: Too short` 后续空 AI 段）。

单测：`core/__tests__/gs1-ai.test.ts` 2 例 + `core/__tests__/render.test.ts` 1 例（条码与 HRI 同步剔除、填了值则保留）。全量 `print / udi / template / gs1-ai / render` 327 例通过。
