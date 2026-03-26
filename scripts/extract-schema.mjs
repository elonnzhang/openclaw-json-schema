#!/usr/bin/env -S node --input-type=module
// 也可用 bun 运行: bun extract-schema.mjs
/**
 * Extract OpenClawSchema from OpenClaw GitHub source and convert to JSON Schema.
 *
 * Usage:
 *   node extract-schema.mjs [--output /path/to/schema.json] [--diff /path/to/old-schema.json] [--ref main]
 *
 * Environment variables:
 *   SCHEMA_OUTPUT   — Output path (default: ~/.openclaw/workspace/docs/config-schema.json)
 *   OPENCLAW_DIR    — OpenClaw install dir for Zod dependency (default: auto-detect)
 *
 * Strategy:
 *   1. Download zod-schema source files + utility deps from GitHub
 *   2. Generate a harness that imports OpenClawSchema and calls toJSONSchema()
 *   3. Run via tsx (TypeScript execute) using OpenClaw's bundled Zod
 *   4. Optionally diff against a previous schema
 *
 * Requirements:
 *   - gh CLI (authenticated)
 *   - tsx (npx tsx)
 *   - OpenClaw installed (for Zod dependency)
 *
 * Caveats:
 *   - Depends on OpenClaw's internal source structure. If files are renamed or
 *     imports change, the download list may need updating.
 *   - .superRefine() / .transform() / .refine() calls contain runtime validation
 *     that can't be represented in JSON Schema — they are stripped automatically.
 *   - Tested against v2026.3.8, v2026.3.13, v2026.3.24. YMMV on future versions.
 *
 * Known fixes applied (v2026.3.24+):
 *   - `media/inbound-path-policy.ts` was added to UTIL_FILES but pulls in a deep
 *     dependency chain: routing/account-lookup → routing/account-id → infra/prototype-keys
 *     Fix: stub out inbound-path-policy.ts directly (it only exports isValidInboundPathRootPattern
 *     which is used in .refine() calls that get stripped anyway).
 *   - Added routing/ and channels/ and sessions/ directories + stubs for transitive deps.
 *   - Removed inbound-path-policy import from zod-schema files in post-process step.
 *
 * Source: https://github.com/Kaspre/my-openclaw-patches/blob/master/scripts/extract-schema.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { postProcessSchemaSource, countPaths } from "./lib.mjs";

// ── CLI args ───────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { ref: "main" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) opts.output = args[++i];
    else if (args[i] === "--diff" && args[i + 1]) opts.diff = args[++i];
    else if (args[i] === "--ref" && args[i + 1]) opts.ref = args[++i];
    else if (args[i] === "--openclaw-dir" && args[i + 1]) opts.openclawDir = args[++i];
    else if (args[i] === "--src-dir" && args[i + 1]) opts.srcDir = args[++i];
    else if (args[i] === "--keep-tmp") opts.keepTmp = true;
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`Usage: node extract-schema.mjs [options]
  --output FILE       Output path (default: auto-versioned in workspace)
  --diff OLD_SCHEMA   Compare against previous schema and show changes
  --ref REF           Git ref to fetch from (default: main). Use a tag like v2026.3.13.
  --src-dir DIR       Local openclaw source root (skips gh download, for CI use)
  --openclaw-dir DIR  OpenClaw install dir (for Zod). Auto-detected if omitted.
  --keep-tmp          Don't delete temp directory after extraction
  --help              Show this help`);
      process.exit(0);
    }
  }
  return opts;
}

const opts = parseArgs();
// OUTPUT_FILE 在检测到版本号后确定（带版本号），可被 --output 覆盖
let OUTPUT_FILE = opts.output || null;

// ── Locate OpenClaw (for Zod) ──────────────────────────────────────────────

function findOpenClawDir() {
  if (opts.openclawDir) return opts.openclawDir;
  if (process.env.OPENCLAW_DIR) return process.env.OPENCLAW_DIR;
  try {
    const bin = execSync("which openclaw", { encoding: "utf8" }).trim();
    const resolved = execSync(`readlink -f "${bin}"`, { encoding: "utf8" }).trim();
    let dir = dirname(resolved);
    for (let i = 0; i < 5; i++) {
      if (existsSync(join(dir, "package.json"))) {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg.name === "openclaw") return dir;
      }
      dir = dirname(dir);
    }
  } catch {
    /* ignore */
  }
  console.error("ERROR: Could not find OpenClaw. Use --openclaw-dir or set OPENCLAW_DIR.");
  process.exit(1);
}

