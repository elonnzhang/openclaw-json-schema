#!/usr/bin/env -S node --input-type=module
// 也可用 bun 运行: bun extract-schema-d.ts.mjs
/**
 * extract-schema-d.ts.mjs
 *
 * 从 OpenClaw 安装目录的 .d.ts 类型文件提取 OpenClawConfig 并生成 JSON Schema。
 *
 * 步骤：
 *   1. 找到 OpenClaw 安装目录下所有 types.*.d.ts 文件
 *   2. 按顺序拼接成单个 .d.ts 文件（openclaw-schema.d.ts）
 *   3. 用 TypeScript Compiler API 解析类型，生成 JSON Schema
 *   4. 输出到 openclaw.schema.json
 *
 * 用法：
 *   node extract-schema-dts.mjs [--output /path/to/schema.json] [--dts-only] [--openclaw-dir DIR]
 *
 * 选项：
 *   --output FILE       JSON Schema 输出路径（默认：~/.openclaw/workspace/openclaw.schema.json）
 *   --dts-output FILE   合并后 .d.ts 输出路径（默认：~/.openclaw/workspace/openclaw-schema.d.ts）
 *   --dts-only          只生成 .d.ts，不转 JSON Schema
 *   --openclaw-dir DIR  OpenClaw 安装目录（默认自动检测）
 *   --ts-dir DIR        TypeScript 安装目录（默认自动检测）
 *   --help              显示帮助
 *
 * 依赖：
 *   - TypeScript（全局安装：npm i -g typescript，或本地 node_modules）
 *   - OpenClaw 已安装在本机
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

// ── CLI args ───────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) opts.output = args[++i];
    else if (args[i] === "--dts-output" && args[i + 1]) opts.dtsOutput = args[++i];
    else if (args[i] === "--openclaw-dir" && args[i + 1]) opts.openclawDir = args[++i];
    else if (args[i] === "--ts-dir" && args[i + 1]) opts.tsDir = args[++i];
    else if (args[i] === "--dts-only") opts.dtsOnly = true;
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`用法: node extract-schema-dts.mjs [选项]

选项:
  --output FILE       JSON Schema 输出路径（默认: ~/.openclaw/workspace/openclaw.schema.json）
  --dts-output FILE   合并后 .d.ts 输出路径（默认: ~/.openclaw/workspace/openclaw-schema.d.ts）
  --dts-only          只生成 .d.ts，不转 JSON Schema
  --openclaw-dir DIR  OpenClaw 安装目录（默认自动检测）
  --ts-dir DIR        TypeScript 安装目录（默认自动检测）
  --help              显示帮助`);
      process.exit(0);
    }
  }
  return opts;
}

const opts = parseArgs();
// 版本号在检测到 OpenClaw 后才能确定，先用占位，后面替换
let OUTPUT_FILE = opts.output || null; // 若未指定，稍后根据版本号生成
const DTS_OUTPUT = opts.dtsOutput || join(homedir(), ".openclaw/workspace/openclaw-schema.d.ts");

// ── 自动检测 OpenClaw 目录 ───────────────────────────────────────────────────

function findOpenClawDir() {
  if (opts.openclawDir) return opts.openclawDir;
  if (process.env.OPENCLAW_DIR) return process.env.OPENCLAW_DIR;
  try {
    const bin = execSync("which openclaw", { encoding: "utf8" }).trim();
    const resolved = execSync(`readlink -f "${bin}" 2>/dev/null || realpath "${bin}"`, { encoding: "utf8" }).trim();
    let dir = dirname(resolved);
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, "package.json"))) {
        try {
          const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
          if (pkg.name === "openclaw") return dir;
        } catch {}
      }
      dir = dirname(dir);
    }
  } catch {}
  const fallbacks = [
    "/opt/homebrew/lib/node_modules/openclaw",
    "/usr/local/lib/node_modules/openclaw",
  ];
  for (const p of fallbacks) if (existsSync(p)) return p;
  console.error("❌ 找不到 OpenClaw 安装目录，请用 --openclaw-dir 指定");
  process.exit(1);
}

// ── 自动检测 TypeScript 目录 ─────────────────────────────────────────────────

function findTypeScriptDir() {
  if (opts.tsDir) return opts.tsDir;
  const candidates = [
    "/opt/homebrew/lib/node_modules/typescript",
    "/usr/local/lib/node_modules/typescript",
    join(homedir(), ".npm/lib/node_modules/typescript"),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, "lib/typescript.js"))) return p;
  }
  // 尝试 require resolve
  try {
    const req = createRequire(import.meta.url);
    return dirname(dirname(req.resolve("typescript")));
  } catch {}
  console.error("❌ 找不到 TypeScript，请全局安装：npm i -g typescript");
  process.exit(1);
}

const OPENCLAW_DIR = findOpenClawDir();
const TYPES_DIR = join(OPENCLAW_DIR, "dist/plugin-sdk/src/config");
const TS_DIR = findTypeScriptDir();

let ocVersion = "unknown";
try {
  ocVersion = JSON.parse(readFileSync(join(OPENCLAW_DIR, "package.json"), "utf8")).version || "unknown";
} catch {}

console.log(`✅ OpenClaw 目录: ${OPENCLAW_DIR}`);
console.log(`✅ OpenClaw 版本: ${ocVersion}`);
console.log(`✅ TypeScript:    ${TS_DIR}`);

// 确定输出路径（带版本号）
if (!OUTPUT_FILE) {
  OUTPUT_FILE = join(homedir(), `.openclaw/workspace/openclaw.${ocVersion}.schema.json`);
}

console.log(`✅ 输出路径: ${OUTPUT_FILE}`);

if (!existsSync(TYPES_DIR)) {
  console.error(`❌ 类型文件目录不存在: ${TYPES_DIR}`);
  process.exit(1);
}

// ── 文件顺序 ─────────────────────────────────────────────────────────────────

const FILE_ORDER = [
  "types.base.d.ts",
  "types.auth.d.ts",
  "types.acp.d.ts",
  "types.agent-defaults.d.ts",
  "types.agents-shared.d.ts",
  "types.agents.d.ts",
  "types.approvals.d.ts",
  "types.browser.d.ts",
  "types.channel-messaging-common.d.ts",
  "types.channels.d.ts",
  "types.cli.d.ts",
  "types.cron.d.ts",
  "types.discord.d.ts",
  "types.gateway.d.ts",
  "types.googlechat.d.ts",
  "types.hooks.d.ts",
  "types.imessage.d.ts",
  "types.irc.d.ts",
  "types.mcp.d.ts",
  "types.memory.d.ts",
  "types.messages.d.ts",
  "types.models.d.ts",
  "types.msteams.d.ts",
  "types.node-host.d.ts",
  "types.plugins.d.ts",
  "types.queue.d.ts",
  "types.sandbox.d.ts",
  "types.secrets.d.ts",
  "types.signal.d.ts",
  "types.skills.d.ts",
  "types.slack.d.ts",
  "types.telegram.d.ts",
  "types.tools.d.ts",
  "types.tts.d.ts",
  "types.whatsapp.d.ts",
  "types.installs.d.ts",
  "types.openclaw.d.ts",
];

const allDtsFiles = readdirSync(TYPES_DIR)
  .filter(f => f.startsWith("types.") && f.endsWith(".d.ts"))
  .sort();

const unordered = allDtsFiles.filter(f => !FILE_ORDER.includes(f));
if (unordered.length > 0) {
  console.warn(`⚠️  新增文件（追加到末尾）: ${unordered.join(", ")}`);
}
const finalOrder = [...FILE_ORDER, ...unordered];

// ── Step 1: 合并 .d.ts ────────────────────────────────────────────────────

console.log("\n📄 Step 1: 合并 .d.ts 文件...");

let merged = `// OpenClaw Config Schema (合并类型文件)
// OpenClaw 版本: ${ocVersion}
// 生成时间: ${new Date().toISOString()}
// 源目录: ${TYPES_DIR}
// 注意：此文件由 extract-schema-dts.mjs 自动生成，请勿手动编辑
`;

let includedCount = 0;
for (const filename of finalOrder) {
  const filepath = join(TYPES_DIR, filename);
  if (!existsSync(filepath)) { console.warn(`  ⚠️  跳过（不存在）: ${filename}`); continue; }
  let content = readFileSync(filepath, "utf8");
  // 去掉 import 行
  content = content.replace(/^import\s+.*?;?\s*$/gm, "").trim();
  content = content.replace(/\n{3,}/g, "\n\n");
  if (!content) continue;
  merged += `\n// ${"=".repeat(60)}\n// ${filename}\n// ${"=".repeat(60)}\n\n${content}\n`;
  includedCount++;
}

mkdirSync(dirname(DTS_OUTPUT), { recursive: true });
writeFileSync(DTS_OUTPUT, merged);
console.log(`  ✅ 合并 ${includedCount} 个文件 → ${DTS_OUTPUT}`);
console.log(`  📏 ${(Buffer.byteLength(merged) / 1024).toFixed(1)} KB，${merged.split("\n").length} 行`);

if (opts.dtsOnly) {
  console.log("\n✅ 完成（--dts-only 模式）");
  process.exit(0);
}

// ── Step 2: 用 TS Compiler API 生成 JSON Schema ───────────────────────────

console.log("\n🔄 Step 2: 用 TypeScript Compiler API 解析类型...");

const req = createRequire(import.meta.url);
let ts;
try {
  ts = req(join(TS_DIR, "lib/typescript.js"));
} catch {
  try {
    ts = req("typescript");
  } catch {
    console.error("❌ 无法加载 TypeScript，请安装：npm i -g typescript");
    process.exit(1);
  }
}

// 创建 TypeScript program
const compilerOptions = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  strict: false,
  skipLibCheck: true,
  noResolve: true,
};

const host = ts.createCompilerHost(compilerOptions);
const program = ts.createProgram([DTS_OUTPUT], compilerOptions, host);
const checker = program.getTypeChecker();
const sourceFile = program.getSourceFile(DTS_OUTPUT);

if (!sourceFile) {
  console.error("❌ 无法解析源文件");
  process.exit(1);
}

// 收集所有类型定义
const typeMap = new Map(); // name → TypeAliasDeclaration

function collectTypes(node) {
  if (ts.isTypeAliasDeclaration(node)) {
    typeMap.set(node.name.text, node);
  }
  ts.forEachChild(node, collectTypes);
}
collectTypes(sourceFile);

console.log(`  ✅ 发现 ${typeMap.size} 个类型定义`);

// 获取 OpenClawConfig
if (!typeMap.has("OpenClawConfig")) {
  console.error("❌ 找不到 OpenClawConfig 类型");
  process.exit(1);
}

// ── JSON Schema 生成器 ─────────────────────────────────────────────────────

const definitions = {};
const processingStack = new Set();

function getJSDocComment(node) {
  const ranges = ts.getLeadingCommentRanges(sourceFile.getFullText(), node.getFullStart());
  if (!ranges) return undefined;
  for (const range of ranges) {
    if (range.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      const text = sourceFile.getFullText().slice(range.pos + 2, range.end - 2);
      // 去掉 * 前缀
      return text.split("\n").map(l => l.replace(/^\s*\*\s?/, "")).join(" ").trim();
    }
  }
  return undefined;
}

function typeNodeToSchema(typeNode, depth = 0) {
  if (!typeNode || depth > 10) return {};

  if (ts.isParenthesizedTypeNode(typeNode)) {
    return typeNodeToSchema(typeNode.type, depth);
  }

  // string, number, boolean, null, undefined, any, unknown
  if (ts.isLiteralTypeNode(typeNode)) {
    const lit = typeNode.literal;
    if (ts.isStringLiteral(lit)) return { type: "string", const: lit.text };
    if (ts.isNumericLiteral(lit)) return { type: "number", const: Number(lit.text) };
    if (lit.kind === ts.SyntaxKind.TrueKeyword) return { type: "boolean", const: true };
    if (lit.kind === ts.SyntaxKind.FalseKeyword) return { type: "boolean", const: false };
    if (lit.kind === ts.SyntaxKind.NullKeyword) return { type: "null" };
    return {};
  }

  // keyword types
  if (ts.isToken(typeNode) || !typeNode.kind === undefined) {
    switch (typeNode.kind) {
      case ts.SyntaxKind.StringKeyword: return { type: "string" };
      case ts.SyntaxKind.NumberKeyword: return { type: "number" };
      case ts.SyntaxKind.BooleanKeyword: return { type: "boolean" };
      case ts.SyntaxKind.NullKeyword: return { type: "null" };
      case ts.SyntaxKind.UndefinedKeyword: return {};
      case ts.SyntaxKind.AnyKeyword:
      case ts.SyntaxKind.UnknownKeyword: return {};
      case ts.SyntaxKind.NeverKeyword: return { not: {} };
      case ts.SyntaxKind.VoidKeyword: return {};
    }
  }

  switch (typeNode.kind) {
    case ts.SyntaxKind.StringKeyword: return { type: "string" };
    case ts.SyntaxKind.NumberKeyword: return { type: "number" };
    case ts.SyntaxKind.BooleanKeyword: return { type: "boolean" };
    case ts.SyntaxKind.NullKeyword: return { type: "null" };
    case ts.SyntaxKind.UndefinedKeyword: return {};
    case ts.SyntaxKind.AnyKeyword:
    case ts.SyntaxKind.UnknownKeyword: return {};
    case ts.SyntaxKind.NeverKeyword: return { not: {} };
    case ts.SyntaxKind.VoidKeyword: return {};
  }

  // Union type: A | B | C
  if (ts.isUnionTypeNode(typeNode)) {
    const types = typeNode.types.map(t => typeNodeToSchema(t, depth + 1));
    // 如果全是 const string，合并成 enum
    const constStrings = types.filter(t => t.type === "string" && t.const !== undefined);
    if (constStrings.length === types.length) {
      return { type: "string", enum: constStrings.map(t => t.const) };
    }
    // 过滤掉 undefined/empty
    const filtered = types.filter(t => Object.keys(t).length > 0 && t.type !== undefined || t.$ref);
    if (filtered.length === 0) return {};
    if (filtered.length === 1) return filtered[0];
    return { anyOf: filtered };
  }

  // Intersection type: A & B
  if (ts.isIntersectionTypeNode(typeNode)) {
    const types = typeNode.types.map(t => typeNodeToSchema(t, depth + 1)).filter(t => Object.keys(t).length > 0);
    if (types.length === 0) return {};
    if (types.length === 1) return types[0];
    return { allOf: types };
  }

  // Array type: T[]
  if (ts.isArrayTypeNode(typeNode)) {
    return { type: "array", items: typeNodeToSchema(typeNode.elementType, depth + 1) };
  }

  // Tuple type: [A, B]
  if (ts.isTupleTypeNode(typeNode)) {
    return {
      type: "array",
      items: typeNode.elements.map(e => typeNodeToSchema(ts.isNamedTupleMember(e) ? e.type : e, depth + 1)),
      minItems: typeNode.elements.length,
      maxItems: typeNode.elements.length,
    };
  }

  // Object type literal: { key: value }
  if (ts.isTypeLiteralNode(typeNode)) {
    return buildObjectSchema(typeNode.members, depth);
  }

  // Type reference: SomeType, Record<K,V>, Partial<T>, Array<T>, etc.
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeNode.typeName && ts.isIdentifier(typeNode.typeName) ? typeNode.typeName.text : null;
    const args = typeNode.typeArguments;

    // Built-in generics
    if (name === "Array" && args?.length === 1) {
      return { type: "array", items: typeNodeToSchema(args[0], depth + 1) };
    }
    if (name === "Record" && args?.length === 2) {
      return { type: "object", additionalProperties: typeNodeToSchema(args[1], depth + 1) };
    }
    if ((name === "Partial" || name === "Required" || name === "Readonly") && args?.length === 1) {
      return typeNodeToSchema(args[0], depth + 1);
    }
    if (name === "NonNullable" && args?.length === 1) {
      return typeNodeToSchema(args[0], depth + 1);
    }
    if ((name === "Pick" || name === "Omit") && args?.length === 2) {
      // 简化处理
      return typeNodeToSchema(args[0], depth + 1);
    }

    // 用户定义类型
    if (name && typeMap.has(name) && !processingStack.has(name)) {
      if (!definitions[name]) {
        processingStack.add(name);
        definitions[name] = buildTypeSchema(typeMap.get(name), depth + 1);
        processingStack.delete(name);
      }
      return { $ref: `#/$defs/${name}` };
    }

    if (name) return {}; // 未知引用，跳过
    return {};
  }

  // readonly T[]
  if (ts.isTypeOperatorNode(typeNode)) {
    return typeNodeToSchema(typeNode.type, depth);
  }

  // Indexed access: T[K]
  if (ts.isIndexedAccessTypeNode(typeNode)) {
    return {}; // 太复杂，跳过
  }

  // Template literal
  if (ts.isTemplateLiteralTypeNode?.(typeNode)) {
    return { type: "string" };
  }

  return {};
}

function buildObjectSchema(members, depth) {
  const properties = {};
  const required = [];

  for (const member of members) {
    if (ts.isPropertySignature(member) || ts.isPropertyDeclaration?.(member)) {
      const name = member.name && ts.isIdentifier(member.name) ? member.name.text : null;
      if (!name) continue;

      const schema = member.type ? typeNodeToSchema(member.type, depth + 1) : {};
      const comment = getJSDocComment(member);
      if (comment) schema.description = comment;

      properties[name] = schema;

      // 没有 ? 的是必填
      if (!member.questionToken) {
        required.push(name);
      }
    } else if (ts.isIndexSignatureDeclaration?.(member)) {
      // [key: string]: value
      const valType = member.type ? typeNodeToSchema(member.type, depth + 1) : {};
      return { type: "object", additionalProperties: valType };
    }
  }

  const result = { type: "object", properties };
  if (required.length > 0) result.required = required;
  return result;
}

function buildTypeSchema(node, depth = 0) {
  if (!node.type) return {};
  return typeNodeToSchema(node.type, depth);
}

// ── 生成根 schema ───────────────────────────────────────────────────────────

console.log("  🔄 生成 JSON Schema...");

// 先处理所有类型（建立 definitions）
for (const [name, node] of typeMap) {
  if (!definitions[name] && !processingStack.has(name)) {
    processingStack.add(name);
    definitions[name] = buildTypeSchema(node);
    processingStack.delete(name);
  }
}

const rootSchema = definitions["OpenClawConfig"] || {};

const finalSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "OpenClaw Configuration",
  description: `JSON Schema for openclaw.json — OpenClaw v${ocVersion}. Generated: ${new Date().toISOString()}.`,
  ...rootSchema,
  $defs: definitions,
};

mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
writeFileSync(OUTPUT_FILE, JSON.stringify(finalSchema, null, 2));

const sizeKB = (Buffer.byteLength(JSON.stringify(finalSchema)) / 1024).toFixed(1);
const topProps = finalSchema.properties ? Object.keys(finalSchema.properties) : [];
const defCount = Object.keys(definitions).length;

console.log(`\n✅ JSON Schema 生成成功！`);
console.log(`   📄 输出: ${OUTPUT_FILE}`);
console.log(`   📏 大小: ${sizeKB} KB`);
console.log(`   🔑 顶层配置项 (${topProps.length}): ${topProps.join(", ")}`);
console.log(`   📦 类型定义 ($defs): ${defCount} 个`);
console.log("\n🎉 完成！");
