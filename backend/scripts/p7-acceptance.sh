#!/usr/bin/env bash
# =============================================================================
# p7-acceptance.sh —— P7 条码链路的端到端验收（docs/05 §8.3「生成器绝不静默换码制」）
#
# 段次：
#   A 类型与单测 —— tsc + npm test 的真实数字（tests/pass/fail/skipped 逐条报出）
#   B golden 快照校验 —— 默认模式（只读）必须绿；顺带验「默认模式不许写盘」
#   C 真实点阵往返 —— raster.ts 出点阵 → 十六进制 → 独立重建位图 → 解码器扫回原文
#     （这一段的目的是：位图通道的字节真的是「能扫的图」，而不只是「长度对得上」）
#     C.7 另测「bwip 奇数点阵 → 自动上调一档 → 如实 warning」；C.8 用真图尺寸复核
#     ^GFA / BITMAP / GW 三种下发头的字节口径（golden 里的 24×12 合成图太小，测不出这类错位）
#   D /print/commands 三协议冒烟 —— 真后端在线时跑；不在线整段 SKIP（见下）
#
# 前提：
#   1) 依赖已装：backend/ 下 npm ci 完成（tsx、typescript、@bwip-js/node、sharp 都是既有依赖，
#      本脚本不新增任何依赖）。
#   2) C 段需要 Python 侧解码器（沙箱实测口径，别再自行试探）：
#        - 必须：python3 -c "import cv2"（OpenCV 5.0.0，QRCodeDetector；缺 → 整段 C SKIP）
#          cv2.QRCodeDetector **只解普通 QR**，遇到 GS1 QR 会抛「mode 5 … not implemented」，
#          所以 C.4 只对普通 QR 判字节等值，GS1 一律交给 zxingcpp。
#        - 强烈建议：python3 -c "import zxingcpp"（pip install zxing-cpp）
#          DataMatrix / QR / PDF417 / GS1 变体全认，且带 AIM 标识符（]d1/]d2/]Q1/]Q3）——
#          **唯一**能验 GS1 DataMatrix 语义的工具；缺 → 这些子项 SKIP（不降级成「结构看起来对」的假绿）。
#        - pyzbar（apt-get install libzbar0）能 import，但这个 build 的 ZBarSymbol 里
#          **没有 DMTX**（实测只有 DATABAR/DATABAR_EXP），验不了 DataMatrix；
#          因此本脚本不把 pyzbar 写进判定链，只在需要时作为 QR/PDF417 的第二意见。
#        - ⚠️ 透明底陷阱：bwip-js 出的 PNG 是 RGBA，白底 alpha=0。PIL 直接 convert('L')
#          会把透明读成全黑（np.unique 只剩 [0]），zxing / pyzbar 一律返回 NONE，
#          看起来像"码制坏了"，其实坏的是合成方式。解码前必须 flatten 到白底
#          （raster.ts 用 sharp .flatten({background:'#ffffff'})；C.9 把这条陷阱本身钉成断言）。
#   3) D 段需要后端在跑，且 /print/commands 受全局 JWT 守卫：
#        npx tsc -p tsconfig.json && node -r reflect-metadata dist/src/main.js
#      默认租户 admin/admin123 可登录（首次启动由 main.ts 种子写入）。
#
# 用法：
#   bash backend/scripts/p7-acceptance.sh
#   BACKEND=/path/to/backend bash backend/scripts/p7-acceptance.sh
#   BASE=http://127.0.0.1:3200/api/v1 bash backend/scripts/p7-acceptance.sh   # D 段
#   KEEP_TMP=1 bash backend/scripts/p7-acceptance.sh                          # 保留 $TMPD 里的 PNG/hex
#
# 退出码：0 = 无 FAIL（SKIP 不计失败）；1 = 有 FAIL。
# 本脚本只读仓库内容，所有中间产物写在 mktemp 目录里，跑完即删。
# =============================================================================
set -uo pipefail