const OPENCLAW_DIR = opts.srcDir ? null : findOpenClawDir();
let ocVersion = "unknown";
try {
  // local 模式：从源码 package.json 读版本；gh 模式：从本机安装读
  const pkgPath = opts.srcDir
    ? join(opts.srcDir, "package.json")
    : join(OPENCLAW_DIR, "package.json");
  ocVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version || "unknown";
} catch { /* ignore */ }

if (opts.srcDir) {
  console.log(`Source dir: ${opts.srcDir}`);
} else {
  console.log(`OpenClaw dir: ${OPENCLAW_DIR}`);
}
console.log(`OpenClaw version: ${ocVersion}`);
console.log(`Git ref: ${opts.ref}`);

// 确定输出路径（带版本号）
if (!OUTPUT_FILE) {
  OUTPUT_FILE = process.env.SCHEMA_OUTPUT || join(homedir(), `.openclaw/workspace/openclaw.${ocVersion}.schema.json`);
}
console.log(`Output: ${OUTPUT_FILE}`);

// ── Files to download ──────────────────────────────────────────────────────

// Schema files (src/config/)
const SCHEMA_FILES = [
  "zod-schema.ts",
  "zod-schema.core.ts",
  "zod-schema.agents.ts",
  "zod-schema.agent-runtime.ts",
  "zod-schema.agent-defaults.ts",
  "zod-schema.agent-model.ts",
  "zod-schema.allowdeny.ts",
  "zod-schema.approvals.ts",
  "zod-schema.channels.ts",
  "zod-schema.hooks.ts",
  "zod-schema.installs.ts",
  "zod-schema.providers.ts",
  "zod-schema.providers-core.ts",
  "zod-schema.providers-whatsapp.ts",
  "zod-schema.secret-input-validation.ts",
  "zod-schema.sensitive.ts",
  "zod-schema.session.ts",
];

// Utility dependencies (need stubs or actual files)
const UTIL_FILES = [
  { src: "src/config/types.secrets.ts", dest: "config/types.secrets.ts" },
  { src: "src/config/types.models.ts", dest: "config/types.models.ts" },
  { src: "src/config/byte-size.ts", dest: "config/byte-size.ts" },
  { src: "src/config/discord-preview-streaming.ts", dest: "config/discord-preview-streaming.ts" },
  { src: "src/config/telegram-custom-commands.ts", dest: "config/telegram-custom-commands.ts" },
  { src: "src/cli/parse-bytes.ts", dest: "cli/parse-bytes.ts" },
  { src: "src/cli/parse-duration.ts", dest: "cli/parse-duration.ts" },
  { src: "src/infra/exec-safety.ts", dest: "infra/exec-safety.ts" },
  { src: "src/infra/scp-host.ts", dest: "infra/scp-host.ts" },
  { src: "src/secrets/ref-contract.ts", dest: "secrets/ref-contract.ts" },
  { src: "src/agents/sandbox/network-mode.ts", dest: "agents/sandbox/network-mode.ts" },
  { src: "src/media/inbound-path-policy.ts", dest: "media/inbound-path-policy.ts" },
  { src: "src/routing/account-lookup.ts", dest: "routing/account-lookup.ts" },
  { src: "src/routing/session-key.ts", dest: "routing/session-key.ts" },
  { src: "src/routing/account-id.ts", dest: "routing/account-id.ts" },
];

// ── Download from GitHub ───────────────────────────────────────────────────

const WORK_DIR = join(tmpdir(), `openclaw-schema-extract-${Date.now()}`);
mkdirSync(join(WORK_DIR, "config"), { recursive: true });
mkdirSync(join(WORK_DIR, "cli"), { recursive: true });
mkdirSync(join(WORK_DIR, "infra"), { recursive: true });
mkdirSync(join(WORK_DIR, "agents/sandbox"), { recursive: true });
mkdirSync(join(WORK_DIR, "media"), { recursive: true });
mkdirSync(join(WORK_DIR, "secrets"), { recursive: true });
mkdirSync(join(WORK_DIR, "routing"), { recursive: true });
mkdirSync(join(WORK_DIR, "channels"), { recursive: true });
mkdirSync(join(WORK_DIR, "sessions"), { recursive: true });

console.log(`\nWork dir: ${WORK_DIR}`);
console.log(opts.srcDir ? "Copying source files (local mode)..." : "Downloading source files...");

