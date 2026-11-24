#!/usr/bin/env bash
# =============================================================================
# print-agent-release.sh —— 生成 Windows 打印代理发行包（可由租户自助下载）
#
# 产物：
#   backend/assets/print-agent/labelflow-print-agent-win64-<ver>.zip
#   backend/assets/print-agent/release.json      ← 供 /hardware/agents/release 读
#
# 用法：
#   bash backend/scripts/print-agent-release.sh            # 版本 1.0
#   VERSION=1.1 bash backend/scripts/print-agent-release.sh
#
# 依赖：.NET 8 SDK（Linux 上也能交叉出 win-x64 自包含 exe）。
# 找不到 dotnet 时用 DOTNET_BIN 指定，例如 DOTNET_BIN=$HOME/.dotnet8/dotnet。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$ROOT/apps/print-agent"
OUT="$ROOT/backend/assets/print-agent"
VER="${VERSION:-1.0}"
DOTNET_BIN="${DOTNET_BIN:-dotnet}"
PKG_NAME="labelflow-print-agent-win64-$VER"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "[1/4] dotnet publish（win-x64 自包含单文件）"
"$DOTNET_BIN" publish "$APP" -c Release -r win-x64 --self-contained true \
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true \
  -o "$STAGE/publish" >/dev/null

echo "[2/4] 组装包结构"
mkdir -p "$STAGE/$PKG_NAME/install"
cp "$STAGE/publish/LabelFlow.PrintAgent.exe" "$STAGE/$PKG_NAME/"
cp "$APP/agent.example.json" "$APP/README.md" "$STAGE/$PKG_NAME/"
cp "$APP/install/install-agent.ps1" "$APP/install/uninstall-agent.ps1" "$STAGE/$PKG_NAME/install/"

SHA="$(sha256sum "$STAGE/$PKG_NAME/LabelFlow.PrintAgent.exe" | awk '{print $1}')"
SIZE_EXE="$(stat -c%s "$STAGE/$PKG_NAME/LabelFlow.PrintAgent.exe")"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$STAGE/$PKG_NAME/版本与校验.txt" <<EOF
LabelFlow 本地打印代理（Windows x64）$VER
构建：$BUILT_AT  ·  自包含单文件（客户机无需安装 .NET）

LabelFlow.PrintAgent.exe  SHA-256
$SHA

部署前请先读 README.md。装完务必跑一次体检：LabelFlow.PrintAgent.exe --doctor
EOF

echo "[3/4] 压缩"
mkdir -p "$OUT"
ZIP="$OUT/$PKG_NAME.zip"
rm -f "$ZIP"
(cd "$STAGE" && zip -qr "$ZIP" "$PKG_NAME")

ZIP_SHA="$(sha256sum "$ZIP" | awk '{print $1}')"
ZIP_SIZE="$(stat -c%s "$ZIP")"

echo "[4/4] 写 release.json"
python3 - "$OUT/release.json" <<PY
import json, sys
meta = {
    "version": "$VER",
    "fileName": "$PKG_NAME.zip",
    "sizeBytes": $ZIP_SIZE,
    "sha256": "$ZIP_SHA",
    "exeSha256": "$SHA",
    "exeSizeBytes": $SIZE_EXE,
    "platform": "windows-x64",
    "builtAt": "$BUILT_AT",
}
open(sys.argv[1], "w", encoding="utf-8").write(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
PY

echo
echo "完成：$ZIP"
echo "  zip  $(numfmt --to=iec "$ZIP_SIZE" 2>/dev/null || echo "$ZIP_SIZE")  sha256=$ZIP_SHA"
echo "  exe  $(numfmt --to=iec "$SIZE_EXE" 2>/dev/null || echo "$SIZE_EXE")  sha256=$SHA"
echo "记得提交 backend/assets/print-agent/ 才会被租户下载到。"