BACKEND="${BACKEND:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BASE="${BASE:-http://127.0.0.1:3200/api/v1}"
MIN_TESTS="${MIN_TESTS:-249}"          # brief 的下界：本阶段前基线 249，只准涨不准跌
DPI="${DPI:-203}"

pass=0; fail=0; skip=0
# 分节计数：SECT 是当前段名，P/F/S 各段独立累计，最后按段汇报（只看总数会掩盖「某段全 SKIP」）
declare -A P=() F=() S=() SEEN=()
ORDER=()
SECT="0 前置"
ok()   { pass=$((pass+1)); P[$SECT]=$(( ${P[$SECT]:-0} + 1 )); printf '  [OK]   %s\n' "$1"; }
no()   { fail=$((fail+1)); F[$SECT]=$(( ${F[$SECT]:-0} + 1 )); printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; }
sk()   { skip=$((skip+1)); S[$SECT]=$(( ${S[$SECT]:-0} + 1 )); printf '  [SKIP] %s\n     %s\n' "$1" "${2:-}"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1" "期望「$3」实际「$2」"; fi; }
sect() { SECT="$1"; if [[ -z "${SEEN[$SECT]:-}" ]]; then SEEN[$SECT]=1; ORDER+=("$SECT"); fi; printf '\n---- %s\n' "$1"; }

TMPD=$(mktemp -d)
trap '[[ -n "${KEEP_TMP:-}" ]] || rm -rf "$TMPD"' EXIT
[[ -n "${KEEP_TMP:-}" ]] && printf '临时目录（保留）：%s\n' "$TMPD"

cd "$BACKEND" || { echo "backend 目录不存在：$BACKEND"; exit 1; }

echo "== P7 验收  BACKEND=$BACKEND  BASE=$BASE  node=$(node -v 2>/dev/null)  dpi=$DPI"
sect "0. 前置"
if [[ ! -f package.json ]]; then no "0.1 工作目录含 package.json" "$BACKEND 不对，用 BACKEND= 覆盖"; fi
if [[ ! -d node_modules/tsx || ! -d node_modules/@bwip-js ]]; then
  no "0.2 依赖已安装（tsx / @bwip-js）" "先在 backend/ 跑 npm ci；后面几段会连带失败"; fi

# =============================================================================
# A. 类型 + 单测
# =============================================================================
sect "A. typecheck + npm test（真实数字，不截断）"

# A.1 项目 tsconfig：core/src/printer（测试目录被 tsconfig 排除，所以这条绿不代表测试文件没类型错）
if npx tsc -p tsconfig.json --noEmit > "$TMPD/tsc.log" 2>&1; then
  ok "A.1 npx tsc -p tsconfig.json --noEmit"
else
  no "A.1 npx tsc -p tsconfig.json --noEmit" "$(tail -5 "$TMPD/tsc.log" | tr '\n' ' ')"
fi

# A.2 单独把三个新测试文件 + golden 三件套过一遍 strict tsc（tsconfig 不收 __tests__，这条才是它们的类型门）
if npx tsc --noEmit --strict --target ES2021 --lib ES2021 --module commonjs \
     --moduleResolution node --esModuleInterop --skipLibCheck --resolveJsonModule \
     core/__tests__/gs1.test.ts core/__tests__/geometry.test.ts core/__tests__/golden.test.ts \
     core/__tests__/golden/cases.ts core/__tests__/golden/update.ts > "$TMPD/tsc-tests.log" 2>&1; then
  ok "A.2 strict tsc 覆盖 3 个新单测 + golden 三件套（tsconfig 排除了 __tests__，这条补上）"
else
  no "A.2 strict tsc 覆盖测试文件" "$(tail -8 "$TMPD/tsc-tests.log" | tr '\n' ' ')"
fi

# A.3 全量单测
npm test > "$TMPD/test.log" 2>&1; TEST_RC=$?
t_tests=$(grep -E '^# tests '   "$TMPD/test.log" | tail -1 | awk '{print $3}')
t_pass=$(grep -E '^# pass '     "$TMPD/test.log" | tail -1 | awk '{print $3}')
t_fail=$(grep -E '^# fail '     "$TMPD/test.log" | tail -1 | awk '{print $3}')
t_skip=$(grep -E '^# skipped '  "$TMPD/test.log" | tail -1 | awk '{print $3}')
printf '       # tests %s / # pass %s / # fail %s / # skipped %s\n' \
  "${t_tests:-?}" "${t_pass:-?}" "${t_fail:-?}" "${t_skip:-?}"
if [[ -z "${t_tests:-}" ]]; then
  no "A.3 npm test 汇总行解析" "拿不到 '# tests' 行；日志尾部：$(tail -3 "$TMPD/test.log" | tr '\n' ' ')"
else
  check "A.3a npm test 退出码" "$TEST_RC" "0"
  if [[ "$t_fail" != "0" ]]; then
    no "A.3b 失败用例数 = 0（实为 $t_fail）" "$(grep -E '^not ok' "$TMPD/test.log" | sed 's/^not ok [0-9]* - //' | head -6 | tr '\n' ';')"
    printf '       失败的用例名如上；不是我的三段（B/C）时，先分清是谁在改\n'
  else
    ok "A.3b 失败用例数 = 0"
  fi
  if (( t_tests > MIN_TESTS )); then ok "A.3c 用例总数 $t_tests > 基线 $MIN_TESTS"; else
    no "A.3c 用例总数 $t_tests > 基线 $MIN_TESTS" "用例数下跌说明有人删了测试；MIN_TESTS 可临时下调，但要先问为什么"; fi
  if [[ "${t_skip:-0}" != "0" ]]; then
    printf '       skipped %s 条（TAP 里的 # SKIP 原因）：\n' "$t_skip"
    grep -E '^ok [0-9]+ - .*# SKIP' "$TMPD/test.log" | sed 's/^/         /' | cut -c1-200
  else
    ok "A.3d 没有跳过用例"
  fi
fi

# =============================================================================
# B. golden 快照（默认模式 = 只读校验，CI 用的就是这条）
# =============================================================================
sect "B. golden 快照校验（默认模式，不许写盘）"

snap_before=$(find core/__tests__/golden -name '*.txt' -printf '%p:%T@:%s\n' 2>/dev/null | sort | sha256sum | cut -c1-16)
if npx tsx core/__tests__/golden/update.ts > "$TMPD/golden.log" 2>&1; then
  n=$(grep -oE '[0-9]+ 份' "$TMPD/golden.log" | head -1 | tr -dc '0-9')
  ok "B.1 默认模式校验通过（${n:-?} 份快照与当前实现逐字符一致）"
else
  no "B.1 默认模式校验（$?）" "$(tail -12 "$TMPD/golden.log" | tr '\n' ' ')"
fi
snap_after=$(find core/__tests__/golden -name '*.txt' -printf '%p:%T@:%s\n' 2>/dev/null | sort | sha256sum | cut -c1-16)
check "B.2 默认模式没有写盘（快照 mtime/尺寸指纹不变）" "$snap_after" "$snap_before"
cnt=$(ls core/__tests__/golden/*.txt 2>/dev/null | wc -l | tr -d ' ')
check "B.3 快照份数 = 66（22 码制 × 3 协议）" "$cnt" "66"
if grep -q '孤儿快照\|缺快照' "$TMPD/golden.log" 2>/dev/null; then
  no "B.4 无孤儿/缺失快照" "$(grep -E '孤儿|缺快照' "$TMPD/golden.log" | head -3 | tr '\n' ' ')"
else ok "B.4 无孤儿/缺失快照"; fi
if [[ -f core/__tests__/golden/update.ts ]] && grep -q 'if (UPDATE)' core/__tests__/golden/update.ts; then
  ok "B.5 写盘只挂在 --update 分支（默认模式只读 → CI 才有意义）"
else no "B.5 写盘闸门" "update.ts 里找不到 if (UPDATE)"; fi

# =============================================================================
# C. 真实点阵往返（bwip 出图 → 抽稀打包 → 独立重建 → 解码器扫回）
#    要证的不是「字节数对得上」，而是「打印机收到那串字节还原成图之后，第三方解码器扫得回原文」。
# =============================================================================
sect "C. 真实点阵往返（raster.ts + 解码器）"

if ! python3 -c 'import cv2' > "$TMPD/cv2.log" 2>&1; then
  sk "C.0–C.9 整段跳过" "python3 -c 'import cv2' 失败：$(head -1 "$TMPD/cv2.log" | cut -c1-160)。没有解码器就没法证明「扫得出」，这一节的全部价值都在用外部世界验字节；宁可 SKIP 也不给假绿"
else
  HAS_ZXING=0
  python3 -c 'import zxingcpp' >/dev/null 2>&1 && HAS_ZXING=1
  printf '       解码器：cv2 %s%s\n' \
    "$(python3 -c 'import cv2;print(cv2.__version__)' 2>/dev/null)" \
    "$( [[ $HAS_ZXING == 1 ]] && echo ' + zxingcpp（DataMatrix / PDF417 / GS1 变体）' || echo '（无 zxingcpp：只有 QR 能真解码，DM/PDF417/GS1 子项 SKIP）' )"

  # ---- C.1 驱动：走真实链路出点阵，并复现 raster.ts 内部那张 2× bwip 原图（供逐点对照）
  cat > "$TMPD/gen.ts" <<'GEN_TS'
// 真实链路：bwip-js（按 raster.ts 同一套参数出 2× 图）→ raster.ts（隔行隔列抽稀 + MSB 打包成 hex）
// hex 就是 ^GFA / BITMAP / GW 三段里真正下发给打印机的那串字节；ref.png 是抽稀前的原图，只作对照。
async function main() {
  const dir = process.env.LPS_BACKEND_DIR!;
  const out = process.env.LPS_OUT!;
  const fs = require('node:fs');
  const { createRequire } = require('node:module');
  const req = createRequire(`${dir}/package.json`);           // 从 backend/ 解析，保证用得上既有依赖
  const bwipjs = req('@bwip-js/node');
  const raster = await import(`${dir}/core/raster`);
  const caps = await import(`${dir}/core/barcode-renderer`);
  const geo = await import(`${dir}/core/barcode-geometry`);
  const dpi = Number(process.env.LPS_DPI ?? 203);
  const jobs = [
    // probeProto：拿去看真实异步链路（attachBitmapFallbacks）在该协议下走不走位图通道
    { id: 'qrcode', sym: 'QRCODE', content: 'HELLO-P7-ACCEPTANCE', expect: 'HELLO-P7-ACCEPTANCE', gs1: false, probeProto: 'zpl', probeBitmap: false },
    { id: 'datamatrix', sym: 'DATAMATRIX', content: 'HELLO-P7-ACCEPTANCE', expect: 'HELLO-P7-ACCEPTANCE', gs1: false, probeProto: 'tspl', probeBitmap: true },
    { id: 'pdf417', sym: 'PDF417', content: 'HELLO-P7-ACCEPTANCE', expect: 'HELLO-P7-ACCEPTANCE', gs1: false, probeProto: 'tspl', probeBitmap: true },
    // 含 (AI) 的二维：能力矩阵判位图通道，FNC1 由 barcode-renderer 以 ^FNC1 文本喂 bwip
    { id: 'dm_gs1', sym: 'DATAMATRIX', content: '(01)12345678901231(21)SN0007', expect: '011234567890123121SN0007', gs1: true, probeProto: 'zpl', probeBitmap: true },
    { id: 'qr_gs1', sym: 'QRCODE', content: '(01)12345678901231(21)SN0007', expect: '011234567890123121SN0007', gs1: true, probeProto: 'tspl', probeBitmap: true },
  ];
  const manifest: any[] = [];
  for (const j of jobs) {
    const spec: any = { sym: j.sym, content: j.content, moduleSizeMm: 0.6, quietZoneMm: 1.2 };
    const rec: any = { ...j, dpi, moduleSizeMm: 0.6 };
    try {
      const r = await raster.qrcodeMonoRaster(spec, dpi);
      rec.raster = {
        widthDots: r.widthDots, heightDots: r.heightDots, bytesPerRow: r.bytesPerRow,
        moduleDots: r.moduleDots, moduleDotsRequested: r.moduleDotsRequested ?? r.moduleDots,
        hex: r.hex,
      };
      fs.writeFileSync(`${out}/${j.id}.hex.txt`,
        `${r.widthDots} ${r.heightDots} ${r.bytesPerRow} ${r.moduleDots}\n${r.hex}\n`);
      // 真实异步链路（渲染服务用的就是它）：该协议下是否派到位图通道、档位上调有没有如实 warning
      const attached = await raster.attachBitmapFallbacks(
        [{ type: 'qrcode', xMm: 5, yMm: 5, qrcode: spec } as any], dpi, j.probeProto);
      rec.probe = {
        protocol: j.probeProto, wantBitmap: j.probeBitmap,
        gotFallback: !!(attached.els[0] as any).fallback,
        warnings: attached.warnings,
      };
      // 复现抽稀前的图：qrcodeMonoRaster 只用「2× 每模块点数 + 静区按模块数」这一组参数
      const g2 = geo.compute2dGeometry({ sym: j.sym, dpi, moduleSizeMm: 0.6, quietZoneMm: 1.2 });
      rec.quietModules = g2.quietModules;
      const opts = caps.qrcodeBwipOptions({ ...spec }, {
        dpi, pxPerModule: r.moduleDots * 2, paddingUnits: g2.quietModules * r.moduleDots,
      });
      const png = await bwipjs.toBuffer(opts);
      fs.writeFileSync(`${out}/${j.id}.ref.png`, png);
      // 对照样本：把 backgroundcolor 摘掉再出一次图。qrcodeBwipOptions 固定写
      // backgroundcolor:'FFFFFF'，所以正常产物是「不透明 RGBA」；一旦哪天有人改掉这个默认值，
      // bwip 就会给出「白底 alpha=0」的 RGBA —— 那是 C.9 要钉住的陷阱，这里先把它做出来。
      const noBgOpts = { ...opts } as any;
      delete noBgOpts.backgroundcolor;
      const pngNoBg = await bwipjs.toBuffer(noBgOpts);
      fs.writeFileSync(`${out}/${j.id}.nobg.png`, pngNoBg);
      rec.refPng = { bytes: png.length, noBgBytes: pngNoBg.length };
    } catch (e: any) { rec.rasterError = String(e?.message ?? e); }
    manifest.push(rec);
  }
  fs.writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest));
  for (const m of manifest) {
    const r = m.raster;
    console.log(`  GEN ${m.id.padEnd(11)}${r
      ? ` w=${r.widthDots} h=${r.heightDots} bpr=${r.bytesPerRow} md=${r.moduleDots}（请求 ${r.moduleDotsRequested}）quiet=${m.quietModules}格 hexLen=${r.hex.length}`
      : ` RASTER_ERR ${m.rasterError}`}  refPng=${m.refPng ? m.refPng.bytes : 'ERR'}B`);
  }
}
main().catch((e) => { console.error('GEN_FATAL', e?.stack ?? String(e)); process.exit(1); });
GEN_TS
  if LPS_BACKEND_DIR="$BACKEND" LPS_OUT="$TMPD" LPS_DPI="$DPI" npx tsx "$TMPD/gen.ts" > "$TMPD/gen.log" 2>&1; then
    ok "C.1 raster.ts 真实出点阵（QR / DM / PDF417 / GS1 DM / GS1 QR 共 5 例）"
    sed 's/^/     /' "$TMPD/gen.log"
  else
    no "C.1 raster.ts 真实出点阵" "$(tail -6 "$TMPD/gen.log" | tr '\n' ' ')"
  fi

  # ---- C.2–C.5 + C.9 判定：hex → 位平面（numpy 独立实现）→ PNG → 解码器；结论按 TSV 回吐给 bash
  cat > "$TMPD/dec.py" <<'DEC_PY'
# 每行一条结论：STATUS \t 编号 \t 标题 \t 证据。bash 侧只计数与打印，判定全在这里。
# 独立性关键：位平面由 numpy 按「每字节 MSB 在左、1=墨」重新还原，不复用本仓库打包代码 ——
# 打包方向写反时这里扫不出内容，而「字节数 == bpr×rows」那类断言照样是绿的，这正是本节要补的洞。
import json, os, re, sys

import numpy as np, cv2

OUT = os.environ['LPS_OUT']
HAS_ZXING = os.environ.get('LPS_HAS_ZXING') == '1'
if HAS_ZXING:
    import zxingcpp

rows = []


def emit(status, no_, title, detail=''):
    rows.append((status, no_, title, detail))


def norm(s):
    """只留字母数字：括号 AI、GS(0x1D)、AIM 前缀 ]d2/]Q3 都属解码器解释层，不参与逐字节比对。"""
    return re.sub(r'[^0-9A-Za-z]', '', s or '')


try:
    manifest = json.load(open(f'{OUT}/manifest.json'))
except Exception as e:
    emit('FAIL', 'C.1', 'manifest.json 读不到', str(e)[:200])
    manifest = []

for m in manifest:
    jid = m['id']
    if not m.get('raster'):
        emit('FAIL', f'C.2[{jid}]', '点阵生成', f"raster.ts 抛错：{m.get('rasterError', '')[:180]}")
        continue
    r = m['raster']
    w, h, bpr, md = r['widthDots'], r['heightDots'], r['bytesPerRow'], r['moduleDots']
    raw = bytes.fromhex(r['hex'])
    bits = np.unpackbits(np.frombuffer(raw, dtype=np.uint8).reshape(h, bpr), axis=1)[:, :w]
    inked = (bits > 0)

    # --- C.2 结构不变式（打包层）：bpr=ceil(w/8)、hex 长度、静区为白、墨占比合理
    probs = []
    if bpr != (w + 7) // 8:
        probs.append(f'bytesPerRow={bpr} 但 ceil({w}/8)={(w + 7) // 8}')
    if len(raw) != bpr * h:
        probs.append(f'hex 字节数 {len(raw)} ≠ bpr×rows={bpr * h}')
    if md and (h > 2 * md and w > 2 * md):
        ring = inked[:md, :].any() or inked[-md:, :].any() or inked[:, :md].any() or inked[:, -md:].any()
        if ring:
            probs.append(f'最外 {md} 个点不白（静区被吃，字节仍完整但扫不出）')
    ink = float(inked.mean())
    if not 0.02 < ink < 0.98:
        probs.append(f'墨占比 {ink:.3f} 异常（全黑/全白 = 抽稀或阈值崩了）')
    raised = r['moduleDotsRequested'] != md   # 为凑偶数网格上调档位：raster.ts 会出 [位图] warning，这里只做可见性记录
    if probs:
        emit('FAIL', f'C.2[{jid}]', '打包结构不变式', '；'.join(probs))
    else:
        emit('OK', f'C.2[{jid}]', '打包结构不变式', f'{w}×{h} 点，bpr={bpr}=ceil({w}/8)，hex={len(raw)}B，墨占比 {ink:.3f}')
    if raised:
        # 为凑偶数网格上调过每模块点数：印出尺寸会比模板的 moduleSizeMm 大。
        # raster.ts 允许这么做，但必须用 [位图] warning 说清楚（attachBitmapFallbacks 负责），这里只做可见性记录。
        emit('OK', f'C.2[{jid}]', '每模块点数被上调（如实告知项）',
             f"请求 {r['moduleDotsRequested']} → 实际 {md} 点/模块 ≈ {(md * 25.4 / m['dpi']):.2f}mm；"
             f"需由 raster 层 [位图] warning 说明，否则使用者以为尺寸没变")

    # --- C.3 抽稀一致性：ref.png（2× 原图）隔行隔列取样必须与 hex 位平面逐点相同
    ref = f'{OUT}/{jid}.ref.png'
    if not os.path.exists(ref):
        emit('SKIP', f'C.3[{jid}]', '与抽稀前 2× 图逐点对照', 'C.1 没产出 ref.png（bwip 复现失败）')
    else:
        g = cv2.imread(ref, cv2.IMREAD_GRAYSCALE)
        sh, sw = g.shape
        if sw % 2 or sh % 2:
            emit('FAIL', f'C.3[{jid}]', '与抽稀前 2× 图逐点对照', f'bwip 出图 {sw}×{sh} 有奇数边，模块边界落在半点上（raster.ts 本该在这里报错）')
        elif (sw // 2, sh // 2) != (w, h):
            emit('FAIL', f'C.3[{jid}]', '与抽稀前 2× 图逐点对照', f'抽稀后尺寸不符：期望 {sh // 2}×{sw // 2} 实得 {h}×{w}')
        else:
            half = (g[::2, ::2] < 128)
            diff = int((half != inked).sum())
            if diff == 0:
                emit('OK', f'C.3[{jid}]', '与抽稀前 2× 图逐点对照', f'{sw}×{sh} → {w}×{h}，0 位漂移（无半模块重采样）')
            else:
                emit('FAIL', f'C.3[{jid}]', '与抽稀前 2× 图逐点对照', f'{diff} 个点取反（阈值 128 的归属或取样起点偏了）')

    # --- C.6 异步位图通道（attachBitmapFallbacks）：派单与如实 warning
    pr = m.get('probe')
    if not pr:
        emit('SKIP', f'C.6[{jid}]', '位图通道派单与如实告知', 'C.1 没能跑到 attachBitmapFallbacks')
    else:
        pwarn = ' | '.join(pr['warnings'])
        if pr['wantBitmap'] and not pr['gotFallback']:
            emit('FAIL', f'C.6[{jid}]', f"位图通道派单（{pr['protocol']}）",
                 f"planChannel 该判 bitmap 却没拿到 fallback，warning：{pwarn[:180] or '无'}")
        elif (not pr['wantBitmap']) and pr['gotFallback']:
            emit('FAIL', f'C.6[{jid}]', f"位图通道派单（{pr['protocol']}）",
                 '原生指令通道被误判成位图：打出来仍可读，但与预览/规范不是同一套指令')
        elif pr['wantBitmap']:
            emit('OK', f'C.6[{jid}]', f"位图通道派单（{pr['protocol']}）", '元素确实拿到 bwip 点阵作为 fallback')
        else:
            emit('OK', f'C.6[{jid}]', f"位图通道派单（{pr['protocol']}）", '原生指令通道，未被塞入 fallback')
        if raised:
            if '上调' in pwarn:
                emit('OK', f'C.6[{jid}]', '档位上调必须如实 warning', f'warning 已说明点数与 mm 变化：{pwarn[:120]}')
            else:
                emit('FAIL', f'C.6[{jid}]', '档位上调必须如实 warning',
                     f'每模块点数从 {r["moduleDotsRequested"]} 抬到 {md}，但异步链路没告诉调用方印得更宽：{pwarn[:160] or "无 warning"}')

    # --- 还原成图（整数放大 + 白边）：给解码器的输入完全来自 hex
    img = np.where(inked, 0, 255).astype(np.uint8)
    img = cv2.copyMakeBorder(img, 12, 12, 12, 12, cv2.BORDER_CONSTANT, value=255)
    img = cv2.resize(img, None, fx=4, fy=4, interpolation=cv2.INTER_NEAREST)
    p = f'{OUT}/{jid}.roundtrip.png'
    cv2.imwrite(p, img)
    gray = cv2.imread(p, cv2.IMREAD_GRAYSCALE)

    # --- C.4 cv2.QRCodeDetector：只承担「普通 QR」的逐字节等值（brief 指定的解码器）
    if m['sym'] == 'QRCODE' and not m['gs1']:
        try:
            txt, _, _ = cv2.QRCodeDetector().detectAndDecode(gray)
            if txt == m['expect']:
                emit('OK', f'C.4[{jid}]', 'cv2.QRCodeDetector 逐字节相等', repr(txt))
            else:
                emit('FAIL', f'C.4[{jid}]', 'cv2.QRCodeDetector 逐字节相等', f"期望 {m['expect']!r} 实得 {txt!r}")
        except Exception as e:
            emit('FAIL', f'C.4[{jid}]', 'cv2.QRCodeDetector 解码', f'异常：{str(e)[:160]}')
    elif m['sym'] == 'QRCODE':
        try:
            cv2.QRCodeDetector().detectAndDecode(gray)
            note = 'cv2 未报错（该版本能吃 GS1 QR，但字节等值仍交给 zxingcpp 判）'
        except Exception as e:
            note = f'cv2 明确不解 GS1 QR（FNC1/ECI 分支未实现）：{str(e)[:110]}'
        emit('OK', f'C.4[{jid}]', 'cv2 对 GS1 QR 的行为如实记录（不参与判定）', note)

    # --- C.5 zxingcpp：DM / PDF417 / GS1 变体
    if not HAS_ZXING:
        emit('SKIP', f'C.5[{jid}]', 'zxingcpp 解码', 'python3 -c "import zxingcpp" 失败：沙箱里没有能解 DataMatrix/PDF417/GS1 语义的解码器（cv2 只认 QR）。不降级成「结构看起来对」的假绿')
        continue
    bs = zxingcpp.read_barcodes(gray)
    if not bs:
        emit('FAIL', f'C.5[{jid}]', 'zxingcpp 解码', 'hex 还原图扫不出任何符号（静区/模块边界/位序任一错都会这样）')
        continue
    b = bs[0]
    payload = bytes(b.bytes).decode('latin1')
    aim = b.symbology_identifier
    if m['gs1']:
        # GS1 不能断言逐字节相等：括号 (01) 是解码器按 AIM 解释层补的，符号里的 FNC1/GS(0x1D)
        # 有的解码器原样给、有的换成括号、有的直接吞掉。能钉死的是「结构身份 + 数据序列」。
        want_aim = ']d2' if m['sym'] == 'DATAMATRIX' else ']Q3'
        if aim != want_aim:
            emit('FAIL', f'C.5[{jid}]', 'GS1 AIM 标识符', f'期望 {want_aim} 实得 {aim!r}（AIM 不是 GS1 变体 = 符号被当成普通码制，AI 结构丢）')
        elif norm(payload) != norm(m['expect']):
            emit('FAIL', f'C.5[{jid}]', 'GS1 可解 + 归一化包含', f"AIM {aim} 正确，但数据序列不符：期望 {norm(m['expect'])} 实得 {norm(payload)}（raw={payload!r}）")
        else:
            emit('OK', f'C.5[{jid}]', 'GS1 可解 + 归一化包含', f'{aim} / {norm(payload)} ≡ 期望；text={b.text!r}（括号由解码器补）')
    else:
        if payload == m['expect']:
            emit('OK', f'C.5[{jid}]', 'zxingcpp 逐字节相等', f'{b.format.name} {aim} {payload!r}')
        else:
            emit('FAIL', f'C.5[{jid}]', 'zxingcpp 逐字节相等', f"期望 {m['expect']!r} 实得 {payload!r}（AIM {aim}）")
        if aim not in (']d1', ']Q1', ']L2', ']L3'):
            emit('FAIL', f'C.5[{jid}]', '非 GS1 不该出现 GS1 AIM', f'实得 {aim!r}')

    # --- C.9 alpha 陷阱：bwip 的 RGBA 白底是**透明**的（不 flatten 直接灰度 = 全黑）
    # 这是「位图通道为什么不许带 alpha 进 sharp / PIL」的活证据。本管线因为
    # qrcodeBwipOptions 固定 backgroundcolor:'FFFFFF' 而恰好不透明，所以判据分两层：
    #   C.9a 生产产物（.ref.png）：必须**不透明**（alpha 只有 255）——默认值被改掉就该红
    #   C.9b 对照产物（.nobg.png，同一参数但摘掉 backgroundcolor）：必须复现陷阱
    #        （alpha 含 0 ⇒ 直接 convert('L') 只剩一档灰度 ⇒ 解码器解不出；flatten 到白底后可解）
    refp = f'{OUT}/{jid}.ref.png'
    if not os.path.exists(refp):
        emit('SKIP', f'C.9[{jid}]', 'bwip PNG 的 alpha 口径', '没有 ref.png（C.1 复现 2× 图失败）')
    else:
      try:
        from PIL import Image

        def grey_stats(path, flatten_first):
            im0 = Image.open(path)
            rgba = im0.convert('RGBA')
            if flatten_first:
                f = Image.new('RGBA', im0.size, (255, 255, 255, 255))
                f.alpha_composite(rgba)
                rgba = f
            arr = np.array(rgba)
            al = sorted({int(x) for x in arr[:, :, 3].ravel().tolist()})
            g = np.array(rgba.convert('L'))
            return al, sorted(set(g.ravel().tolist())), g

        # C.9a 生产产物不透明
        al_p, uniq_p, _ = grey_stats(refp, False)
        if 0 in al_p:
            emit('FAIL', f'C.9a[{jid}]', '生产点阵 PNG 必须不透明（backgroundcolor 默认值仍在）',
                 f'{jid}.ref.png 的 alpha 含 0（实测 alpha={al_p[:4]}）：qrcodeBwipOptions 的 backgroundcolor 被改动，'
                 '此时 sharp 的 flatten 是唯一的救命稻草，请核对 raster.ts 是否仍带 .flatten({background:"#ffffff"})')
        elif len(uniq_p) < 2:
            emit('FAIL', f'C.9a[{jid}]', '生产点阵 PNG 灰度可用', f'alpha={al_p[:4]} 但灰度只剩 {uniq_p}（全黑/全白）')
        else:
            emit('OK', f'C.9a[{jid}]', '生产点阵 PNG 不透明、灰度两档齐',
                 f'alpha={al_p[:4]} 灰度={uniq_p[:4]}（bwip 的白底由 backgroundcolor 提供，不是靠透明通道）')

        # C.9b 对照产物必须复现陷阱
        refn = f'{OUT}/{jid}.nobg.png'
        if not os.path.exists(refn):
            emit('SKIP', f'C.9b[{jid}]', 'alpha 陷阱对照样本', '没有 .nobg.png（C.1 出对照图失败）')
        else:
            al_n, uniq_n, g_n = grey_stats(refn, False)
            al_n2, uniq_n2, g_ok = grey_stats(refn, True)
            naive_dark = len(uniq_n) < 2 and uniq_n and uniq_n[0] == 0
            if 0 not in al_n:
                emit('FAIL', f'C.9b[{jid}]', 'alpha 陷阱对照样本必须仍带透明白底',
                     f'.nobg.png 的 alpha={al_n[:4]}：bwip-js 默认行为变了（白底不再透明），'
                     '请把本用例与脚本头部的「透明底陷阱」说明一起更新')
            elif not naive_dark:
                emit('FAIL', f'C.9b[{jid}]', '透明白底 ⇒ convert(L) 全黑',
                     f'alpha={al_n[:4]} 但直接 convert(L) 得到 {uniq_n[:4]}（期望只剩 [0]）：PIL 行为或图像内容不符预期')
            elif len(uniq_n2) < 2:
                emit('FAIL', f'C.9b[{jid}]', 'flatten 到白底后应恢复两档灰度', f'flatten 后只有 {uniq_n2[:4]}')
            else:
                # 真正让解码器作证：同一张 PNG，naive 灰度解不出、flatten 后解得出
                ok_naive, ok_flat = None, None
                if HAS_ZXING:
                    ok_naive = bool(zxingcpp.read_barcodes(g_n))
                    ok_flat = bool(zxingcpp.read_barcodes(g_ok))
                if HAS_ZXING and ok_naive:
                    emit('FAIL', f'C.9b[{jid}]', '不 flatten 直接灰度应解不出',
                         f'zxingcpp 在「全黑」灰度上仍解出符号（{ok_naive} 个），说明这张图压根没有透明底')
                elif HAS_ZXING and not ok_flat:
                    emit('FAIL', f'C.9b[{jid}]', 'flatten 后应可解',
                         f'flatten 到白底后 zxingcpp 仍解不出（alpha={al_n[:4]} 灰度 {uniq_n2[:4]}）')
                else:
                    emit('OK', f'C.9b[{jid}]', 'alpha 陷阱复现（不 flatten 就得不到能扫的图）',
                         f'无 backgroundcolor 的 bwip PNG：alpha={al_n[:4]}，直接 convert(L) 只剩 {uniq_n[:4]}（全黑）'
                         f'{"，zxingcpp 解不出" if HAS_ZXING and not ok_naive else ""}；'
                         f'flatten 到白底后灰度 {uniq_n2[:4]}'
                         f'{"，zxingcpp 解得出" if HAS_ZXING and ok_flat else ""}'
                         ' ⇒ sharp 的 .flatten({background:"#ffffff"}) 不是可省的装饰')
      except Exception as e:
        emit('SKIP', f'C.9[{jid}]', 'bwip PNG 的 alpha 口径', f'判定链异常（PIL 缺失或 PNG 形状不符）：{type(e).__name__}: {str(e)[:120]}')

for row in rows:
    print('\t'.join(row))
DEC_PY
  : > "$TMPD/dec.tsv"
  if ! LPS_OUT="$TMPD" LPS_HAS_ZXING="$HAS_ZXING" python3 "$TMPD/dec.py" > "$TMPD/dec.tsv" 2>"$TMPD/dec.err"; then
    no "C.2 判定脚本执行" "$(tail -4 "$TMPD/dec.err" | tr '\n' ' ')"
  fi
  if [[ ! -s "$TMPD/dec.tsv" ]]; then
    sk "C.2–C.5 / C.9 逐例判定" "没有判定输出（C.1 失败或 python 崩了）：$(tail -3 "$TMPD/dec.err" | tr '\n' ' ')"
  else
    while IFS=$'\t' read -r st item title detail; do
      [[ -z "${st:-}" ]] && continue
      case "$st" in
        OK)   ok "$item $title（$detail）" ;;
        SKIP) sk "$item $title" "$detail" ;;
        *)    no "$item $title" "$detail" ;;
      esac
    done < "$TMPD/dec.tsv"
  fi

  # ---- C.7 档位阶梯（奇数点阵 → 自动上调 → 如实 warning）+ C.8 真实点阵的三协议下发头
  # 为什么单独跑：C.1 的 5 例都是「恰好偶数」的常规档位，测不到重试分支；
  # 而 bwip 的 PDF417 行高方向天然奇数（scale=1 时 120×21），203dpi 的 0.4/0.6mm 与
  # 300dpi 的 0.4/0.6/0.8mm 都会命中——旧实现在这里直接抛错，等于这些配置的 PDF417 全打不出。
  cat > "$TMPD/ladder.ts" <<'LAD_TS'
// 输出 TSV：STATUS \t 编号 \t 标题 \t 证据。判定逻辑都在这份脚本里，bash 只负责打印与计数。
async function main() {
  const dir = process.env.LPS_BACKEND_DIR!;
  const out = process.env.LPS_OUT!;
  const fs = require('node:fs');
  const { createRequire } = require('node:module');
  const req = createRequire(`${dir}/package.json`);
  const bwipjs = req('@bwip-js/node');
  const raster = await import(`${dir}/core/raster`);
  const caps = await import(`${dir}/core/barcode-renderer`);
  const geo = await import(`${dir}/core/barcode-geometry`);
  const blocks = await import(`${dir}/core/bitmap-blocks`);
  const rows: string[][] = [];
  const emit = (st: string, no: string, title: string, detail = '') => rows.push([st, no, title, detail]);
  /** PNG 头部 IHDR 直接读宽高（不引 sharp，免得把解码器依赖也拉进来） */
  const pngDims = (buf: Buffer) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

  // ======================= C.7 档位阶梯 =======================
  // 覆盖实测会出奇数边界的组合：PDF417 在 203dpi 0.4/0.6mm、300dpi 0.4/0.6/0.8mm
  const LAD: Array<[number, number]> = [[203, 0.4], [203, 0.6], [300, 0.4], [300, 0.6], [300, 0.8]];
  for (const [dpi, mm] of LAD) {
    const tag = `C.7[${dpi}dpi/${mm}mm]`;
    const spec: any = { sym: 'PDF417', content: 'LADDER-P7-ACCEPT', moduleSizeMm: mm, quietZoneMm: 1.2 };
    const g = geo.compute2dGeometry({ sym: 'PDF417', dpi, moduleSizeMm: mm, quietZoneMm: 1.2 });
    const requested = g.moduleDots;
    let baseDims = { w: 0, h: 0 };            // 用「请求档位」直接出图的尺寸（奇偶就是本题的题面）
    try {
      const png0 = await bwipjs.toBuffer(caps.qrcodeBwipOptions({ ...spec }, {
        dpi, pxPerModule: requested * 2, paddingUnits: g.quietModules * requested,
      }));
      baseDims = pngDims(png0);
    } catch (e: any) {
      emit('FAIL', tag, '按请求档位直接出图', `bwip 失败：${String(e?.message ?? e).slice(0, 120)}`);
      continue;
    }
    const baseOdd = baseDims.w % 2 !== 0 || baseDims.h % 2 !== 0;
    let r: any;
    try {
      r = await raster.qrcodeMonoRaster(spec, dpi);
    } catch (e: any) {
      // 三档都失败才允许抛；只要请求档位是奇数而 +1/+2 里有偶数，抛错就是回归
      emit('FAIL', tag, '奇数档位必须自动上调而不是直接抛错',
        `请求档位出图 ${baseDims.w}×${baseDims.h}，raster 抛：${String(e?.message ?? e).slice(0, 160)}`);
      continue;
    }
    const bumped = r.moduleDotsRequested !== undefined && r.moduleDotsRequested !== r.moduleDots;
    if (!baseOdd) {
      if (bumped) {
        emit('FAIL', tag, '偶数档位不该被上调',
          `请求档位已是 ${baseDims.w}×${baseDims.h}（全偶数），却把点数从 ${r.moduleDotsRequested} 抬到 ${r.moduleDots}：X-dim 白涨，模板尺寸被偷改`);
      } else {
        emit('OK', tag, '偶数档位保持原点数（不做无谓上调）',
          `${baseDims.w}×${baseDims.h} 全偶数，moduleDots=${r.moduleDots}，无 moduleDotsRequested`);
      }
    } else {
      if (!bumped || r.moduleDotsRequested !== requested) {
        emit('FAIL', tag, '奇数档位必须上调并如实记下请求值',
          `请求档位 ${baseDims.w}×${baseDims.h} 有奇数边，结果 moduleDots=${r.moduleDots}、moduleDotsRequested=${String(r.moduleDotsRequested)}：要么没重试，要么没留痕`);
      } else if (r.moduleDots - requested > 2) {
        emit('FAIL', tag, '上调幅度必须封顶在两档内', `从 ${requested} 抬到 ${r.moduleDots}`);
      } else {
        // 复查抽稀用的那张图确实是偶数：按最终点数重出一次对照
        const png1 = await bwipjs.toBuffer(caps.qrcodeBwipOptions({ ...spec }, {
          dpi, pxPerModule: r.moduleDots * 2, paddingUnits: g.quietModules * r.moduleDots,
        }));
        const d1 = pngDims(png1);
        if (d1.w % 2 || d1.h % 2) {
          emit('FAIL', tag, '上调后的档位仍不是偶数点阵', `${d1.w}×${d1.h}`);
        } else {
          emit('OK', tag, '奇数档位自动上调（无损抽稀前提成立）',
            `请求 ${requested} 点/模块出图 ${baseDims.w}×${baseDims.h}（奇数边）→ 上调到 ${r.moduleDots} 点后 ${d1.w}×${d1.h}，最终点阵 ${r.widthDots}×${r.heightDots}`);
        }
      }
      // 副作用必须如实告知：attachBitmapFallbacks 是该 warning 的唯一出口。
      // 探测协议必须选 PDF417 走位图通道的 tspl/epl —— ZPL 有原生 ^B7，planChannel 判 native，
      // 根本不会出点阵，拿 zpl 探就只会看到「没有 warning」这种假绿（第一版就踩在这里）。
      const attached = await raster.attachBitmapFallbacks(
        [{ type: 'qrcode', xMm: 5, yMm: 5, qrcode: spec } as any], dpi, 'tspl');
      const w = attached.warnings.find((x: string) => /每模块点数由/.test(x)) ?? '';
      if (!attached.els[0]) {
        emit('FAIL', tag, 'attachBitmapFallbacks 出元素', '返回空数组');
      } else if (!(attached.els[0] as any).fallback) {
        emit('FAIL', tag, '位图通道仍拿到点阵', `warning：${attached.warnings.join(' | ').slice(0, 160) || '无'}`);
      } else if (!w) {
        emit('FAIL', tag, '上调档位必须发 warning',
          `X-dim 从 ${(requested * 25.4 / dpi).toFixed(2)}mm 变成 ${(r.moduleDots * 25.4 / dpi).toFixed(2)}mm 却不告知：warning 只有 ${attached.warnings.length} 条`);
      } else if (!new RegExp(`${requested}`).test(w) || !new RegExp(`${r.moduleDots}`).test(w)) {
        emit('FAIL', tag, 'warning 里必须给出「从几点到几点」', w.slice(0, 160));
      } else {
        emit('OK', tag, '上调档位如实发 warning（含点数与 mm 两个口径）', w.slice(0, 170));
      }
    }
    fs.writeFileSync(`${out}/ladder-${dpi}-${mm}.hex.txt`, `${r.widthDots} ${r.heightDots} ${r.bytesPerRow}\n${r.hex}\n`);
  }

  // ======================= C.8 真实点阵的三协议下发头 =======================
  // golden 用的是 24×12 的合成点阵（bpr=3、rows=12、total=36）；这里换成 bwip 真图，
  // 尺寸任意，专门验「头里的三个数与载荷长度」在真实尺寸下仍然自洽——
  // 「行数当总字节数」这个缺陷在小图上会被 hex 长度断言一起抓住，但反过来
  // 「hex 长度 = 2×total」写反成 2×rows 时只有真图尺寸才会暴露。
  for (const [sym, content, proto] of [
    ['DATAMATRIX', '(01)12345678901231(21)SN0007', 'zpl'],
    ['QRCODE', 'HELLO-P7-TRANSPORT', 'tspl'],
    ['DATAMATRIX', 'HELLO-P7-TRANSPORT', 'epl'],
  ] as Array<[string, string, string]>) {
    const tag = `C.8[${sym}/${proto}]`;
    const dpi = 203;
    const spec: any = { sym, content, moduleSizeMm: 0.6, quietZoneMm: 1.2 };
    let r: any;
    try { r = await raster.qrcodeMonoRaster(spec, dpi); }
    catch (e: any) { emit('FAIL', tag, '真实点阵生成', String(e?.message ?? e).slice(0, 160)); continue; }
    const total = r.bytesPerRow * r.heightDots;
    const hexBytes = r.hex.length / 2;
    if (hexBytes !== total) {
      emit('FAIL', tag, '点阵本体：hex 字节数 == bytesPerRow × heightDots',
        `hex=${hexBytes}B 而 bpr×rows=${total}B（${r.bytesPerRow}×${r.heightDots}）`);
      continue;
    }
    if (proto === 'zpl') {
      const line = blocks.zplGf(r);
      const m = /^\^GFA,(\d+),(\d+),(\d+),([0-9A-F]+)$/.exec(line);
      if (!m) { emit('FAIL', tag, '^GFA 头格式', line.slice(0, 60)); continue; }
      const [, b, c, d, hex] = m;
      const bad: string[] = [];
      if (b !== c) bad.push(`b=${b} 而 c=${c}：单块必须相等，c 写成行数会被固件提前截断且不报错`);
      if (Number(c) !== total) bad.push(`c=${c} 而总字节数=${total}`);
      if (Number(d) !== r.bytesPerRow) bad.push(`d=${d} 而 bytesPerRow=${r.bytesPerRow}`);
      if (hex.length !== total * 2) bad.push(`载荷 hex 字符数=${hex.length} 而 2×total=${total * 2}`);
      if (Number(b) % Number(d) !== 0) bad.push(`b=${b} 不能被 d=${d} 整除（最后一行是半行）`);
      if (bad.length) emit('FAIL', tag, '^GFA 的 b/c/d 与载荷四数自洽', bad.join('；'));
      else emit('OK', tag, '^GFA 的 b/c/d 与载荷四数自洽',
        `^GFA,${b},c=${c},d=${d}，${r.widthDots}×${r.heightDots} 点 ⇒ ${total}B 载荷（真实 bwip 点阵，非 golden 的合成 24×12）`);
    } else if (proto === 'tspl') {
      const lines = blocks.tsplBitmapLines(r);
      const bad: string[] = [];
      if (lines.length !== r.heightDots) bad.push(`行数=${lines.length} 而 heightDots=${r.heightDots}`);
      if (lines.some((l: string) => l.length !== r.bytesPerRow * 2)) bad.push('有行的 hex 长度不等于 2×bytesPerRow');
      if (lines.join('').length !== r.hex.length) bad.push('逐行拼接与整块 hex 不等长（行切分错位）');
      if (bad.length) emit('FAIL', tag, 'BITMAP 逐行载荷', bad.join('；'));
      else emit('OK', tag, 'BITMAP 逐行载荷', `${lines.length} 行 × ${r.bytesPerRow}B/行，拼回整块 hex 一致`);
    } else {
      const sz = blocks.eplGraphicSize(r);
      if (sz.widthBytes !== r.bytesPerRow || sz.heightBytes !== r.heightDots) {
        emit('FAIL', tag, 'GW 头部尺寸', `得到 ${sz.widthBytes}×${sz.heightBytes}，应为 bytesPerRow×heightDots=${r.bytesPerRow}×${r.heightDots}`);
      } else if (sz.widthBytes * sz.heightBytes !== total) {
        emit('FAIL', tag, 'GW 的 p3×p4 == 载荷字节数', `${sz.widthBytes}×${sz.heightBytes} != ${total}`);
      } else {
        emit('OK', tag, 'GW 头部尺寸与载荷字节数一致', `GW ...,${sz.widthBytes},${sz.heightBytes}, ⇒ ${total}B`);
      }
    }
  }
  fs.writeFileSync(`${out}/ladder.tsv`, rows.map((x) => x.join('\t')).join('\n') + '\n');
  for (const x of rows) console.log(`  ${x[0]} ${x[1]} ${x[2]} — ${x[3] ?? ''}`);
}
main().catch((e) => { console.error('LADDER_FATAL', e?.stack ?? String(e)); process.exit(1); });
LAD_TS
  if LPS_BACKEND_DIR="$BACKEND" LPS_OUT="$TMPD" npx tsx "$TMPD/ladder.ts" > "$TMPD/ladder.log" 2>&1; then
    while IFS=$'\t' read -r st item title detail; do
      [[ -z "${st:-}" ]] && continue
      case "$st" in
        OK)   ok "$item $title（$detail）" ;;
        SKIP) sk "$item $title" "$detail" ;;
        *)    no "$item $title" "$detail" ;;
      esac
    done < "$TMPD/ladder.tsv"
  else
    no "C.7/C.8 档位阶梯与三协议下发头" "$(tail -6 "$TMPD/ladder.log" | tr '\n' ' ')"
  fi
