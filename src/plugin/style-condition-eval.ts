/**
 * 与 StyleHelper 中 `show`、`conditions` 条件项的表达式求值一致
 * 在 propertyData 的键作为变量名的上下文中执行 `Boolean(expr)`
 *
 * 实现：对每个表达式字符串只编译一次 `new Function('data', 'with(d){...}')`，
 * 避免按「表达式 × 属性键集合」重复编译，也避免每次求值排序/拼接 cacheKey。
 */

const compiledCache = new Map<string, (data: Record<string, unknown>) => boolean>();
const MAX_CACHE_ENTRIES = 512;

function getCompiled(
  expr: string,
): ((data: Record<string, unknown>) => boolean) | null {
  let fn = compiledCache.get(expr);
  if (fn) return fn;

  try {
    // 非 strict 函数才允许 with；形参 data 为属性表，表达式内可直接写属性名
    fn = new Function(
      "data",
      `var d = data != null && typeof data === "object" ? data : {};
with (d) { return Boolean(${expr}); }`,
    ) as (data: Record<string, unknown>) => boolean;
  } catch {
    return null;
  }

  if (compiledCache.size >= MAX_CACHE_ENTRIES) {
    const first = compiledCache.keys().next().value;
    if (first !== undefined) compiledCache.delete(first);
  }
  compiledCache.set(expr, fn);
  return fn;
}

/**
 * 清空表达式编译缓存（热更新或单测可调用）
 */
export function clearStyleConditionCache(): void {
  compiledCache.clear();
}

export function evaluateStyleCondition(
  expr: string | boolean,
  propertyData: Record<string, unknown> | null,
): boolean {
  if (expr === true) return true;
  if (expr === false) return false;
  if (typeof expr !== "string" || !expr.trim()) return true;

  const trimmed = expr.trim();
  const fn = getCompiled(trimmed);
  if (!fn) return false;

  try {
    return fn(propertyData ?? {});
  } catch {
    return false;
  }
}
