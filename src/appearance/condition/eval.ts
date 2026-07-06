/**
 * 与 StyleHelper 中 `show`、`conditions` 条件项的表达式求值一致
 * 在 propertyData 的键作为变量名的上下文中执行 `Boolean(expr)`
 *
 * 实现：对每个表达式字符串用 `new Function('data', 'with(d){...}')` 编译；
 * 推荐在单次样式应用前调用 `buildStyleConditionEvaluatorMap` 预编译当前 style 内全部表达式，
 * 将返回的 Map 传入 `evaluateStyleCondition`，避免在 OID 循环中重复编译。
 */

import type {
  StyleCondition,
  StyleConditionInput,
  StyleShowInput,
} from "../types";
import { resolveShowContent, resolveStyleConditionContent } from "./input";

export type StyleConditionEvaluator = (
  data: Record<string, unknown>,
) => boolean;

/**
 * 编译单个表达式；失败返回 null
 */
export function compileStyleCondition(
  expr: string,
): StyleConditionEvaluator | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;
  try {
    return new Function(
      "data",
      `var d = data != null && typeof data === "object" ? data : {};
with (d) { return Boolean(${trimmed}); }`,
    ) as StyleConditionEvaluator;
  } catch {
    return null;
  }
}

/**
 * 遍历 style 的 show 与 conditions，对每个出现过的字符串表达式只编译一次
 */
export function buildStyleConditionEvaluatorMap(config: {
  show?: StyleShowInput;
  conditions?: StyleCondition[];
}): Map<string, StyleConditionEvaluator> {
  const strings = new Set<string>();
  const showContent = resolveShowContent(config.show);
  if (showContent?.trim()) strings.add(showContent.trim());
  for (const [cond] of config.conditions ?? []) {
    const content = resolveStyleConditionContent(cond);
    if (typeof content === "string" && content.trim())
      strings.add(content.trim());
  }
  const map = new Map<string, StyleConditionEvaluator>();
  for (const s of strings) {
    const fn = compileStyleCondition(s);
    if (fn) map.set(s, fn);
  }
  return map;
}

export function evaluateStyleCondition(
  expr: StyleConditionInput,
  propertyData: Record<string, unknown> | null,
  evaluators?: ReadonlyMap<string, StyleConditionEvaluator>,
): boolean {
  const resolved = resolveStyleConditionContent(expr);
  if (resolved === true) return true;
  if (resolved === false) return false;
  if (typeof resolved !== "string" || !resolved.trim()) return true;

  const trimmed = resolved.trim();
  const data = propertyData ?? {};

  const fromMap = evaluators?.get(trimmed);
  if (fromMap) {
    try {
      return fromMap(data);
    } catch {
      return false;
    }
  }

  const fn = compileStyleCondition(trimmed);
  if (!fn) return false;
  try {
    return fn(data);
  } catch {
    return false;
  }
}
