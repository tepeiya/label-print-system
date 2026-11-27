# RFID / EPC 赋码：现状盘点与后续开发方案（暂不开发，先存档）

> **状态**：2026-11-24 文档冻结，**代码零改动**。本文只做两件事：(1) 把"现在到底支持到什么程度"钉死；
> (2) 把将来要做的事拆成可开工的四个阶段，避免下次重启讨论又从零开始。
> **对外口径（一句话）**：RFID 的**数据层**已具备，**硬件通道未实现、未验收**，不得对外承诺"支持 RFID 标签"。

---

## 1. 现状盘点（逐项对照代码，不是印象）

### 1.1 已具备（可跑、有单测）

| 能力 | 落点 | 说明 |
| --- | --- | --- |
| SGTIN-96 编码 | `backend/src/hardware/epc.calc.ts: encodeSgtin96` | GS1 EPC TDS 1.x：96 bit / 24 位十六进制、Header `0x30`、7 档 Partition 的 CompanyPrefix/ItemReference 位数切分（位数和恒 44、数字位恒 13）、模 10 校验位复用 `core/checksum`；**序列号必须是 0 ~ 2^38-1 的整数**（字母序列号属 SGTIN-198，当前不支持） |
| SGTIN-96 解码 | `epc.calc.ts: decodeSgtin96` | 反解回 GTIN-14 / 公司前缀 / 序列号，编码—解码往返有单测 |
| 写操作信封 | `epc.calc.ts: rfidWriteJob` | 厂商中立作业：`epcHex` 归一化 + 作业唯一键，超时 `RFID_WRITE_TIMEOUT_MS=3000`、重试 `RFID_MAX_RETRIES=2` |
| 写后读回判定 | `epc.calc.ts: verifyEpcWrite` | 读回值归一化后必须与期望 EPC 完全一致才 `verified`；不一致判失败 |
| 防重写 | `epc.calc.ts: epcDedupeVerdict` | 同一 EPC 重复写入的拦截判定 |
| HTTP 端点（3 个） | `backend/src/hardware/hardware.module.ts` | `POST /hardware/rfid/encode`（纯计算，不需要设备）、`POST /hardware/rfid/write-job`、`POST /hardware/rfid/verify-read`（均需 hardware 写权限） |
| 写入留痕表 | `backend/scripts/saas_p8_hardware.sql` | `hardware_rfid_logs`（带 `tenant_id` + RLS 兜底） |
| 单测 | `hardware/__tests__/epc.calc.test.ts` 9 例；`hardware/__tests__/agent-protocol.calc.test.ts` 等合计 26 例 | EPC 位布局往返、写后读回、脱敏信封等 |

### 1.2 不具备（这就是"不能真写标签"的原因）

1. **前端零界面**：`apps/console` 里没有任何 RFID 入口（grep `rfid|epc` 无命中），用户点不到"写标签"。
2. **没有读写器驱动**：`epc.calc.ts` 文件头已写明——本文件只做"可纯函数验证的两头"（编码 + 写后判定），中间"真发指令给读写器"必须由本地代理 + 真机完成；代理侧目前**没有** LLRP / 厂商 SDK / 串口指令任何实现。
3. **没有本地代理客户端可执行文件**：`docs/10 §10.30.2` 明确"只有服务端协议与 API 契约"。
4. **编码族只有 SGTIN-96**：SSCC-96（箱/托）、GRAI-96（可回收资产）、GIAI-96、DOD-96 未实现。
5. **真机零验收**：`docs/10 §10.30` 标题下即写"真机未验收，禁止承诺可用"。

### 1.3 一句话结论

```text
能做：给定 GTIN + 序列号 → 算出合法 EPC（SGTIN-96）、生成写作业、判断读回对不对、留痕。
不能做：把 EPC 真正写进一张 UHF 标签、写不进去时自动重试、写完扫一遍自动判定（这些都要读写器）。
```

---

## 2. 与 UDI 台账的接线点（这是本系统最值钱的地方）

EPC 的 `CompanyPrefix + ItemReference` 本质就是 **GTIN**，而 UDI 台账（`udi_di_master.di`）存的就是 GTIN-14。
现在 `POST /hardware/rfid/encode` 是**手工传 gtin + serial** 的，与台账没打通。

打通后能得到的形态：**同一个 DI，条码（GS1 DataMatrix）和 RFID（SGTIN-96）双载体，同一套主数据、同一套追溯流水**。

具体三处小改（都属于将来阶段二）：

- 新增 `POST /hardware/rfid/encode-from-di`：入参 `{ di, serial }`，从 `udi_di_master` 取 GTIN/公司前缀，缺 DI 直接报错（不猜前缀）。
- 写作业落 `udi_units`：写成功的单品直接进 UDI 追溯（`udiKey` 与条码侧同键），召回分析自动覆盖 RFID 载体的件。
- 台账校验加一条：`is_rfid` 标记的 DI 必须有合法公司前缀位数（6–12）才能参与 EPC 编码。

---

## 3. 后续开发方案（四阶段，按依赖排序）

> 每个阶段都写明**验收标准**，避免"代码写完就算完"。前一阶段不绿不进下一阶段。

### 阶段一：前端赋码页（不依赖硬件，可独立上线）