fi

# =============================================================================
# D. /print/commands 三协议冒烟（可选：后端不在线整段 SKIP，绝不判 FAIL）
#    断言两件事：textBase64 解出的字节数 == bytes；出现位图指令段时 textExact 必须是 false。
#    三协议字节口径（与 coordinator 的 21 项自检一致）：
#      · TSPL：BITMAP x,y,bpr,rows,0, 载荷字节数 == bpr*rows，载荷后紧跟 CRLF ⇒ 含位图必 textExact=false
#      · EPL ：GWx,y,widthBytes,heightBytes, 载荷 == widthBytes*heightBytes ⇒ 含位图必 textExact=false
#      · ZPL ：^GFA 走 ASCII hex，高位字节仍是纯文本 ⇒ 有位图也可能 textExact=true（如实记录，不判 FAIL）
#    离线口径由 B（golden 逐字符）与 C.8（真实点阵的三协议下发头）负责；本段只补 HTTP 层。
#    参考实现（只读、勿搬进仓库）：/tmp/verify-e2e.ts、/tmp/verify-bitmap-roundtrip.ts。
# =============================================================================
sect "D. POST /print/commands 三协议冒烟（可选）"

if ! command -v curl >/dev/null 2>&1; then
  sk "D.1–D.5 整段跳过" "PATH 里没有 curl"
