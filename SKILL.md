---
name: extract-openclaw-schema
description: Extracts OpenClaw's JSON Schema from Zod source via toJSONSchema(). Supports GitHub download, local clone, and offline .d.ts modes. Daily CI auto-update.
version: 1.0.0
metadata: {}
---

# OpenClaw Config Schema Extraction

## Overview

OpenClaw uses Zod definitions for its config schema but does not publish a JSON Schema file. This project extracts it so editors can provide autocompletion and validation for `openclaw.json`.

- Upstream issue: openclaw/openclaw#22278
- Output: ~771 KB JSON Schema, 37 top-level properties, 3218 schema paths

## Extraction Pipeline

```
Zod source (.ts) → strip runtime calls → stub transitive deps → tsx → toJSONSchema() → openclaw.schema.json
```

1. Obtain `src/config/zod-schema*.ts` (17 files) + utility deps (15 files)
2. Post-process via `postProcessSchemaSource()` (`scripts/lib.mjs`):
   - Strip `.superRefine()` / `.transform()` / `.refine()` (runtime-only, not representable in JSON Schema)
   - Remove `inbound-path-policy` imports (deep dep chain, stubbed)
3. Write stubs for transitive deps (`TRANSITIVE_STUBS` with `force: true`)
4. Run harness via `tsx` → `OpenClawSchema.toJSONSchema()` (Zod v4 built-in)
5. Output JSON Schema with title, description, timestamp

## Scripts

| Script                            | Mode                              | Requirements                                      |
| --------------------------------- | --------------------------------- | ------------------------------------------------- |
| `scripts/extract-schema-ci.mjs`   | `--mode gh` or `--mode local`     | tsx; gh CLI (gh mode); OpenClaw install (gh mode) |
| `scripts/extract-schema.mjs`      | GitHub download only              | tsx, gh CLI, OpenClaw install                     |
| `scripts/extract-schema-d.ts.mjs` | Offline (.d.ts + TS Compiler API) | tsx, TypeScript, OpenClaw install                 |
| `scripts/lib.mjs`                 | Shared utilities                  | —                                                 |
| `scripts/test.mjs`                | Unit + integration tests          | Node.js 20+                                       |

### extract-schema-ci.mjs (recommended)

Unified entry point for both CI and local use.

```bash
# Local mode — from cloned source (CI uses this)
node scripts/extract-schema-ci.mjs \
  --mode local \
  --src-dir ./openclaw-src/src \
  --zod-dir ./openclaw-src/node_modules \
  --output ./openclaw.schema.json

# GitHub mode — download source via gh CLI
node scripts/extract-schema-ci.mjs --mode gh --output ./openclaw.schema.json

# With diff comparison
node scripts/extract-schema-ci.mjs --mode gh --diff ./old-schema.json

# Specify git ref
node scripts/extract-schema-ci.mjs --mode gh --ref v2026.3.24

# Debug: keep temp files
node scripts/extract-schema-ci.mjs --mode gh --keep-tmp
```

### extract-schema.mjs

Standalone GitHub download mode. Same pipeline as `--mode gh` above.

```bash
node scripts/extract-schema.mjs [--output FILE] [--ref REF] [--diff OLD] [--keep-tmp]
```

### extract-schema-d.ts.mjs

Offline mode using TypeScript Compiler API to parse `.d.ts` type definitions.

```bash
node scripts/extract-schema-d.ts.mjs [--output FILE] [--dts-only] [--dts-output FILE]
```

## Testing

```bash
node --test scripts/test.mjs
```

- **Unit tests** (24): `stripBalancedCall`, `countPaths`, `postProcessSchemaSource`
- **Integration tests** (7): validates `openclaw.schema.json` structure, property count, file size. Skips gracefully when absent.

CI runs tests on push/PR via `.github/workflows/test.yml`.

## CI/CD

### Daily schema extraction (`.github/workflows/extract-schema.yml`)

Runs UTC 02:00 daily + manual `workflow_dispatch`:

1. Checkout this repo + `openclaw/openclaw` source
2. Install zod only (reads version from `package.json`, avoids full `npm ci`)
3. Run `extract-schema-ci.mjs --mode local`
4. Auto-commit + push if `openclaw.schema.json` changed

### Test workflow (`.github/workflows/test.yml`)

Runs on push/PR when `scripts/**` changes. Unit tests only (no extraction).

## VS Code Setup

**Option 1** — `$schema` in `openclaw.json`:

```json
{ "$schema": "https://raw.githubusercontent.com/YOUR_USERNAME/openclaw-schema/main/openclaw.schema.json" }
```

**Option 2** — VS Code `settings.json`:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["**/openclaw.json"],
      "url": "https://raw.githubusercontent.com/YOUR_USERNAME/openclaw-schema/main/openclaw.schema.json"
    }
  ]
}
```

Provides: enum dropdowns, type validation, required/optional hints, nested autocompletion for all 37 sections.

## Troubleshooting

| Symptom                                | Fix                                                                   |
| -------------------------------------- | --------------------------------------------------------------------- |
| `Cannot find module '../foo/bar.js'`   | Add to `UTIL_FILES` (need types) or `TRANSITIVE_STUBS` (runtime-only) |
| `gh` auth error                        | `gh auth login`                                                       |
| `tsx` not found                        | `npm install -g tsx`                                                  |
| Schema outdated after OpenClaw upgrade | Re-run extraction; use `--keep-tmp` if it fails                       |

### Adding new missing modules

When a new OpenClaw version adds imports:

1. Determine if the module provides **schema shape** (type exports) → add to `UTIL_FILES`
2. Or only **runtime validation** (used in stripped `.refine()` etc.) → add stub to `TRANSITIVE_STUBS` with `force: true`

Example: `inbound-path-policy.ts` only exports `isValidInboundPathRootPattern` used in `.refine()` calls that get stripped. It's downloaded into `UTIL_FILES` but force-overridden by a stub in `TRANSITIVE_STUBS`.
