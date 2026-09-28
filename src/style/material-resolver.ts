import {
  Color,
  Euler,
  type EulerOrder,
  Material,
  Matrix4,
  Vector3,
} from "three";
import {
  type StyleAppearance,
  type StyleEulerInput,
  type StyleMaterialMaps,
  type StyleVec3Input,
} from "./appearance";
import { toColor, type ColorInput } from "../utils/color-input";
import { MaterialBuilder } from "../types";

/** 从构件材质提取贴图，供 material 回调使用 */
export function extractStyleMaterialMaps(
  material: Material,
): StyleMaterialMaps {
  const m = material as unknown as Record<string, unknown>;
  const tex = (key: string) => {
    const v = m[key];
    return v &&
      typeof v === "object" &&
      "isTexture" in v &&
      (v as { isTexture?: boolean }).isTexture
      ? (v as import("three").Texture)
      : null;
  };
  return {
    map: tex("map"),
    normalMap: tex("normalMap"),
    metalnessMap: tex("metalnessMap"),
    roughnessMap: tex("roughnessMap"),
    aoMap: tex("aoMap"),
    emissiveMap: tex("emissiveMap"),
  };
}

/**
 * color-only（及 color+opacity）路径的进程级缓存：`hex_op` → 默认 `MeshStandardMaterial`。
 *
 * 同色同透明度多 mesh 共享同一 Material 实例，避免每 mesh `new` 一份。
 */
const defaultColorMaterialCache = new Map<string, Material>();

/**
 * `material` 实例 + 同级 `color` / `opacity` 的缓存：原始 Material → (复合 key → 克隆体)。
 *
 * - 克隆是为了**不污染用户传入的 Material 实例**；
 * - 用 `WeakMap` 持有原始 Material 作为外层 key，原始 Material 被 GC 时
 *   缓存条目自动回收，避免内存泄漏。
 */
const colorOverrideMaterialCache = new WeakMap<
  Material,
  Map<string, Material>
>();

function clampOpacity01(o: number): number {
  return Math.max(0, Math.min(1, o));
}

function colorHex(c: ColorInput): number {
  return toColor(c).getHex();
}

function materialHasColor(mat: Material): mat is Material & { color: Color } {
  const c = (mat as unknown as { color?: unknown }).color;
  return c instanceof Color;
}

function materialSupportsOpacity(mat: Material): boolean {
  return typeof (mat as unknown as { opacity?: unknown }).opacity === "number";
}

function overrideMaterialCacheKey(
  colorInput: ColorInput | undefined,
  opacityOverride: number | undefined,
): string {
  const h = colorInput !== undefined ? String(colorHex(colorInput)) : "_";
  const o =
    opacityOverride !== undefined
      ? clampOpacity01(opacityOverride).toFixed(4)
      : "_";
  return `${h},${o}`;
}

function getDefaultColorMaterial(
  c: ColorInput,
  opacity: number | undefined,
  materialBuilder: MaterialBuilder,
): Material {
  const hex = colorHex(c);
  const op = opacity != null ? clampOpacity01(opacity) : 1;
  const key = `${hex}_${op}`;
  let m = defaultColorMaterialCache.get(key);
  if (!m) {
    const color = new Color(hex);
    m = materialBuilder({
      pbrMetallicRoughness: {
        baseColorFactor: [color.r, color.g, color.b, op],
      },
    });
    defaultColorMaterialCache.set(key, m);
  }
  return m;
}

function applyAppearanceOverridesToMaterialInstance(
  mat: Material,
  colorInput: ColorInput | undefined,
  opacityOverride: number | undefined,
): Material {
  const wantColor = colorInput !== undefined;
  const wantOpacity = opacityOverride !== undefined;
  const canColor = wantColor && materialHasColor(mat);
  const canOpacity = wantOpacity && materialSupportsOpacity(mat);
  if (!canColor && !canOpacity) return mat;

  const key = overrideMaterialCacheKey(
    canColor ? colorInput : undefined,
    canOpacity ? opacityOverride : undefined,
  );
  let perMat = colorOverrideMaterialCache.get(mat);
  if (!perMat) {
    perMat = new Map();
    colorOverrideMaterialCache.set(mat, perMat);
  }
  let cloned = perMat.get(key);
  if (!cloned) {
    cloned = mat.clone();
    if (canColor) {
      (cloned as Material & { color: Color }).color.setHex(
        colorHex(colorInput!),
      );
    }
    if (canOpacity) {
      const o = clampOpacity01(opacityOverride!);
      (cloned as Material & { opacity: number }).opacity = o;
      (cloned as Material & { transparent?: boolean }).transparent = o < 1;
    }
    perMat.set(key, cloned);
  }
  return cloned;
}

