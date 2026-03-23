/**
 * 与 StyleHelper 中 `show`、`conditions` 条件项的表达式求值一致
 * 在 propertyData 的键作为变量名的上下文中执行 `Boolean(expr)`
 */
export function evaluateStyleCondition(
  expr: string | boolean,
  propertyData: Record<string, unknown> | null,
): boolean {
  if (expr === true) return true;
  if (expr === false) return false;
  if (typeof expr !== "string" || !expr.trim()) return true;

  const data = propertyData ?? {};
  const keys = Object.keys(data);
  const values = keys.map((k) => data[k]);

  try {
    const fn = new Function(...keys, `return Boolean(${expr})`);
    return fn(...values);
  } catch {
    return false;
  }
}
