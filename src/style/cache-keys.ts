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

/** 外观片段 key（材质取 uuid / 函数标记，颜色与透明度取字面量） */
export function buildAppearanceCacheKey(appearance?: StyleAppearance): string {
  if (!appearance) return "";
  const { material, color, opacity } = appearance;
  const matKey =
    material instanceof Material
      ? material.uuid
      : typeof material === "function"
        ? "fn"
        : "";
  return `m${matKey}:c${color ?? ""}:o${opacity ?? ""}`;
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
