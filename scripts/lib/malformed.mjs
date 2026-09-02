// GENERATED from packages/mcp-checks/src/malformed.ts (pnpm --filter @agentwares/mcp-checks sync:runner). Do not edit.
// src/malformed.ts
var MALFORMED_CASE_COUNT = 10;
var HUGE_STRING_LENGTH = 2e4;
var MAX_DEPTH = 6;
var CONTROL_CHARS = "\0\uFFFE";
function resolveRef(schema, root) {
  const ref = schema.$ref;
  if (!ref || !root || !ref.startsWith("#/")) return schema;
  const parts = ref.slice(2).split("/");
  let cur = root;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return schema;
    cur = cur[p];
  }
  return cur && typeof cur === "object" ? cur : schema;
}
function primaryType(schema) {
  if (Array.isArray(schema.type)) {
    const t = schema.type.find((x) => x !== "null");
    return t ?? schema.type[0];
  }
  if (typeof schema.type === "string") return schema.type;
  if (schema.properties) return "object";
  if (schema.items) return "array";
  if (schema.enum?.length) return typeof schema.enum[0] === "number" ? "number" : "string";
  const alt = schema.anyOf?.[0] ?? schema.oneOf?.[0] ?? schema.allOf?.[0];
  if (alt) return primaryType(alt);
  return void 0;
}
function exampleValue(schema, root, depth = 0) {
  if (!schema) return "example";
  const s = resolveRef(schema, root);
  if (s.default !== void 0) return s.default;
  if (s.examples && s.examples.length > 0) return s.examples[0];
  if (s.const !== void 0) return s.const;
  if (s.enum && s.enum.length > 0) return s.enum[0];
  const alt = s.anyOf?.[0] ?? s.oneOf?.[0];
  if (!s.type && alt) return exampleValue(alt, root, depth + 1);
  switch (primaryType(s)) {
    case "string":
      return exampleString(s);
    case "integer":
      return clampNumber(s, 1, true);
    case "number":
      return clampNumber(s, 1.5, false);
    case "boolean":
      return true;
    case "null":
      return null;
    case "array": {
      const item = Array.isArray(s.items) ? s.items[0] : s.items;
      const n = Math.max(1, s.minItems ?? 1);
      if (depth >= MAX_DEPTH) return [];
      return Array.from({ length: Math.min(n, 3) }, () => exampleValue(item, root, depth + 1));
    }
    case "object": {
      if (depth >= MAX_DEPTH) return {};
      return exampleObject(s, root, depth + 1);
    }
    default:
      return "example";
  }
}
function exampleString(s) {
  const byFormat = {
    uri: "https://example.com/resource",
    url: "https://example.com/resource",
    "uri-reference": "/resource",
    email: "dev@example.com",
    "date-time": "2026-09-01T12:00:00Z",
    date: "2026-09-01",
    time: "12:00:00",
    uuid: "123e4567-e89b-12d3-a456-426614174000",
    ipv4: "192.0.2.1",
    ipv6: "2001:db8::1",
    hostname: "example.com",
    regex: "^a.*z$"
  };
  let value = (s.format && byFormat[s.format]) ?? "example";
  if (s.minLength !== void 0 && value.length < s.minLength) {
    value = value.padEnd(s.minLength, "x");
  }
  if (s.maxLength !== void 0 && value.length > s.maxLength) {
    value = value.slice(0, Math.max(1, s.maxLength));
  }
  return value;
}
function clampNumber(s, fallback, integer) {
  let v = fallback;
  const min = s.minimum ?? (s.exclusiveMinimum !== void 0 ? s.exclusiveMinimum + 1 : void 0);
  const max = s.maximum ?? (s.exclusiveMaximum !== void 0 ? s.exclusiveMaximum - 1 : void 0);
  if (min !== void 0 && v < min) v = min;
  if (max !== void 0 && v > max) v = max;
  return integer ? Math.round(v) : v;
}
function exampleObject(s, root, depth) {
  const out = {};
  const props = s.properties ?? {};
  const required = new Set(s.required ?? []);
  for (const [name, prop] of Object.entries(props)) {
    if (required.has(name) || depth <= 1) out[name] = exampleValue(prop, root, depth);
  }
  return out;
}
function exampleArgs(schema) {
  if (!schema) return {};
  const s = resolveRef(schema, schema);
  return exampleObject(s, schema, 1);
}
function wrongTypeValue(prop, root) {
  switch (primaryType(resolveRef(prop, root))) {
    case "string":
      return 12345;
    case "integer":
    case "number":
      return "twelve";
    case "boolean":
      return "yes";
    case "array":
      return { not: "an array" };
    case "object":
      return "not an object";
    case "null":
      return "not null";
    default:
      return { unexpected: true };
  }
}
function withField(base, field, value) {
  return { ...base, [field]: value };
}
function withoutField(base, field) {
  const copy = { ...base };
  delete copy[field];
  return copy;
}
function deepNest(depth) {
  let v = "leaf";
  for (let i = 0; i < depth; i++) v = { nested: v };
  return v;
}
function malformedInputs(schema) {
  const root = schema ?? { type: "object" };
  const s = resolveRef(root, root);
  const valid = exampleArgs(root);
  const props = Object.entries(s.properties ?? {}).map(
    ([name, p]) => [name, resolveRef(p, root)]
  );
  const required = (s.required ?? []).filter((r) => props.some(([n]) => n === r));
  const candidates = [];
  for (const f of required) {
    candidates.push({
      id: `missing_required:${f}`,
      kind: "missing_required",
      title: `required field \`${f}\` missing`,
      args: withoutField(valid, f),
      field: f
    });
  }
  for (const [f, p] of props) {
    candidates.push({
      id: `wrong_type:${f}`,
      kind: "wrong_type",
      title: `\`${f}\` has the wrong type (${JSON.stringify(wrongTypeValue(p, root)).slice(0, 24)})`,
      args: withField(valid, f, wrongTypeValue(p, root)),
      field: f
    });
  }
  for (const f of required) {
    candidates.push({
      id: `null_value:${f}`,
      kind: "null_value",
      title: `required field \`${f}\` is null`,
      args: withField(valid, f, null),
      field: f
    });
  }
  for (const [f, p] of props) {
    const t = primaryType(p);
    if (p.enum && p.enum.length > 0) {
      candidates.push({
        id: `invalid_enum:${f}`,
        kind: "invalid_enum",
        title: `\`${f}\` is not one of the allowed values`,
        args: withField(valid, f, "__not_an_option__"),
        field: f
      });
    }
    if (t === "string") {
      if (p.format) {
        candidates.push({
          id: `invalid_format:${f}`,
          kind: "invalid_format",
          title: `\`${f}\` is not a valid ${p.format}`,
          args: withField(valid, f, `not-a-valid-${p.format}`),
          field: f
        });
      }
      candidates.push({
        id: `empty_string:${f}`,
        kind: "empty_string",
        title: `\`${f}\` is an empty string`,
        args: withField(valid, f, ""),
        field: f
      });
    }
    if (t === "integer" || t === "number") {
      if (p.maximum !== void 0 || p.exclusiveMaximum !== void 0) {
        const max = p.maximum ?? p.exclusiveMaximum ?? 0;
        candidates.push({
          id: `out_of_range:${f}`,
          kind: "out_of_range",
          title: `\`${f}\` is above its maximum`,
          args: withField(valid, f, max + 1e6),
          field: f
        });
      } else if (p.minimum === void 0 && p.exclusiveMinimum === void 0) {
        candidates.push({
          id: `negative_number:${f}`,
          kind: "negative_number",
          title: `\`${f}\` is negative`,
          args: withField(valid, f, -1),
          field: f
        });
      } else {
        const min = p.minimum ?? p.exclusiveMinimum ?? 0;
        candidates.push({
          id: `out_of_range:${f}`,
          kind: "out_of_range",
          title: `\`${f}\` is below its minimum`,
          args: withField(valid, f, min - 1e6),
          field: f
        });
      }
      if (t === "integer") {
        candidates.push({
          id: `non_integer:${f}`,
          kind: "non_integer",
          title: `\`${f}\` is not an integer`,
          args: withField(valid, f, 1.5),
          field: f
        });
      }
    }
  }
  for (const [f, p] of props) {
    if (primaryType(p) === "string") {
      candidates.push({
        id: `huge_string:${f}`,
        kind: "huge_string",
        title: `\`${f}\` is a ${HUGE_STRING_LENGTH}-character string`,
        args: withField(valid, f, "x".repeat(HUGE_STRING_LENGTH)),
        field: f
      });
      candidates.push({
        id: `control_chars:${f}`,
        kind: "control_chars",
        title: `\`${f}\` contains NUL and control characters`,
        args: withField(valid, f, CONTROL_CHARS),
        field: f
      });
    }
    if (primaryType(p) === "array") {
      candidates.push({
        id: `nested_wrong_type:${f}`,
        kind: "nested_wrong_type",
        title: `\`${f}\` items have the wrong type`,
        args: withField(valid, f, [{ unexpected: true }, 12345, null]),
        field: f
      });
    }
    if (primaryType(p) === "object") {
      candidates.push({
        id: `nested_wrong_type:${f}`,
        kind: "nested_wrong_type",
        title: `\`${f}\` nested fields have the wrong type`,
        args: withField(valid, f, deepNest(64)),
        field: f
      });
    }
  }
  const generic = [
    {
      id: "unknown_property",
      kind: "unknown_property",
      title: "an unexpected extra property",
      args: { ...valid, __mcpcheck_unexpected: true }
    },
    {
      id: "empty_object",
      kind: "empty_object",
      title: "empty arguments {}",
      args: {}
    },
    {
      id: "array_args",
      kind: "array_args",
      title: "arguments is an array, not an object",
      args: []
    },
    {
      id: "string_args",
      kind: "string_args",
      title: "arguments is a string, not an object",
      args: "not-an-object"
    },
    {
      id: "deep_nesting",
      kind: "deep_nesting",
      title: "a 64-level nested object",
      args: { ...valid, __mcpcheck_deep: deepNest(64) }
    },
    {
      id: "many_unknowns",
      kind: "many_unknowns",
      title: "200 unknown properties",
      args: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`__mcpcheck_${i}`, i]))
    },
    {
      id: "huge_unknown",
      kind: "huge_unknown",
      title: `an unknown ${HUGE_STRING_LENGTH}-character property`,
      args: { ...valid, __mcpcheck_blob: "y".repeat(HUGE_STRING_LENGTH) }
    },
    {
      id: "numeric_keys",
      kind: "numeric_keys",
      title: "numeric property names",
      args: { "0": "a", "1": "b" }
    },
    {
      id: "null_args",
      kind: "null_args",
      title: "arguments is null",
      args: null
    },
    {
      id: "number_args",
      kind: "number_args",
      title: "arguments is a number",
      args: 42
    },
    {
      id: "boolean_args",
      kind: "boolean_args",
      title: "arguments is a boolean",
      args: true
    },
    {
      id: "nested_unknown",
      kind: "nested_unknown",
      title: "an unknown nested object",
      args: { ...valid, __mcpcheck_nested: { a: [1, { b: null }] } }
    }
  ];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  const push = (c) => {
    const key = JSON.stringify(c.args);
    if (seen.has(key) || key === JSON.stringify(valid)) return;
    seen.add(key);
    out.push(c);
  };
  for (const c of candidates) {
    if (out.length >= MALFORMED_CASE_COUNT) break;
    push(c);
  }
  for (const c of generic) {
    if (out.length >= MALFORMED_CASE_COUNT) break;
    push(c);
  }
  return out.slice(0, MALFORMED_CASE_COUNT);
}
export {
  MALFORMED_CASE_COUNT,
  exampleArgs,
  exampleValue,
  malformedInputs
};
