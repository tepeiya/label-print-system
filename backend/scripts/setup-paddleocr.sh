#!/usr/bin/env bash
# =============================================================================
# scripts/setup-paddleocr.sh —— PaddleOCR 一键部署（Docker Compose）
#
# 用法：
#   bash scripts/setup-paddleocr.sh          # 交互式（选端口、选语言模型）
#   bash scripts/setup-paddleocr.sh --yes    # 全自动：端口 8080 + 中文 en_PP-OCRv4_det_mobile
#
# 完成后：
#   1. Docker 容器在后台运行
#   2. 打印 .env 片段粘贴到 backend/.env 即可生效
# =============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

# 解析参数
YES=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=true ;;
  esac
done

if ! command -v docker &>/dev/null; then
  echo "❌ 未检测到 Docker，请先安装 Docker Desktop 或 docker-ce"
  echo "   https://docs.docker.com/get-docker/"
  exit 1
fi

# --- 交互式配置 ---
PORT=8080
LANG="ch"

if ! $YES; then
  echo "=== PaddleOCR 部署向导 ==="
  read -rp "HTTP 端口（默认 8080）: " PORT_INPUT
  PORT="${PORT_INPUT:-8080}"
  read -rp "语言 [ch=中文, en=英文, mult=多语言]（默认 ch）: " LANG_INPUT
  LANG="${LANG_INPUT:-ch}"
fi

# --- 生成 docker-compose.yml ---
cat > scripts/paddleocr-compose.yml << YAML
# PaddleOCR HTTP 推理服务
# 官方镜像已内置 HTTP Server（flask），路径 /ocr/predict
services:
  paddleocr:
    image: registry.baidubce.com/paddlepaddle/paddleocr:2.7.0
    container_name: labelflow-paddleocr
    restart: unless-stopped
    ports:
      - "${PORT}:8080"
    environment:
      - FLASK_PORT=8080
      - LANG=${LANG}
    # 第一次启动会自动下载模型（几 GB），挂载卷加速重启
    volumes:
      - paddleocr-models:/root/.paddleocr
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/ocr/predict"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 120s  # 冷启动模型加载约 1-3 分钟

volumes:
  paddleocr-models:
YAML

echo "📦 启动 PaddleOCR（可能需要几分钟下载模型）..."
docker compose -f scripts/paddleocr-compose.yml up -d

# --- 等待健康检查 ---
echo "⏳ 等待容器就绪..."
for i in {1..60}; do
  if curl -s "http://localhost:${PORT}/ocr/predict" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

if ! curl -s "http://localhost:${PORT}/ocr/predict" >/dev/null 2>&1; then
  echo "⚠️  容器尚未完全就绪，手动等 1-3 分钟后再试。"
fi

# --- 输出 .env 片段 ---
cat << OUTPUT

=========================================
✅ PaddleOCR 部署完成！
=========================================

容器状态：
$(docker compose -f scripts/paddleocr-compose.yml ps 2>/dev/null || true)

请把以下两行加入 backend/.env：

  OCR_PROVIDER=paddle
  OCR_HTTP=http://localhost:${PORT}/ocr/predict

或者一行搞定：

  echo -e "\nOCR_PROVIDER=paddle\nOCR_HTTP=http://localhost:${PORT}/ocr/predict" >> backend/.env

然后重启后端：

  npm run start:dev

常用命令：
  docker compose -f scripts/paddleocr-compose.yml logs -f   # 看日志
  docker compose -f scripts/paddleocr-compose.yml down       # 停止
  curl -X POST http://localhost:${PORT}/ocr/predict -F "img=@/path/to/tag.jpg"  # 测试

OUTPUT