| 项 | 内容 |
| --- | --- |
| 做什么 | `apps/console` 新增「RFID 赋码」页（或并入 UDI 合规申报页第五个 tab）：选 DI → 填序列号区间/数量 → 预览 EPC（24 hex）+ 人读 HRI → 导出清单 |
| 依赖 | 只用现成的 `/hardware/rfid/encode`，零硬件 |
| 验收 | 输入合法 GTIN 得到 24 hex 且解码回原值；校验位错/公司前缀越界给出明确中文原因；预览与导出条目一致 |

### 阶段二：台账打通 + 写作业闭环（仍不依赖真机）

| 项 | 内容 |
| --- | --- |
| 做什么 | 上面 §2 的三处改动；写作业入 `hardware_agent_jobs`，回执走 `verify-read` 落 `hardware_rfid_logs` |
| 依赖 | 现有代理协议（`agent-protocol.calc.ts` 信封/回执状态机已就绪） |
| 验收 | 建 DI → 生成 N 条 EPC → 作业入队幂等（同 jobKey 不重复）→ 模拟回执（一致/不一致两种）分别落 `verified=true/false` 并有留痕 |

### 阶段三：本地代理接真读写器（唯一的硬门槛）

| 项 | 内容 |
| --- | --- |
| 做什么 | 在 Windows 本地代理里实现读写器通道：首选 **LLRP 1.1**（Impinj / Zebra 等主流 UHF 固定式与手持式支持），非 LLRP 机型再按厂商 SDK 补；实现 `Select → Write EPC bank → Read back → 比对` |
| 关键约束 | 写前必须 Select 到目标标签（防错写隔壁）；写失败按 `RFID_MAX_RETRIES` 重试；**读回不一致必须判失败并留痕**，不允许"写了就算成功" |
| 验收 | 一台真读写器 + 一叠真标签：写 100 张，读回 100% 一致；故意写错一次能看到 `verified=false` 与拒绝重试；拔网线/拔读写器的失败态有明确回执 |

### 阶段四：真机验收清单（出证据才算交付）

- [ ] 读写器型号 / 固件版本 / 天线功率 / 标签型号（inlay）归档
- [ ] 写后读回成功率（100 张）与失败原因分类
- [ ] 与条码同码一致性：同一 DI 的 DataMatrix 与 EPC 扫出来是同一件
- [ ] 召回演练：按批号查出「条码件 + RFID 件」的合并影响面
- [ ] `docs/10 §10.30.3` 原有硬件验收清单里 RFID 相关项逐项打勾

---

## 4. 选型与合规注意

- **标签**：UHF Gen2（ISO 18000-63）被动标签；医疗器械小规格件注意 inlay 尺寸与读距，金属器械需抗金属标签。
- **读写器**：优先 LLRP 机型（一家实现吃多品牌），避免一开始做四五套厂商 SDK。
- **编码族**：单品用 SGTIN-96；箱/托若要与 UDI 的 CARTON/PALLET 层级对应，需补 **SSCC-96**（当前未实现，属阶段三之后）。
- **序列号口径**：SGTIN-96 的 serial 是 38 位整数，客户若用字母/混合序列号（如 `SN0001`），只能走 SGTIN-198 或由系统内部把业务序列号映射成整数后回写对照表——**上线前必须先对齐这一点**，否则会出现"标签写的号和条码上的号不是一回事"。
- **数据交换**：若客户要求与渠道/终端客户做 EPCIS 事件交换（ shipping / receiving 事件），当前系统**不支持** EPCIS，需另立里程碑（不在本文范围）。
- **合规**：RFID 写入失败属"标签作废"，必须留痕且不可回滚成"成功"，这条与打印留痕同口径。

---

## 5. 明确不做 / 不承诺（沿用并强化 docs/10 §10.30 口径）

1. 不承诺"支持 RFID 标签"——只说"RFID 数据层已具备，硬件通道待验收"。
2. 不做任何"沙盒里假装写入成功"的实现；无读写器时端点只生成作业、不产生 `verified=true`。
3. 不做 EPCIS 事件交换、不做 NFC（13.56MHz）——当前只规划 UHF Gen2 的 SGTIN-96。
4. 报价口径：RFID 属硬件集成项，按读写器 + 标签 + 现场调试单独计价，不并入 UDI 套件年费。

---

## 6. 复跑命令（想验证"现状"时用，不需要硬件）

```bash
cd backend
node --import tsx --test src/hardware/__tests__/epc.calc.test.ts     # 9 例，EPC 编解码与写后判定
```

实测（2026-11-24，`labelflow_test`，租户 admin，无需读写器）：

```bash
curl -X POST http://127.0.0.1:3202/api/v1/hardware/rfid/encode \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"gtin":"10000000000007","serial":1001,"companyPrefixLen":7}'
# → {"data":{"epcHex":"301400000061A800000003E9",
#           "tagUri":"urn:epc:tag:sgtin-96:0.0000000.100000.1001",
#           "decoded":{"partition":5,"companyPrefix":"0000000","itemReference":"100000",
#                      "serial":"1001","gtin":"10000000000007"}}}
# 编—解往返一致；serial 传 "SN0001" 会返回 400「serial 必须是整数」
```

> 注：`/hardware/rfid/encode` 只需租户 token + hardware 写权限，**不需要**读写器或代理在线。
