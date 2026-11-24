import { Material } from "three";
import {
  resolveShowFeatureIdAttribute,
  resolveShowContent,
  resolveStyleConditionContent,
  resolveStyleConditionFeatureIdAttribute,
  type StyleAppearance,
  type StyleCondition,
  type StyleConditionInput,
  type StyleEulerInput,
  type StyleShowInput,
  type StyleVec3Input,
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

/** 材质片段 key（Material 实例取 uuid，builder 函数取实例标识） */
function buildMaterialKey(material?: StyleAppearance["material"]): string {
  if (material instanceof Material) return material.uuid;
  if (typeof material === "function") return `fn${fnIdentityKey(material)}`;
  return "";
}

/** mesh 回调片段 key（函数实例标识） */
function buildMeshCallbackKey(mesh?: StyleAppearance["mesh"]): string {
  return typeof mesh === "function" ? `mesh${fnIdentityKey(mesh)}` : "";
}

/** 外观片段 key（材质取 uuid / 函数实例标识，颜色与透明度取字面量） */
export function buildAppearanceCacheKey(appearance?: StyleAppearance): string {
  if (!appearance) return "";
  const { color, opacity, refine } = appearance;
  return `m${buildMaterialKey(appearance.material)}:c${color ?? ""}:o${opacity ?? ""}:${buildMeshCallbackKey(appearance.mesh)}:r${refine ?? "replace"}`;
}

function styleVec3Key(v?: StyleVec3Input): string {
  if (v == null) return "_";
  if (Array.isArray(v)) return `${v[0] ?? 0},${v[1] ?? 0},${v[2] ?? 0}`;
  const vec = v as { x: number; y: number; z: number };
  return `${vec.x},${vec.y},${vec.z}`;
}

function styleEulerKey(v?: StyleEulerInput): string {
  if (v == null) return "_";
  if (Array.isArray(v)) {
    return `${v[0] ?? 0},${v[1] ?? 0},${v[2] ?? 0},${v[3] ?? "XYZ"}`;
  }
  const e = v as { x: number; y: number; z: number; order?: string };
  return `${e.x},${e.y},${e.z},${e.order ?? "XYZ"}`;
}

/**
 * 外观分组片段 key：不含 color/opacity（拖动改色/改透明度不换组）。
 * material 引用、mesh 回调、refine、TRS 位姿任一变化都必须换组重建——
 * 保证同组 condition 之间唯一可能不同的就是 color/opacity，
 * 这样组内按位置对齐做"仅换材质"的快速路径才是安全的。
 */
function buildAppearanceGroupKey(appearance?: StyleAppearance): string {
  if (!appearance) return "";
  return [
    `m${buildMaterialKey(appearance.material)}`,
    buildMeshCallbackKey(appearance.mesh),
    `t${styleVec3Key(appearance.translation)}`,
    `s${styleVec3Key(appearance.scale)}`,
    `rot${styleEulerKey(appearance.rotation)}`,
    `piv${styleVec3Key(appearance.origin)}`,
    `r${appearance.refine ?? "replace"}`,
  ].join(":");
}

/** split 缓存完整 key：条件 key + 外观 key */
export function buildSplitCacheKey(condition: StyleCondition): string {
  const [input, appearance] = condition;
  return `${buildMatchCacheKey(input)}|${buildAppearanceCacheKey(appearance)}`;
}

/**
 * collector 分组 key：条件 key + 外观分组 key（不含 color/opacity）。
 * 同组 condition 表达式必然相同 → 命中集一致，组内 split mesh 仅外观有差异。
 */
export function buildCollectorGroupKey(condition: StyleCondition): string {
  const [input, appearance] = condition;
  return `${buildMatchCacheKey(input)}|${buildAppearanceGroupKey(appearance)}`;
}

/** show 隐藏集的缓存 key（与条件命中缓存同池，"f" 前缀外的独立命名空间隔离极性） */
export function buildShowHiddenCacheKey(show: StyleShowInput): string {
  return `${resolveShowFeatureIdAttribute(show)}:${resolveShowContent(show)!
    .trim()}#showHidden`;
}
