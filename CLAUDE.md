# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Automated JSON Schema extraction for [OpenClaw](https://github.com/openclaw/openclaw) configuration files. OpenClaw doesn't publish a JSON Schema for `openclaw.json`; this repo bridges that gap by extracting it from OpenClaw's internal Zod definitions and publishing it via GitHub Actions on a daily schedule.

Output: `openclaw.schema.json` (~771 KB, 37 top-level properties covering all OpenClaw config sections).

## Running the Scripts

No `package.json` or build system — this is a standalone scripts repo. All scripts are Node.js ESM.

```bash
# CI extraction (unified script, supports gh + local modes)
node scripts/extract-schema-ci.mjs --mode local --src-dir ./openclaw-src/src --output openclaw.schema.json
node scripts/extract-schema-ci.mjs --mode gh --ref main --output openclaw.schema.json

# GitHub source + Zod mode (requires network + gh CLI)
node scripts/extract-schema.mjs [--output FILE] [--ref REF] [--diff OLD_SCHEMA] [--keep-tmp]

# Local .d.ts + TS Compiler API mode (offline, no gh needed)
node scripts/extract-schema-d.ts.mjs [--output FILE] [--dts-only] [--dts-output FILE]
```

**Requirements:** Node.js 20+, `gh` CLI (authenticated, for GitHub modes), `tsx` (`npm i -g tsx`), OpenClaw installed locally (provides Zod dependency).

## Architecture

Three extraction scripts, each taking a different approach to the same goal:

### `scripts/extract-schema.mjs` — Zod via GitHub download
Downloads Zod schema `.ts` sources from GitHub via `gh api`, post-processes them (strips `.superRefine()`, `.transform()`, `.refine()` via a balanced-parenthesis parser), stubs transitive dependencies, runs `OpenClawSchema.toJSONSchema()` via `tsx`.

### `scripts/extract-schema-ci.mjs` — Unified CI entry point
Supports `--mode gh` (same as above) and `--mode local` (reads from pre-cloned source directory). Used by GitHub Actions. Creates `node_modules` symlink in WORK_DIR for ESM resolution. Supports `--diff` for schema change comparison.

### `scripts/extract-schema-d.ts.mjs` — TypeScript Compiler API
Completely different approach: parses `.d.ts` files from the installed OpenClaw using `ts.createProgram` / `ts.getTypeChecker`, walks the AST to build JSON Schema. Works offline but less precise (simplified `Pick`/`Omit` handling, depth limit of 10).

### Key shared pattern: `stripBalancedCall()`
Custom balanced-parenthesis parser (in scripts 1 & 2) that removes Zod runtime method calls from source. Handles nested parens and quoted strings. Critical because `.superRefine()`, `.transform()`, `.refine()` contain runtime logic that breaks `tsx` execution and isn't representable in JSON Schema.

## CI/CD

`.github/workflows/extract-schema.yml` — runs daily at UTC 02:00 (Beijing 10:00):
1. Checks out this repo + `openclaw/openclaw` source
2. Reads zod version from `package.json` and installs only zod (avoids full `npm ci` which fails on private deps)
3. Runs `extract-schema-ci.mjs --mode local`
4. Auto-commits if `openclaw.schema.json` changed

Manual trigger via `workflow_dispatch` with optional `ref` input.

## When Extraction Fails After OpenClaw Upgrade

Usually a new file was added to the import chain. Pattern:
1. Use `--keep-tmp` to inspect downloaded files
2. If the missing module only provides runtime validation (not schema shape) → add stub to `TRANSITIVE_STUBS`
3. If it provides type exports needed for compilation → add to `UTIL_FILES`
