#!/usr/bin/env bash
# init-config.sh — 一键写入 $schema 到 openclaw.json
#
# 用法:
#   bash init-config.sh [--config FILE] [--v VERSION]
#
#   --config FILE   配置文件路径（默认: ~/.openclaw/openclaw.json）
#   --v VERSION     schema 版本号（如 2026.3.24），不指定则取最新

set -euo pipefail

REPO_URL="https://github.com/elonnzhang/openclaw-json-schema/releases/download"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HISTORY_DIR="$SCRIPT_DIR/history"

CONFIG="./openclaw.json"
VERSION=""

# ── 解析参数 ──────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --v)      VERSION="$2"; shift 2 ;;
    -h|--help)
      echo "用法: bash init-config.sh [--config FILE] [--v VERSION]"
      echo ""
      echo "  --config FILE   配置文件路径（默认: ~/.openclaw/openclaw.json）"
      echo "  --v VERSION     schema 版本号（如 2026.3.24），不指定则取最新"
      exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

# ── 检测最新版本 ──────────────────────────────────────────────────────────

if [[ -z "$VERSION" ]]; then
  # 从 history 目录取最新版本号
  if [[ -d "$HISTORY_DIR" ]]; then
    VERSION=$(ls "$HISTORY_DIR"/openclaw.*.schema.json 2>/dev/null \
      | sed 's/.*openclaw\.\(.*\)\.schema\.json/\1/' \
      | sort -V | tail -1)
  fi
  # fallback: git tag
  if [[ -z "$VERSION" ]]; then
    VERSION=$(git -C "$SCRIPT_DIR" describe --tags --abbrev=0 2>/dev/null | sed 's/^v//')
  fi
  # fallback: GitHub API latest release
  if [[ -z "$VERSION" ]]; then
    VERSION=$(curl -fsSL https://api.github.com/repos/elonnzhang/openclaw-json-schema/releases/latest 2>/dev/null \
      | grep '"tag_name"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/')
  fi
  if [[ -z "$VERSION" ]]; then
    echo "无法检测版本，请用 --v 指定" >&2
    exit 1
  fi
fi

VERSION="${VERSION#v}"  # 去掉 v 前缀
SCHEMA_URL="$REPO_URL/v$VERSION/openclaw.schema.json"

echo "版本: v$VERSION"
echo "Schema: $SCHEMA_URL"

# ── 写入配置 ──────────────────────────────────────────────────────────────

if [[ -f "$CONFIG" ]]; then
  # 文件已存在：用 node 注入 $schema（保留原有内容）
  node -e "
    const fs = require('fs');
    const {'\$schema': _, ...rest} = JSON.parse(fs.readFileSync('$CONFIG', 'utf8'));
    const cfg = {'\$schema': '$SCHEMA_URL', ...rest};
    fs.writeFileSync('$CONFIG', JSON.stringify(cfg, null, 2) + '\n');
  "
  echo "已更新 $CONFIG"
else
  # 新建
  printf '{\n  "$schema": "%s"\n}\n' "$SCHEMA_URL" > "$CONFIG"
  echo "已创建 $CONFIG"
fi
