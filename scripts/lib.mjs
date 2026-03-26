/**
 * lib.mjs — shared utilities for schema extraction scripts
 */

/**
 * Strip a chained method call (e.g. `.superRefine(...)`) from source code,
 * correctly handling nested parentheses and quoted strings.
 *
 * @param {string} code  - source code
 * @param {string} methodName - method name without dot or parens (e.g. "superRefine")
 * @returns {string} code with all `.methodName(...)` calls removed
 */
export function stripBalancedCall(code, methodName) {
  let result = "", i = 0;
  const marker = "." + methodName + "(";
  while (i < code.length) {
    const idx = code.indexOf(marker, i);
    if (idx === -1) { result += code.slice(i); break; }
    result += code.slice(i, idx);
    let depth = 1, j = idx + marker.length;
    while (j < code.length && depth > 0) {
      const ch = code[j];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === '"' || ch === "'" || ch === "`") {
        const q = ch; j++;
        while (j < code.length) { if (code[j] === "\\") j++; else if (code[j] === q) break; j++; }
      }
      j++;
    }
    i = j;
  }
  return result;
}

/**
 * Recursively count all property paths in a JSON Schema object.
 * Used for diffing two schemas by path count.
 *
 * @param {object} obj - JSON Schema (sub)object
 * @param {string} prefix - path prefix for recursion
 * @returns {Set<string>} set of dotted property paths
 */
export function countPaths(obj, prefix = "") {
  const paths = new Set();
  if (!obj || typeof obj !== "object") return paths;
  if (obj.properties) {
    for (const [k, v] of Object.entries(obj.properties)) {
      const p = prefix ? `${prefix}.${k}` : k;
      paths.add(p);
      for (const n of countPaths(v, p)) paths.add(n);
    }
  }
  if (obj.items) for (const n of countPaths(obj.items, `${prefix}[]`)) paths.add(n);
  if (obj.additionalProperties && typeof obj.additionalProperties === "object") {
    for (const n of countPaths(obj.additionalProperties, `${prefix}[*]`)) paths.add(n);
  }
  return paths;
}

/**
 * Strip all runtime-only Zod method calls and inbound-path-policy imports
 * from a schema source file.
 *
 * @param {string} code - TypeScript source code
 * @returns {string} post-processed code
 */
export function postProcessSchemaSource(code) {
  code = stripBalancedCall(code, "superRefine");
  code = stripBalancedCall(code, "transform");
  code = stripBalancedCall(code, "refine");
  code = code.replace(/^import\s.*from\s+["'].*inbound-path-policy.*["'];?\n?/gm, "");
  return code;
}