else
  probe=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$BASE" 2>/dev/null)
  probe=${probe:-000}
  if [[ "$probe" == "000" ]]; then
    sk "D.1–D.5 整段跳过" "BASE=$BASE 不可达（返回 000）。本段是可选冒烟：后端起来后 BASE=http://127.0.0.1:3200/api/v1 重跑即可；即使端点缺失/未授权也只 SKIP，不参与退出码"
  else
    printf '       BASE=%s 探测 HTTP %s\n' "$BASE" "$probe"
    # JSON 取值小工具（逐层下钻，取不到就输出空串）
    cat > "$TMPD/jget.py" <<'JG'
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print(''); sys.exit(0)
for k in sys.argv[1:]:
    if isinstance(d, dict):
        d = d.get(k)
    elif isinstance(d, list):
        try:
            d = d[int(k)]
        except Exception:
            d = None
    else:
        d = None
print('' if d is None else (json.dumps(d, ensure_ascii=False) if isinstance(d, (dict, list)) else d))
JG
    TOK=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' --max-time 10 \
      -d '{"username":"admin","password":"admin123","tenantCode":"default"}' \
      | python3 "$TMPD/jget.py" data accessToken 2>/dev/null)
    if [[ -z "$TOK" ]]; then
      sk "D.1–D.5 整段跳过" "$BASE/auth/login 没拿到 accessToken（口令已改 / 该环境非 default 租户）。可选冒烟，不判 FAIL"
    else
      ok "D.1 登录取 token（POST $BASE/auth/login）"

      # 模板里同时放：原生一维（CODE128）、原生 QR（zpl/tspl 走指令）、GS1 DataMatrix（三协议都要位图）
      cat > "$TMPD/tpl.json" <<'TPL'
{
  "templateContent": {
    "page": { "widthMm": 60, "heightMm": 40, "dpi": 203, "orientation": 0 },
    "elements": [
      { "id": "e1", "type": "text", "x": 5, "y": 3, "text": "P7 SMOKE", "font": { "size": 12 } },
      { "id": "e2", "type": "barcode", "x": 5, "y": 8,
        "barcode": { "sym": "CODE128", "content": "ABC-1234", "moduleWidthMm": 0.4, "wideRatio": 2.5, "heightMm": 12 } },
      { "id": "e3", "type": "qrcode", "x": 34, "y": 8, "h": 12,
        "qrcode": { "sym": "QRCODE", "content": "HELLO-P7", "moduleSizeMm": 0.5 } },
      { "id": "e4", "type": "qrcode", "x": 5, "y": 22, "h": 12,
        "qrcode": { "sym": "DATAMATRIX", "content": "(01)12345678901231(21)SN0007", "moduleSizeMm": 0.5 } }
    ]
  },
  "rows": [{}], "copies": 1, "dpi": 203, "widthMm": 60, "heightMm": 40
}
TPL
      cat > "$TMPD/mkbody.py" <<'MB'
