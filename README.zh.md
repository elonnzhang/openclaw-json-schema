# openclaw-json-schema

[English](README.md)

自动提取 [OpenClaw](https://github.com/openclaw/openclaw) 配置文件的 JSON Schema，每天定时更新。

## 文件说明

| 文件 / 目录                              | 说明                                 |
| ---------------------------------------- | ------------------------------------ |
| `openclaw.schema.json`                   | 最新版本的 JSON Schema（始终是最新） |
| `history/openclaw.<version>.schema.json` | 带版本号的历史归档                   |

## 使用方法

### 从 Releases 下载

每个 schema 版本会自动发布为 [GitHub Release](../../releases)，附带 JSON 文件。你可以下载指定版本：

```bash
# 最新 release
gh release download --pattern 'openclaw.schema.json'

# 指定版本
gh release download v2026.3.24 --pattern 'openclaw.schema.json'
```

### 一键写入（推荐）

无需 clone 仓库，直接远程执行：

```bash
curl -fsSL https://raw.githubusercontent.com/elonnzhang/openclaw-json-schema/main/init-config.sh | bash

# 指定配置文件路径
curl -fsSL https://raw.githubusercontent.com/elonnzhang/openclaw-json-schema/main/init-config.sh | bash -s -- --config ~/project/openclaw.json

# 指定 schema 版本（不指定则使用最新版）
curl -fsSL https://raw.githubusercontent.com/elonnzhang/openclaw-json-schema/main/init-config.sh | bash -s -- --v 2026.3.24
```

- 文件不存在：创建包含 `$schema` 的 `openclaw.json`
- 文件已存在：将 `$schema` 写入首行，保留原有配置

### VS Code 自动补全

在 `openclaw.json` 中添加 `$schema` 字段：

```json
{
  "$schema": "https://raw.githubusercontent.com/elonnzhang/openclaw-json-schema/main/openclaw.schema.json",
  "gateway": {
    ...
  }
}
```

或使用固定版本的 Release URL：

```json
{
  "$schema": "https://github.com/elonnzhang/openclaw-json-schema/releases/download/v2026.3.24/openclaw.schema.json"
}
```

或在 VS Code `settings.json` 中配置：

```json
{
  "json.schemas": [
    {
      "fileMatch": ["**/openclaw.json"],
      "url": "https://raw.githubusercontent.com/elonnzhang/openclaw-json-schema/main/openclaw.schema.json"
    }
  ]
}
```

## 工作原理

GitHub Actions 每天 UTC 02:00（北京时间 10:00）自动运行：

1. Clone `openclaw/openclaw` 源码
2. 从 `package.json` 读取 zod 版本并安装（无需全量 `npm ci`）
3. 运行 `scripts/extract-schema-ci.mjs --mode local` 提取 JSON Schema
4. 如有变更，自动 commit 并 push

## 手动触发

在 Actions 页面点击 `Run workflow`，可以指定 git ref（分支或 tag）。

## 本地提取

### 方式一：从已 clone 的源码提取（推荐）

```bash
git clone --depth 1 https://github.com/openclaw/openclaw openclaw-src
cd openclaw-src && npm install --ignore-scripts && cd ..
node scripts/extract-schema-ci.mjs \
  --mode local \
  --src-dir ./openclaw-src/src \
  --zod-dir ./openclaw-src/node_modules \
  --output ./openclaw.schema.json
```

### 方式二：从 GitHub 下载（需 gh CLI）

```bash
node scripts/extract-schema-ci.mjs --mode gh --output ./openclaw.schema.json

# 指定 git ref
node scripts/extract-schema-ci.mjs --mode gh --ref v2026.3.24

# 与旧版 schema 比较差异
node scripts/extract-schema-ci.mjs --mode gh --diff ./old-schema.json
```

### 方式三：从本地 .d.ts 提取（离线，无需网络）

```bash
node scripts/extract-schema-d.ts.mjs --output ./openclaw.schema.json
```

## 脚本说明

| 脚本                              | 说明                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `init-config.sh`                  | 一键写入 `$schema` 到 `openclaw.json`，支持 `--config` 和 `--v`                       |
| `scripts/extract-schema-ci.mjs`   | 统一入口，支持 `--mode gh`（GitHub 下载）和 `--mode local`（本地源码），CI 和本地通用 |
| `scripts/extract-schema.mjs`      | GitHub 源码方式，功能与 CI 脚本的 gh 模式相同，独立使用                               |
| `scripts/extract-schema-d.ts.mjs` | 本地 `.d.ts` + TS Compiler API 方式，完全离线，无需 gh CLI                            |

脚本来自： https://github.com/Kaspre/my-openclaw-patches/blob/master/scripts/extract-schema.mjs
