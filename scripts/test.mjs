/**
 * test.mjs — unit & integration tests for schema extraction
 *
 * Run: node --test scripts/test.mjs
 * Requires: Node.js 20+ (built-in test runner, zero dependencies)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripBalancedCall, countPaths, postProcessSchemaSource } from "./lib.mjs";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── stripBalancedCall ────────────────────────────────────────────────────

describe("stripBalancedCall", () => {
  it("strips a simple method call", () => {
    const code = `z.string().superRefine((val) => val)`;
    assert.equal(stripBalancedCall(code, "superRefine"), `z.string()`);
  });

  it("strips multiple occurrences", () => {
    const code = `a.refine(x).b.refine(y)`;
    assert.equal(stripBalancedCall(code, "refine"), `a.b`);
  });

  it("handles nested parentheses", () => {
    const code = `z.object({}).superRefine((val, ctx) => { if (foo(bar())) ctx.addIssue(); })`;
    assert.equal(stripBalancedCall(code, "superRefine"), `z.object({})`);
  });

  it("handles double-quoted strings with parens inside", () => {
    const code = `z.string().refine(v => v.match("(foo)"))`;
    assert.equal(stripBalancedCall(code, "refine"), `z.string()`);
  });

  it("handles single-quoted strings with parens inside", () => {
    const code = `z.string().refine(v => v.match('(bar)'))`;
    assert.equal(stripBalancedCall(code, "refine"), `z.string()`);
  });

  it("handles template literals with parens inside", () => {
    const code = "z.string().transform(v => `(${v})`)";
    assert.equal(stripBalancedCall(code, "transform"), "z.string()");
  });

  it("handles escaped quotes inside strings", () => {
    const code = `z.string().refine(v => v.match("he\\"llo("))`;
    assert.equal(stripBalancedCall(code, "refine"), `z.string()`);
  });

  it("returns unchanged code when method not found", () => {
    const code = `z.string().min(1)`;
    assert.equal(stripBalancedCall(code, "superRefine"), `z.string().min(1)`);
  });

  it("returns empty string for empty input", () => {
    assert.equal(stripBalancedCall("", "refine"), "");
  });

  it("strips chained calls correctly", () => {
    const code = `z.string().min(1).superRefine(fn).max(10)`;
    assert.equal(stripBalancedCall(code, "superRefine"), `z.string().min(1).max(10)`);
  });

  it("does not strip partial method name matches", () => {
    const code = `z.string().mySuperRefine(fn)`;
    // ".superRefine(" won't match ".mySuperRefine(" — it matches ".superRefine(" at any position
    // But "mySuperRefine" contains ".superRefine(" as a substring after "my"
    // The marker is ".superRefine(" which won't match "mySuperRefine(" since the dot is before "my"
    assert.equal(stripBalancedCall(code, "superRefine"), `z.string().mySuperRefine(fn)`);
  });

  it("handles deeply nested parentheses (3 levels)", () => {
    const code = `z.refine(a(b(c(d))))`;
    assert.equal(stripBalancedCall(code, "refine"), `z`);
  });
});

// ── countPaths ───────────────────────────────────────────────────────────

describe("countPaths", () => {
  it("returns empty set for null/undefined", () => {
    assert.equal(countPaths(null).size, 0);
    assert.equal(countPaths(undefined).size, 0);
  });

  it("returns empty set for object without properties", () => {
    assert.equal(countPaths({ type: "string" }).size, 0);
  });

  it("counts top-level properties", () => {
    const schema = {
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
    };
    const paths = countPaths(schema);
    assert.equal(paths.size, 2);
    assert.ok(paths.has("name"));
    assert.ok(paths.has("age"));
  });

  it("counts nested properties with dotted paths", () => {
    const schema = {
      properties: {
        user: {
          properties: {
            name: { type: "string" },
            email: { type: "string" },
          },
        },
      },
    };
    const paths = countPaths(schema);
    assert.equal(paths.size, 3); // user, user.name, user.email
    assert.ok(paths.has("user"));
    assert.ok(paths.has("user.name"));
    assert.ok(paths.has("user.email"));
  });

  it("counts array items with [] notation", () => {
    const schema = {
      properties: {
        tags: {
          items: {
            properties: {
              label: { type: "string" },
            },
          },
        },
      },
    };
    const paths = countPaths(schema);
    assert.ok(paths.has("tags"));
    assert.ok(paths.has("tags[].label"));
  });

  it("counts additionalProperties with [*] notation", () => {
    const schema = {
      properties: {
        config: {
          additionalProperties: {
            properties: {
              value: { type: "string" },
            },
          },
        },
      },
    };
    const paths = countPaths(schema);
    assert.ok(paths.has("config"));
    assert.ok(paths.has("config[*].value"));
  });

  it("uses prefix correctly", () => {
    const schema = {
      properties: { x: { type: "number" } },
    };
    const paths = countPaths(schema, "root");
    assert.ok(paths.has("root.x"));
    assert.ok(!paths.has("x"));
  });
});

// ── postProcessSchemaSource ─────────────────────────────────────────────

describe("postProcessSchemaSource", () => {
  it("strips superRefine, transform, and refine in one pass", () => {
    const code = `z.object({}).superRefine(fn1).transform(fn2).refine(fn3)`;
    assert.equal(postProcessSchemaSource(code), `z.object({})`);
  });

  it("removes inbound-path-policy imports", () => {
    const code = `import { isValid } from "../media/inbound-path-policy.js";\nconst x = 1;`;
    assert.equal(postProcessSchemaSource(code), `const x = 1;`);
  });

  it("removes inbound-path-policy imports with single quotes", () => {
    const code = `import { foo } from '../media/inbound-path-policy.js';\nconst y = 2;`;
    assert.equal(postProcessSchemaSource(code), `const y = 2;`);
  });

  it("preserves non-matching imports", () => {
    const code = `import { z } from "zod";\nz.string().min(1)`;
    assert.equal(postProcessSchemaSource(code), code);
  });

  it("handles code with all three patterns combined", () => {
    const code = [
      `import { isValid } from "../media/inbound-path-policy.js";`,
      `import { z } from "zod";`,
      `const schema = z.object({ a: z.string() })`,
      `  .superRefine((v, ctx) => { check(v); })`,
      `  .transform((v) => ({ ...v, extra: true }))`,
      `  .refine((v) => isValid(v.a));`,
    ].join("\n");
    const result = postProcessSchemaSource(code);
    assert.ok(!result.includes("superRefine"));
    assert.ok(!result.includes("transform"));
    assert.ok(!result.includes(".refine"));
    assert.ok(!result.includes("inbound-path-policy"));
    assert.ok(result.includes(`import { z } from "zod";`));
    assert.ok(result.includes("z.object({ a: z.string() })"));
  });
});

// ── Integration: openclaw.schema.json validation ───────────────────────
// These tests require openclaw.schema.json to exist (generated by extraction scripts).
// They are skipped when absent (e.g. fresh clone without running extraction).

describe("openclaw.schema.json integration", () => {
  const schemaPath = resolve(__dirname, "../openclaw.schema.json");
  const hasSchema = existsSync(schemaPath);

  it("openclaw.schema.json exists", { skip: !hasSchema && "not generated yet" }, () => {
    assert.ok(existsSync(schemaPath));
  });

  it("is valid JSON", { skip: !hasSchema && "not generated yet" }, () => {
    const raw = readFileSync(schemaPath, "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));
  });

  it("has expected top-level fields", { skip: !hasSchema && "not generated yet" }, () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    assert.ok(schema.title, "missing title");
    assert.ok(schema.description, "missing description");
    assert.ok(schema.properties, "missing properties");
    assert.equal(typeof schema.properties, "object");
  });

  it("has 37 top-level properties", { skip: !hasSchema && "not generated yet" }, () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const count = Object.keys(schema.properties).length;
    assert.equal(count, 37, `expected 37 top-level properties, got ${count}`);
  });

  it("includes key config sections", { skip: !hasSchema && "not generated yet" }, () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const props = Object.keys(schema.properties);
    for (const key of ["gateway", "logging", "agents", "channels", "models", "hooks", "mcp"]) {
      assert.ok(props.includes(key), `missing expected property: ${key}`);
    }
  });

  it("has reasonable file size (500KB - 2MB)", { skip: !hasSchema && "not generated yet" }, () => {
    const raw = readFileSync(schemaPath, "utf8");
    const sizeKB = Buffer.byteLength(raw) / 1024;
    assert.ok(sizeKB > 500, `schema too small: ${sizeKB.toFixed(0)} KB`);
    assert.ok(sizeKB < 2048, `schema too large: ${sizeKB.toFixed(0)} KB`);
  });

  it("countPaths returns > 1000 paths", { skip: !hasSchema && "not generated yet" }, () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const paths = countPaths(schema);
    assert.ok(paths.size > 1000, `expected > 1000 schema paths, got ${paths.size}`);
  });
});
