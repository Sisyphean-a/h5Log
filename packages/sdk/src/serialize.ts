import type { JsonValue } from "./types.js";

const MAX_DEPTH = 12;
const MAX_ITEMS = 2000;
const MAX_STRING = 64 * 1024;

/** Rule: 整条快照共享值数量与字符预算，字段名和特殊类型也不能绕过限制。 */
export function snapshot(value: unknown): JsonValue {
  const ancestors = new WeakSet<object>();
  let remaining = MAX_ITEMS;
  let characters = MAX_STRING;

  function text(input: string): string {
    const allowed = Math.max(0, characters);
    characters -= Math.min(input.length, allowed);
    return input.length <= allowed
      ? input
      : `${input.slice(0, allowed)}…[字符串快照超出 64K 字符]`;
  }

  function exhausted(): string | undefined {
    if (remaining <= 0) return "[达到快照容量上限]";
    if (characters <= 0) return "[字符串快照超出 64K 字符]";
    return undefined;
  }

  function visit(input: unknown, depth: number): JsonValue {
    if (remaining-- <= 0) return "[达到快照容量上限]";
    if (input === null) return null;
    if (typeof input === "string") return text(input);
    if (typeof input === "boolean") return input;
    if (typeof input === "number")
      return Number.isFinite(input) ? input : String(input);
    if (typeof input === "bigint") return text(`${input}n`);
    if (typeof input === "undefined") return "[undefined]";
    if (typeof input === "symbol")
      return `Symbol(${text(input.description ?? "")})`;
    if (typeof input === "function")
      return `[Function ${text(input.name || "anonymous")}]`;
    if (depth >= MAX_DEPTH) return "[达到最大展开深度]";
    if (ancestors.has(input)) return "[Circular]";
    ancestors.add(input);
    try {
      if (input instanceof Date) return text(input.toISOString());
      if (typeof File !== "undefined" && input instanceof File) {
        return {
          file: text(input.name),
          type: text(input.type),
          size: input.size,
        };
      }
      if (typeof Blob !== "undefined" && input instanceof Blob) {
        return { type: text(input.type), size: input.size };
      }
      if (
        input instanceof URLSearchParams ||
        (typeof FormData !== "undefined" && input instanceof FormData)
      ) {
        const entries: JsonValue[] = [];
        for (const [name, item] of input.entries()) {
          const marker = exhausted();
          if (marker) {
            entries.push(marker);
            break;
          }
          entries.push({ name: text(name), value: visit(item, depth + 1) });
        }
        return entries;
      }
      if (input instanceof Map || input instanceof Set) {
        const items: JsonValue[] = [];
        for (const item of input instanceof Map
          ? input.entries()
          : input.values()) {
          const marker = exhausted();
          if (marker) {
            items.push(marker);
            break;
          }
          items.push(visit(item, depth + 1));
        }
        return items;
      }
      if (Array.isArray(input)) {
        const items: JsonValue[] = [];
        for (let i = 0; i < input.length; i++) {
          const marker = exhausted();
          if (marker) {
            items.push(marker);
            break;
          }
          const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
          items.push(
            visit(
              descriptor && "value" in descriptor
                ? descriptor.value
                : "[Getter 或空项]",
              depth + 1,
            ),
          );
        }
        return items;
      }
      const result: { [key: string]: JsonValue } = Object.create(null) as {
        [key: string]: JsonValue;
      };
      if (input instanceof Error) {
        result.name = text(input.name);
        result.message = visit(input.message, depth + 1);
        result.stack = visit(input.stack, depth + 1);
        if ("cause" in input) result.cause = visit(input.cause, depth + 1);
      }
      for (const key in input) {
        if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
        const marker = exhausted();
        if (marker) {
          result["[快照限制]"] = marker;
          break;
        }
        const name = text(key);
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        result[name] = visit(
          descriptor && "value" in descriptor ? descriptor.value : "[Getter]",
          depth + 1,
        );
      }
      return result;
    } catch (error) {
      return `[无法序列化: ${text(error instanceof Error ? error.message : "未知错误")}]`;
    } finally {
      ancestors.delete(input);
    }
  }

  try {
    return visit(value, 0);
  } catch {
    return "[无法序列化]";
  }
}