// ── 获取源文件（local 模式 cp，gh 模式下载）─────────────────────────────────

function downloadFile(repoPath, localPath) {
  const fullLocal = join(WORK_DIR, localPath);
  if (opts.srcDir) {
    // local 模式：从本地源码目录复制
    const srcPath = join(opts.srcDir, repoPath);
    if (existsSync(srcPath)) {
      mkdirSync(dirname(fullLocal), { recursive: true });
      copyFileSync(srcPath, fullLocal);
      return true;
    }
    console.warn(`  WARN: Not found locally: ${srcPath}`);
    return false;
  }
  try {
    const content = execSync(
      `gh api "repos/openclaw/openclaw/contents/${repoPath}?ref=${opts.ref}" -H "Accept: application/vnd.github.raw+json"`,
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    writeFileSync(fullLocal, content);
    return true;
  } catch (e) {
    console.warn(`  WARN: Could not download ${repoPath}: ${e.message?.split("\n")[0]}`);
    return false;
  }
}

// Download schema files
let downloaded = 0;
for (const f of SCHEMA_FILES) {
  if (downloadFile(`src/config/${f}`, `config/${f}`)) downloaded++;
}
console.log(`  Schema files: ${downloaded}/${SCHEMA_FILES.length}`);

// Download utility files
let utilDownloaded = 0;
for (const { src, dest } of UTIL_FILES) {
  if (downloadFile(src, dest)) utilDownloaded++;
}
console.log(`  Utility files: ${utilDownloaded}/${UTIL_FILES.length}`);

// ── Post-process: strip superRefine and transform ──────────────────────────

// Strip superRefine and transform from all schema files
for (const f of SCHEMA_FILES) {
  const fp = join(WORK_DIR, "config", f);
  if (!existsSync(fp)) continue;
  writeFileSync(fp, postProcessSchemaSource(readFileSync(fp, "utf8")));
}

// ── Create stub files for missing dependencies ─────────────────────────────

// Some utility files may import things we don't have. Create minimal stubs
// for any that failed to download.
for (const { dest } of UTIL_FILES) {
  const fp = join(WORK_DIR, dest);
  if (!existsSync(fp)) {
    // Write a stub that exports empty objects/functions
    console.warn(`  Creating stub for missing: ${dest}`);
    writeFileSync(fp, `// Auto-generated stub\nexport default {};\n`);
  }
}

// Create stubs for transitive deps of routing files
const TRANSITIVE_STUBS = [
  { dest: "channels/chat-type.ts", content: "export type ChatType = string;\n" },
  { dest: "sessions/session-key-utils.ts", content: `export type ParsedAgentSessionKey = any;\nexport function parseAgentSessionKey(key: string): ParsedAgentSessionKey { return {}; }\n` },
  // Override inbound-path-policy with a stub to avoid its deep dep chain (routing/infra)
  // The function it exports is only used in .refine() which we strip anyway
  { dest: "media/inbound-path-policy.ts", content: `export function isValidInboundPathRootPattern(v: string): boolean { return true; }\nexport const DEFAULT_IMESSAGE_ATTACHMENT_ROOTS: readonly string[] = [];\n`, force: true },
];
for (const { dest, content, force } of TRANSITIVE_STUBS) {
  const fp = join(WORK_DIR, dest);
  if (!existsSync(fp) || force) {
    writeFileSync(fp, content);
  }
}

// ── Fix import paths ───────────────────────────────────────────────────────

// The schema files use .js extensions in imports but we have .ts files
// tsx handles this automatically, but we need to ensure paths resolve correctly

// ── Generate harness ───────────────────────────────────────────────────────

const harnessCode = `
import { OpenClawSchema } from "./config/zod-schema.js";
import { writeFileSync } from "node:fs";

const OUTPUT = ${JSON.stringify(OUTPUT_FILE)};
const OC_VERSION = ${JSON.stringify(ocVersion)};

try {
  let jsonSchema;
  try {
    jsonSchema = OpenClawSchema.toJSONSchema({ target: "draft-2020-12" });
  } catch {
    jsonSchema = OpenClawSchema.toJSONSchema({});
  }

  jsonSchema.title = "OpenClaw Configuration";
  const generatedAt = new Date().toISOString();
  jsonSchema.description = "JSON Schema for openclaw.json — OpenClaw v" + OC_VERSION + ". Generated: " + generatedAt + ". VSCode tip: set json.schemas to validate openclaw.json against this file.";

  const output = JSON.stringify(jsonSchema, null, 2);
  writeFileSync(OUTPUT, output);

  const topProps = jsonSchema.properties ? Object.keys(jsonSchema.properties) : [];
  const sizeKB = (Buffer.byteLength(output) / 1024).toFixed(1);

  console.log("Schema extracted successfully!");
  console.log("Output: " + OUTPUT);
  console.log("File size: " + sizeKB + " KB");
  console.log("Top-level properties (" + topProps.length + "): " + topProps.join(", "));

  // Output property count as machine-readable for diffing
  console.log("__PROPS_COUNT__:" + topProps.length);
} catch (err) {
  console.error("Extraction failed:", err.message);
  if (err.stack) console.error(err.stack.split("\\n").slice(0, 8).join("\\n"));
  process.exit(1);
}
`;

writeFileSync(join(WORK_DIR, "harness.ts"), harnessCode);

// ── Run extraction via tsx ─────────────────────────────────────────────────

console.log("\nRunning extraction via tsx...");

// tsx needs to find zod — use NODE_PATH to point to the right node_modules
const zodPath = opts.srcDir
  ? join(opts.srcDir, "node_modules")   // local 模式：srcDir/node_modules
  : join(OPENCLAW_DIR, "node_modules"); // gh 模式：本机 openclaw/node_modules
const env = { ...process.env, NODE_PATH: zodPath };

try {
  const result = execSync(`npx tsx "${join(WORK_DIR, "harness.ts")}"`, {
    encoding: "utf8",
    env,
    cwd: WORK_DIR,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60000,
  });
  console.log(result);
} catch (err) {
  console.error("\nExtraction FAILED.");
  if (err.stderr) console.error(err.stderr.slice(0, 2000));
  if (err.stdout) console.log(err.stdout.slice(0, 1000));
  console.error("\nThis may mean the source structure has changed.");
  console.error("Check the downloaded files in:", WORK_DIR);
  if (!opts.keepTmp) {
    console.error("(Re-run with --keep-tmp to preserve temp files for debugging)");
  }
  if (!opts.keepTmp) rmSync(WORK_DIR, { recursive: true, force: true });
  process.exit(1);
}

// ── Diff against previous schema ───────────────────────────────────────────

if (opts.diff && existsSync(opts.diff) && existsSync(OUTPUT_FILE)) {
  console.log(`\n--- Schema diff vs ${opts.diff} ---`);
  try {
    const oldSchema = JSON.parse(readFileSync(opts.diff, "utf8"));
    const newSchema = JSON.parse(readFileSync(OUTPUT_FILE, "utf8"));

    const oldProps = new Set(Object.keys(oldSchema.properties || {}));
    const newProps = new Set(Object.keys(newSchema.properties || {}));
    const added = [...newProps].filter((p) => !oldProps.has(p));
    const removed = [...oldProps].filter((p) => !newProps.has(p));

    if (added.length) console.log(`  ADDED top-level: ${added.join(", ")}`);
    if (removed.length) console.log(`  REMOVED top-level: ${removed.join(", ")}`);
    if (!added.length && !removed.length) console.log("  No top-level property changes.");

    const oldPaths = countPaths(oldSchema);
    const newPaths = countPaths(newSchema);
    const addedPaths = [...newPaths].filter((p) => !oldPaths.has(p));
    const removedPaths = [...oldPaths].filter((p) => !newPaths.has(p));
    const delta = newPaths.size - oldPaths.size;

    console.log(`  Total schema paths: ${oldPaths.size} → ${newPaths.size} (${delta >= 0 ? "+" : ""}${delta})`);

    if (addedPaths.length > 0 && addedPaths.length <= 30) {
      for (const p of addedPaths) console.log(`    + ${p}`);
    } else if (addedPaths.length > 30) {
      console.log(`    ${addedPaths.length} paths added`);
    }
    if (removedPaths.length > 0 && removedPaths.length <= 30) {
      for (const p of removedPaths) console.log(`    - ${p}`);
    } else if (removedPaths.length > 30) {
      console.log(`    ${removedPaths.length} paths removed`);
    }
  } catch (e) {
    console.warn(`  Diff failed: ${e.message}`);
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────

if (!opts.keepTmp) {
  rmSync(WORK_DIR, { recursive: true, force: true });
} else {
  console.log(`\nTemp files preserved at: ${WORK_DIR}`);
}

console.log("\nDone.");
