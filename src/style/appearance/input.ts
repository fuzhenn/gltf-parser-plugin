/**
 * 样式/高亮系统的输入规范化层。
 *
 * 把用户在 JSON 里写的多种写法（字符串、布尔、带 `featureIdAttribute` 的对象）
 * 统一解析为：
 * - 表达式内容（`content`）
 * - feature id 通道索引（0 → `_FEATURE_ID_0` / OID，1 → `_FEATURE_ID_1` / PID）
 *
 * 供 eval（求值）、StyleHelper、PartInteractionFilter 使用。
 *
 * @example
 * ```json
 * {
 *   "show": "type === 'wall'",
 *   "conditions": [
 *     ["floor === 1", { "color": "#ff0000" }],
 *     [
 *       { "content": "pid > 100", "featureIdAttribute": 1 },
 *       { "color": "#00ff00" }
 *     ]
 *   ]
 * }
 * ```
 */

import type { StyleConditionInput, StyleShowInput } from "./types";

const DEFAULT_FEATURE_ID_ATTRIBUTE = 0;

export function normalizeFeatureIdAttribute(
  featureIdAttribute?: number,
): number {
  return featureIdAttribute ?? DEFAULT_FEATURE_ID_ATTRIBUTE;
}

export function resolveStyleConditionContent(
  input: StyleConditionInput,
): string | boolean {
  if (typeof input === "boolean") return input;
  if (typeof input === "string") return input;
  return input.content;
}

export function resolveStyleConditionFeatureIdAttribute(
  input: StyleConditionInput,
): number {
  if (typeof input === "object" && input !== null && "content" in input) {
    return normalizeFeatureIdAttribute(input.featureIdAttribute);
  }
  return DEFAULT_FEATURE_ID_ATTRIBUTE;
}

export function resolveShowContent(show?: StyleShowInput): string | undefined {
  if (show == null) return undefined;
  if (typeof show === "string") return show;
  return show.content;
}

export function resolveShowFeatureIdAttribute(show?: StyleShowInput): number {
  if (show == null) return DEFAULT_FEATURE_ID_ATTRIBUTE;
  if (typeof show === "string") return DEFAULT_FEATURE_ID_ATTRIBUTE;
  return normalizeFeatureIdAttribute(show.featureIdAttribute);
}