import json, sys
d = json.load(open(sys.argv[1]))
d['protocol'] = sys.argv[2]
print(json.dumps(d, ensure_ascii=False))
MB
      # 响应字段一次性解出来：bytes / base64 实际长度 / textExact / 指令里出现的位图关键字
      cat > "$TMPD/resp.py" <<'RP'
import base64, json, sys
d = json.load(open(sys.argv[1]))
d = d.get('data', d)
raw = base64.b64decode(d.get('textBase64') or '')
marks = ','.join(k for k in ('BITMAP', 'GW', '^GFA') if k.encode() in raw)
high = sum(1 for b in raw if b > 0x7F)
# textExact 的真值不靠猜：把 text 按 utf8 编回去和原始字节比一次（服务端就是这么定义的）
text = d.get('text') or ''
computed = (text.encode('utf-8') == raw)
print(d.get('bytes', -1), len(raw), str(d.get('textExact')).lower(), marks or '-',
      high, str(computed).lower(), sep='\t')
RP
      for proto in zpl tspl epl; do
        python3 "$TMPD/mkbody.py" "$TMPD/tpl.json" "$proto" > "$TMPD/body.$proto.json"
        code=$(curl -s -o "$TMPD/resp.$proto.json" -w '%{http_code}' -X POST "$BASE/print/commands" \
          -H 'Content-Type: application/json' -H "Authorization: Bearer $TOK" \
          --data @"$TMPD/body.$proto.json" --max-time 30)
        if [[ "$code" != "200" && "$code" != "201" ]]; then
          sk "D.2[$proto] POST /print/commands" "HTTP $code：$(head -c 180 "$TMPD/resp.$proto.json" 2>/dev/null | tr '\n' ' ')。端点在该环境不可用/连不上/被守卫挡下 → 跳过，不判 FAIL"
          continue
        fi
        ok "D.2[$proto] POST /print/commands → HTTP $code"
        IFS=$'\t' read -r p_bytes p_len p_exact p_marks p_high p_computed < <(python3 "$TMPD/resp.py" "$TMPD/resp.$proto.json" 2>/dev/null)
        if [[ -z "${p_bytes:-}" ]]; then
          no "D.3[$proto] 响应字段解析" "resp.py 没输出（响应不是预期 JSON）"
          continue
        fi
        check "D.3[$proto] textBase64 解码字节数 == bytes" "$p_len" "$p_bytes"
        # textExact 是服务端自己算的，这里用同一套字节独立复算一遍：两者不一致 = 字段在骗人
        check "D.4[$proto] textExact 与独立复算一致" "$p_exact" "$p_computed"
        if [[ "$p_marks" == "-" ]]; then
          sk "D.5[$proto] 「含位图段 ⇒ textExact=false」专项判定" "指令里没有 BITMAP / GW / ^GFA 段（该协议这组元素全走原生指令，无二进制载荷）"
        elif [[ "$p_high" != "0" ]]; then
          check "D.5[$proto] 含位图段（$p_marks，$p_high 个高位字节）时 textExact=false" "$p_exact" "false"
        else
          # ZPL 的位图是 ^GFA 十六进制（纯 ASCII），text 仍然无损 —— 这正是三协议导出策略不同的地方
          ok "D.5[$proto] 含位图段（$p_marks）但载荷是 ASCII（^GFA 十六进制），textExact=$p_exact 符合预期"
        fi
        n_warn=$(python3 "$TMPD/jget.py" warnings < "$TMPD/resp.$proto.json" | python3 -c 'import sys,json;print(len(json.loads(sys.stdin.read() or "[]")))' 2>/dev/null)
        printf '       %s：bytes=%s 位图段=%s 高位字节=%s warnings=%s 条\n' "$proto" "$p_bytes" "$p_marks" "$p_high" "${n_warn:-?}"
      done
    fi
  fi
fi

# =============================================================================
SECT="汇总"          # 汇总本身不再算作一段
for sec in "${ORDER[@]}"; do
  printf '  %-34s PASS %-3s FAIL %-3s SKIP %-3s\n' "$sec" "${P[$sec]:-0}" "${F[$sec]:-0}" "${S[$sec]:-0}"
done
printf '  %-34s PASS %s / FAIL %s / SKIP %s\n' '合计' "$pass" "$fail" "$skip"
if (( fail > 0 )); then echo "  结论：FAIL"; exit 1; fi
echo "  结论：PASS（SKIP $skip 项，原因见上）"
exit 0
