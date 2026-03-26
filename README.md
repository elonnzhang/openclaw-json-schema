# openclaw-json-schema

[中文文档](README.zh.md)

Automatically extracts the JSON Schema for [OpenClaw](https://github.com/openclaw/openclaw) configuration files, updated daily.

## Files

| File / Directory                         | Description                              |
| ---------------------------------------- | ---------------------------------------- |
| `openclaw.schema.json`                   | Latest JSON Schema (always up to date)   |
| `history/openclaw.<version>.schema.json` | Versioned archive for historical records |

## Usage

### Download from Releases

Each schema version is published as a [GitHub Release](../../releases) with the JSON file attached. You can download a specific version:

```bash
# Latest release
gh release download --pattern 'openclaw.schema.json'

# Specific version
gh release download v2026.3.24 --pattern 'openclaw.schema.json'
```

### Quick Init (one-liner)

No need to clone — run remotely:

```bash
curl -fsSL https://raw.githubusercontent.com/elonnzhang/openclaw-json-schema/main/init-config.sh | bash

# Specify config file path
curl -fsSL https://raw.githubusercontent.com/elonnzhang/openclaw-json-schema/main/init-config.sh | bash -s -- --config ~/project/openclaw.json

# Specify schema version (defaults to latest)
curl -fsSL https://raw.githubusercontent.com/elonnzhang/openclaw-json-schema/main/init-config.sh | bash -s -- --v 2026.3.24
```

- New file: creates `openclaw.json` with `$schema`
- Existing file: injects `$schema` as the first field, preserving all other config

### VS Code Autocompletion

Add a `$schema` field to your `openclaw.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/elonnzhang/openclaw-json-schema/main/openclaw.schema.json",
  "gateway": {
    ...
  }
}
```

Or use a pinned Release URL for a specific version:

```json
{
  "$schema": "https://github.com/elonnzhang/openclaw-json-schema/releases/download/v2026.3.24/openclaw.schema.json"
}
```

Or configure in VS Code `settings.json`:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["**/openclaw.json"],
      "url": "https://raw.githubusercontent.com/YOUR_USERNAME/openclaw-json-schema/main/openclaw.schema.json"
    }
  ]
}
```

## How It Works

GitHub Actions runs daily at UTC 02:00:

1. Clones `openclaw/openclaw` source
2. Reads the zod version from `package.json` and installs it (no full `npm ci` needed)
3. Runs `scripts/extract-schema-ci.mjs --mode local` to extract the JSON Schema
4. Auto-commits and pushes if the schema has changed

## Manual Trigger

Click `Run workflow` on the Actions page. You can specify a git ref (branch or tag).

## Local Extraction

### Option 1: From a cloned source directory (recommended)

```bash
git clone --depth 1 https://github.com/openclaw/openclaw openclaw-src
cd openclaw-src && npm install --ignore-scripts && cd ..
node scripts/extract-schema-ci.mjs \
  --mode local \
  --src-dir ./openclaw-src/src \
  --zod-dir ./openclaw-src/node_modules \
  --output ./openclaw.schema.json
```

### Option 2: Download from GitHub (requires gh CLI)

```bash
node scripts/extract-schema-ci.mjs --mode gh --output ./openclaw.schema.json

# Specify a git ref
node scripts/extract-schema-ci.mjs --mode gh --ref v2026.3.24

# Compare against a previous schema
node scripts/extract-schema-ci.mjs --mode gh --diff ./old-schema.json
```

### Option 3: From local .d.ts files (offline, no network needed)

```bash
node scripts/extract-schema-d.ts.mjs --output ./openclaw.schema.json
```

## Scripts

| Script                            | Description                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `init-config.sh`                  | One-liner to inject `$schema` into `openclaw.json`, supports `--config` and `--v`                                              |
| `scripts/extract-schema-ci.mjs`   | Unified entry point, supports `--mode gh` (GitHub download) and `--mode local` (local source), works for both CI and local use |
| `scripts/extract-schema.mjs`      | GitHub source mode, same functionality as the CI script's gh mode, standalone                                                  |
| `scripts/extract-schema-d.ts.mjs` | Local `.d.ts` + TS Compiler API mode, fully offline, no gh CLI needed                                                          |

Originally from: https://github.com/Kaspre/my-openclaw-patches/blob/master/scripts/extract-schema.mjs
