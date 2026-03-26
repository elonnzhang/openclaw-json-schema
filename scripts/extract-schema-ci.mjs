#!/usr/bin/env node
// 也可用 bun 运行: bun extract-schema-ci.mjs
/**
 * extract-schema-ci.mjs — 统一入口，支持两种提取模式
 *
 * --mode gh    (默认) 通过 gh CLI 从 GitHub 下载源码，本机使用
 * --mode local         从已 clone 的本地源码目录读取，适合 CI/无网络
 *
 * 关键设计：在 WORK_DIR 下创建 node_modules 软链接，让 tsx ESM 正确 resolve zod
 *
 * 来自 extract-schema.mjs 的改造，适用于 GitHub Actions 每日自动生成。
 * 相比原版新增：
 *   - --mode local 从 CI 已 clone 的源码目录读取（无需 gh CLI）
 *   - --diff 支持，CI 日志可展示 schema 变更摘要
 *   - --src-dir / --zod-dir 选项
 *   - node_modules 软链接解决 ESM resolve 问题
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  copyFileSync, rmSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { postProcessSchemaSource, countPaths } from "./lib.mjs";

// ── CLI args ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { mode: "gh", ref: "main" };
  for (let i = 0; i < args.length; i++) {
    if      (args[i] === "--mode"         && args[i+1]) opts.mode        = args[++i];
    else if (args[i] === "--output"       && args[i+1]) opts.output       = args[++i];
    else if (args[i] === "--ref"          && args[i+1]) opts.ref          = args[++i];
    else if (args[i] === "--diff"         && args[i+1]) opts.diff         = args[++i];
    else if (args[i] === "--src-dir"      && args[i+1]) opts.srcDir       = args[++i];
    else if (args[i] === "--zod-dir"      && args[i+1]) opts.zodDir       = args[++i];
    else if (args[i] === "--openclaw-dir" && args[i+1]) opts.openclawDir  = args[++i];
    else if (args[i] === "--keep-tmp")  opts.keepTmp = true;
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`用法: node extract-schema-ci.mjs [选项]

模式:
  --mode gh          通过 gh CLI 从 GitHub 下载源码（默认，本机使用）
  --mode local       从本地已 clone 的源码目录读取（CI 推荐，无需 gh）

选项:
  --output FILE      JSON Schema 输出路径（默认: 自动带版本号）
  --diff OLD_SCHEMA  与旧版 schema 比较并输出变更摘要
  --ref REF          git ref/tag
  --src-dir DIR      local 模式：openclaw 源码的 src/ 目录（必填）
  --zod-dir DIR      Zod node_modules 目录（默认: src-dir/../node_modules）
  --openclaw-dir DIR 本机 OpenClaw 安装目录（gh 模式自动检测）
  --keep-tmp         保留临时文件用于调试
  --help             显示帮助`);
      process.exit(0);
    }
  }
  return opts;
}

const opts = parseArgs();

// ── 需要处理的文件 ────────────────────────────────────────────────────────

const SCHEMA_FILES = [
  "zod-schema.ts", "zod-schema.core.ts", "zod-schema.agents.ts",
  "zod-schema.agent-runtime.ts", "zod-schema.agent-defaults.ts",
  "zod-schema.agent-model.ts", "zod-schema.allowdeny.ts",
  "zod-schema.approvals.ts", "zod-schema.channels.ts", "zod-schema.hooks.ts",
  "zod-schema.installs.ts", "zod-schema.providers.ts",
  "zod-schema.providers-core.ts", "zod-schema.providers-whatsapp.ts",
  "zod-schema.secret-input-validation.ts", "zod-schema.sensitive.ts",
  "zod-schema.session.ts",
];

const UTIL_FILES = [
  { src: "src/config/types.secrets.ts",             dest: "src/config/types.secrets.ts" },
  { src: "src/config/types.models.ts",              dest: "src/config/types.models.ts" },
  { src: "src/config/byte-size.ts",                 dest: "src/config/byte-size.ts" },
  { src: "src/config/discord-preview-streaming.ts", dest: "src/config/discord-preview-streaming.ts" },
  { src: "src/config/telegram-custom-commands.ts",  dest: "src/config/telegram-custom-commands.ts" },
  { src: "src/cli/parse-bytes.ts",                  dest: "src/cli/parse-bytes.ts" },
  { src: "src/cli/parse-duration.ts",               dest: "src/cli/parse-duration.ts" },
  { src: "src/infra/exec-safety.ts",                dest: "src/infra/exec-safety.ts" },
  { src: "src/infra/scp-host.ts",                   dest: "src/infra/scp-host.ts" },
  { src: "src/secrets/ref-contract.ts",             dest: "src/secrets/ref-contract.ts" },
  { src: "src/agents/sandbox/network-mode.ts",      dest: "src/agents/sandbox/network-mode.ts" },
  { src: "src/media/inbound-path-policy.ts",        dest: "src/media/inbound-path-policy.ts" },
  { src: "src/routing/account-lookup.ts",           dest: "src/routing/account-lookup.ts" },
  { src: "src/routing/account-id.ts",               dest: "src/routing/account-id.ts" },
  { src: "src/routing/session-key.ts",              dest: "src/routing/session-key.ts" },
];

const TRANSITIVE_STUBS = [
  // inbound-path-policy 虽然下载了，但必须用 stub 覆盖（它的深层依赖链会拉入 routing/infra）
  // 它导出的 isValidInboundPathRootPattern 只在 .refine() 中使用，而 refine 会被 strip
  { dest: "src/media/inbound-path-policy.ts",  content: `export function isValidInboundPathRootPattern(v: string): boolean { return true; }\nexport const DEFAULT_IMESSAGE_ATTACHMENT_ROOTS: readonly string[] = [];\n`, force: true },
  { dest: "src/channels/chat-type.ts",         content: `export type ChatType = string;\n` },
  { dest: "src/sessions/session-key-utils.ts", content: `export type ParsedAgentSessionKey = any;\nexport function parseAgentSessionKey(key: string): ParsedAgentSessionKey { return {}; }\n` },
];

// ── 获取 OpenClaw 信息 & zod 路径 ────────────────────────────────────────

function findOpenClawDir() {
  if (opts.openclawDir) return opts.openclawDir;
  if (process.env.OPENCLAW_DIR) return process.env.OPENCLAW_DIR;
  try {
    const bin = execSync("which openclaw", { encoding: "utf8" }).trim();
    const resolved = execSync(`readlink -f "${bin}" 2>/dev/null || realpath "${bin}"`, { encoding: "utf8" }).trim();
    let dir = dirname(resolved);
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, "package.json"))) {
        try { if (JSON.parse(readFileSync(join(dir,"package.json"),"utf8")).name === "openclaw") return dir; } catch {}
      }
      dir = dirname(dir);
    }
  } catch {}
  for (const p of ["/opt/homebrew/lib/node_modules/openclaw","/usr/local/lib/node_modules/openclaw"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

let ocVersion = "unknown";
let zodNodeModules; // 绝对路径
let openclawSrcRoot; // WORK_DIR 的父目录，必须包含 node_modules

if (opts.mode === "local") {
  if (!opts.srcDir) { console.error("❌ --mode local 需要指定 --src-dir"); process.exit(1); }
  const absSrcDir = resolve(opts.srcDir);
  if (!existsSync(absSrcDir)) { console.error(`❌ 源码目录不存在: ${absSrcDir}`); process.exit(1); }

  // zod 路径（openclaw-src/node_modules）
  zodNodeModules = resolve(opts.zodDir || join(absSrcDir, "../node_modules"));
  openclawSrcRoot = resolve(join(zodNodeModules, "..")); // = openclaw-src 根

  for (const p of [join(openclawSrcRoot,"package.json"), join(absSrcDir,"../package.json")]) {
    if (existsSync(p)) { try { ocVersion = JSON.parse(readFileSync(p,"utf8")).version || opts.ref; } catch {} break; }
  }
  if (ocVersion === "unknown") ocVersion = opts.ref;

  console.log(`Mode:    local`);
  console.log(`Src dir: ${absSrcDir}`);
  console.log(`Zod:     ${zodNodeModules}`);
  console.log(`Root:    ${openclawSrcRoot}`);
  console.log(`Version: ${ocVersion}`);
} else {
  const openclawDir = findOpenClawDir();
  if (!openclawDir) { console.error("❌ 找不到 OpenClaw，请用 --openclaw-dir 指定"); process.exit(1); }
  try { ocVersion = JSON.parse(readFileSync(join(openclawDir,"package.json"),"utf8")).version || "unknown"; } catch {}
  zodNodeModules = resolve(opts.zodDir || join(openclawDir,"node_modules"));
  openclawSrcRoot = null; // gh 模式用 tmpdir

  console.log(`Mode:         gh`);
  console.log(`OpenClaw dir: ${openclawDir}`);
  console.log(`Version:      ${ocVersion}`);
  console.log(`Git ref:      ${opts.ref}`);
}

// ── WORK_DIR：必须与 node_modules 同级！ ─────────────────────────────────
// local 模式：在 openclaw-src 根目录下创建子目录（与 node_modules 同级）
// gh 模式：在 tmpdir（本机 openclaw 的 NODE_PATH 可生效）
const WORK_DIR = opts.mode === "local"
  ? join(openclawSrcRoot, `_ocschema_${Date.now()}`)
  : join(tmpdir(), `openclaw-schema-extract-${Date.now()}`);

for (const dir of [
  "src/config","src/cli","src/infra","src/agents/sandbox",
  "src/media","src/secrets","src/routing","src/channels","src/sessions",
]) {
  mkdirSync(join(WORK_DIR, dir), { recursive: true });
}

const OUTPUT_FILE = resolve(opts.output
  || (opts.mode === "local"
      ? `./openclaw.${ocVersion}.schema.json`
      : join(homedir(), `.openclaw/workspace/openclaw.${ocVersion}.schema.json`)));

console.log(`\nWork dir: ${WORK_DIR}`);
console.log(`Output:   ${OUTPUT_FILE}`);

// ── 获取源文件 ────────────────────────────────────────────────────────────

if (opts.mode === "local") {
  const absSrcDir = resolve(opts.srcDir);
  const srcRoot = resolve(join(absSrcDir, ".."));
  console.log("\nCopying source files...");

  let copied = 0;
  for (const f of SCHEMA_FILES) {
    const src = join(srcRoot, "src/config", f);
    const dest = join(WORK_DIR, "src/config", f);
    if (existsSync(src)) { copyFileSync(src, dest); copied++; }
    else console.warn(`  WARN: 不存在 src/config/${f}`);
  }
  console.log(`  Schema files: ${copied}/${SCHEMA_FILES.length}`);

  let utilCopied = 0;
  for (const { src, dest } of UTIL_FILES) {
    const srcPath = join(srcRoot, src);
    const destPath = join(WORK_DIR, dest);
    if (existsSync(srcPath)) { mkdirSync(dirname(destPath),{recursive:true}); copyFileSync(srcPath, destPath); utilCopied++; }
    else console.warn(`  WARN: 不存在 ${src}`);
  }
  console.log(`  Utility files: ${utilCopied}/${UTIL_FILES.length}`);

} else {
  // gh 模式
  console.log("\nDownloading source files...");

  function downloadFile(repoPath, localPath) {
    const fullLocal = join(WORK_DIR, localPath);
    try {
      const content = execSync(
        `gh api "repos/openclaw/openclaw/contents/${repoPath}?ref=${opts.ref}" -H "Accept: application/vnd.github.raw+json"`,
        { encoding: "utf8", maxBuffer: 1024 * 1024 }
      );
      writeFileSync(fullLocal, content);
      return true;
    } catch (e) {
      console.warn(`  WARN: 下载失败 ${repoPath}`);
      return false;
    }
  }

  let dl = 0;
  for (const f of SCHEMA_FILES) { if (downloadFile(`src/config/${f}`, `src/config/${f}`)) dl++; }
  console.log(`  Schema files: ${dl}/${SCHEMA_FILES.length}`);

  let udl = 0;
  for (const { src, dest } of UTIL_FILES) { if (downloadFile(src, dest)) udl++; }
  console.log(`  Utility files: ${udl}/${UTIL_FILES.length}`);
}

// ── Stubs ─────────────────────────────────────────────────────────────────

for (const { dest, content, force } of TRANSITIVE_STUBS) {
  const fp = join(WORK_DIR, dest);
  if (!existsSync(fp) || force) {
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, content);
  }
}
for (const { dest } of UTIL_FILES) {
  const fp = join(WORK_DIR, dest);
  if (!existsSync(fp)) {
    console.warn(`  Creating stub for missing: ${dest}`);
    writeFileSync(fp, `// Auto-generated stub\nexport default {};\n`);
  }
}

// ── Post-process ──────────────────────────────────────────────────────────

for (const f of SCHEMA_FILES) {
  const fp = join(WORK_DIR, "src/config", f);
  if (!existsSync(fp)) continue;
  writeFileSync(fp, postProcessSchemaSource(readFileSync(fp, "utf8")));
}

// ── Harness & 运行 ────────────────────────────────────────────────────────

// harness 放到 WORK_DIR 根（与 src/ 同级），import 用相对路径
const harnessCode = `
import { OpenClawSchema } from "./src/config/zod-schema.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const OUTPUT = ${JSON.stringify(OUTPUT_FILE)};
const OC_VERSION = ${JSON.stringify(ocVersion)};

try {
  let jsonSchema;
  try { jsonSchema = OpenClawSchema.toJSONSchema({ target: "draft-2020-12" }); }
  catch { jsonSchema = OpenClawSchema.toJSONSchema({}); }

  jsonSchema.title = "OpenClaw Configuration";
  const generatedAt = new Date().toISOString();
  jsonSchema.description = "JSON Schema for openclaw.json — OpenClaw v" + OC_VERSION + ". Generated: " + generatedAt + ". VSCode tip: set json.schemas to validate openclaw.json against this file.";

  mkdirSync(dirname(OUTPUT), { recursive: true });
  const output = JSON.stringify(jsonSchema, null, 2);
  writeFileSync(OUTPUT, output);

  const topProps = jsonSchema.properties ? Object.keys(jsonSchema.properties) : [];
  const sizeKB = (Buffer.byteLength(output) / 1024).toFixed(1);

  console.log("Schema extracted successfully!");
  console.log("Output: " + OUTPUT);
  console.log("File size: " + sizeKB + " KB");
  console.log("Top-level properties (" + topProps.length + "): " + topProps.join(", "));

  // Machine-readable output for CI parsing
  console.log("__VERSION__:" + OC_VERSION);
  console.log("__PROPS_COUNT__:" + topProps.length);
} catch (err) {
  console.error("Extraction failed:", err.message);
  if (err.stack) console.error(err.stack.split("\\n").slice(0, 8).join("\\n"));
  process.exit(1);
}
`;

const harnessPath = join(WORK_DIR, "harness.ts");
writeFileSync(harnessPath, harnessCode);
writeFileSync(join(WORK_DIR, "package.json"), JSON.stringify({ type: "module" }));

// 在 WORK_DIR 下安装 zod（从 zodNodeModules 复制，避免网络请求）
const workNodeModules = join(WORK_DIR, "node_modules");
const zodSrc = join(zodNodeModules, "zod");
const zodDest = join(workNodeModules, "zod");
if (!existsSync(zodDest) && existsSync(zodSrc)) {
  mkdirSync(workNodeModules, { recursive: true });
  execSync(`cp -r "${zodSrc}" "${zodDest}"`, { stdio: "pipe" });
  console.log(`  Copied zod to ${zodDest}`);
}

console.log("\nRunning extraction via tsx...");
const tsxBin = (() => { try { execSync("which tsx",{stdio:"pipe"}); return "tsx"; } catch { return "npx --yes tsx"; } })();

// node_modules 已软链接到 WORK_DIR，tsx ESM 能自然 resolve
const env = process.env;

try {
  const result = execSync(`${tsxBin} "${harnessPath}"`, {
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
    rmSync(WORK_DIR, { recursive: true, force: true });
  }
  process.exit(1);
}

// ── Diff against previous schema ─────────────────────────────────────────

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

// ── Cleanup ──────────────────────────────────────────────────────────────

if (!opts.keepTmp) {
  rmSync(WORK_DIR, { recursive: true, force: true });
} else {
  console.log(`\nTemp files preserved at: ${WORK_DIR}`);
}

console.log("\nDone.");