/**
 * 解析单个 mesh 最终要使用的 Material 实例。
 *
 * `color` / `opacity` 与 `material` 同级；`material` 本身不含内嵌 color/opacity 字段。
 * 带 `color` 的默认材质路径靠 {@link defaultColorMaterialCache} 共享实例；
 * 改写实例材质靠 {@link colorOverrideMaterialCache}。回调返回的材质在提供 `color` /
 * `opacity` 时**直接 mutate**（约定每次返回新实例）。
 */
export function resolveStyleMaterial(
  appearance: StyleAppearance,
  originalMaterial: Material,
  materialBuilder: MaterialBuilder,
): Material {
  const colorInput = appearance.color;
  const opacityRaw = appearance.opacity;
  // 未声明 opacity 时保持 undefined（不改写透明度），不能规范化成 1，
  // 否则下方"是否需要改写"的判断永远成立，材质实例会被 clone 并强制 transparent=false
  const opacityOverride =
    opacityRaw != null ? clampOpacity01(opacityRaw) : undefined;

  if (appearance.material === undefined) {
    if (colorInput !== undefined) {
      return getDefaultColorMaterial(
        colorInput,
        opacityOverride,
        materialBuilder,
      );
    }
    if (opacityOverride !== undefined) {
      return applyAppearanceOverridesToMaterialInstance(
        originalMaterial,
        undefined,
        opacityOverride,
      );
    }
    return originalMaterial;
  }

  if (typeof appearance.material === "function") {
    const mat = appearance.material(extractStyleMaterialMaps(originalMaterial));
    if (colorInput !== undefined && materialHasColor(mat)) {
      mat.color.setHex(colorHex(colorInput));
    }
    if (opacityOverride !== undefined && materialSupportsOpacity(mat)) {
      mat.opacity = opacityOverride;
      mat.transparent = opacityOverride < 1;
    }
    return mat;
  }

  if (colorInput !== undefined || opacityOverride !== undefined) {
    return applyAppearanceOverridesToMaterialInstance(
      appearance.material,
      colorInput,
      opacityOverride,
    );
  }
  return appearance.material;
}

/** 将 {@link StyleVec3Input}（Vector3 或 [x,y,z]）写入 target，原地修改 */
export function applyVec3(target: Vector3, input: StyleVec3Input): void {
  if (Array.isArray(input)) {
    target.set(input[0] ?? 0, input[1] ?? 0, input[2] ?? 0);
  } else {
    target.copy(input as Vector3);
  }
}

/** 将 {@link StyleEulerInput}（Euler 或 [x,y,z(,order)]）写入 target，原地修改 */
export function applyEuler(target: Euler, input: StyleEulerInput): void {
  if (Array.isArray(input)) {
    if (input.length >= 4 && typeof input[3] === "string") {
      target.set(
        input[0] ?? 0,
        input[1] ?? 0,
        input[2] ?? 0,
        input[3] as EulerOrder,
      );
    } else {
      target.set(input[0] ?? 0, input[1] ?? 0, input[2] ?? 0, "XYZ");
    }
  } else {
    target.copy(input as Euler);
  }
}

/**
 * 构建"绕枢轴 pivot 的缩放 + 旋转"矩阵：M = T(p) · R · S · T(-p)。
 *
 * 即先把 pivot 平移到原点应用 S/R，再平移回去——这样不同 mesh 即使坐标各异，
 * 给它们配置相同的 origin（如 mesh 自身中心）就能得到一致的"原地缩放/旋转"效果。
 */
export function buildPivotStyleMatrix(
  pivot: Vector3,
  sx: number,
  sy: number,
  sz: number,
  euler: Euler,
): Matrix4 {
  const m = new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
  m.premultiply(new Matrix4().makeScale(sx, sy, sz));
  m.premultiply(new Matrix4().makeRotationFromEuler(euler));
  m.premultiply(new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z));
  return m;
}
