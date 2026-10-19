import { Material } from "three";
import {
  resolveShowFeatureIdAttribute,
  resolveShowContent,
  resolveStyleConditionContent,
  resolveStyleConditionFeatureIdAttribute,
  type StyleAppearance,
  type StyleCondition,
  type StyleConditionInput,
  type StyleShowInput,
} from "./appearance";

/** 条件命中缓存的 key：`f<featureIdAttribute>:<content>` */
export function buildMatchCacheKey(input: StyleConditionInput): string {
  const featureIdAttribute = resolveStyleConditionFeatureIdAttribute(input);
  const content = resolveStyleConditionContent(input);
  const condPart =
    typeof content === "string" ? content.trim() : String(content);
  return `f${featureIdAttribute}:${condPart}`;
}

/**
 * 函数实例的稳定标识：同一函数引用 → 同一 id，不同引用 → 不同 id。
 * 以函数自身作为 WeakMap key 持有，函数被回收后条目自动释放，避免内存泄漏。
 */
const fnIdentityIds = new WeakMap<Function, number>();
let fnIdentitySeq = 0;

function fnIdentityKey(fn: Function): string {
  let id = fnIdentityIds.get(fn);
  if (id === undefined) {
    id = ++fnIdentitySeq;
    fnIdentityIds.set(fn, id);
  }
  return String(id);
}

/** 外观片段 key（材质取 uuid / 函数实例标识，颜色与透明度取字面量） */
export function buildAppearanceCacheKey(appearance?: StyleAppearance): string {
  if (!appearance) return "";
  const { material, color, opacity, mesh } = appearance;
  const matKey =
    material instanceof Material
      ? material.uuid
      : typeof material === "function"
        ? `fn${fnIdentityKey(material)}`
        : "";
  const meshKey = typeof mesh === "function"
    ? `mesh${fnIdentityKey(mesh)}`
    : "";
  return `m${matKey}:c${color ?? ""}:o${opacity ?? ""}:${meshKey}`;
}

/** split 缓存完整 key：条件 key + 外观 key */
export function buildSplitCacheKey(condition: StyleCondition): string {
  const [input, appearance] = condition;
  return `${buildMatchCacheKey(input)}|${buildAppearanceCacheKey(appearance)}`;
}

/** show 隐藏集的缓存 key（与条件命中缓存同池，"f" 前缀外的独立命名空间隔离极性） */
export function buildShowHiddenCacheKey(show: StyleShowInput): string {
  return `${resolveShowFeatureIdAttribute(show)}:${resolveShowContent(show)!
    .trim()}#showHidden`;
}
