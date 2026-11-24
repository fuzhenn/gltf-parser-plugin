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
 * 独享材质的所有权标记：挂在 mesh.material.userData 上。
 * 仅 clone / 工厂产物（插件自己创建的实例）会被标记，释放 split mesh 时据此
 * dispose 材质；用户传入的 `material` 实例不标记，绝不 dispose。
 */
const STYLE_OWNED_MATERIAL_KEY = "_gltfParserStyleOwnedMaterial";

function markStyleOwnedMaterial(mat: Material): void {
  const rec = mat as unknown as { userData?: Record<string, unknown> };
  if (!rec.userData) rec.userData = {};
  rec.userData[STYLE_OWNED_MATERIAL_KEY] = true;
}

function clampOpacity01(o: number): number {
  return Math.max(0, Math.min(1, o));
}

function materialHasColor(mat: Material): mat is Material & { color: Color } {
  const c = (mat as unknown as { color?: unknown }).color;
  return c instanceof Color;
}

function materialSupportsOpacity(mat: Material): boolean {
  return typeof (mat as unknown as { opacity?: unknown }).opacity === "number";
}

/**
 * 解析单个 mesh 最终要使用的 Material 实例。**仅在构建 split mesh 时调用一次**，
 * 之后的 color/opacity 更新走 {@link applyStyleColorOpacity} 原地写入，不再 resolve。
 *
 * - `material` 未声明 → clone 瓦片原材质（独享，标记所有权）；
 * - `material` 为函数 → 调用工厂（约定每次返回新实例 → 标记所有权，可释放）；
 * - `material` 为实例 → 直接使用用户实例（不标记，绝不 dispose）。
 *
 * color/opacity 不在此处应用，统一由 {@link applyStyleColorOpacity} 写入。
 */
export function resolveStyleMaterial(
  appearance: StyleAppearance,
  originalMaterial: Material,
): Material {
  if (appearance.material === undefined) {
    const owned = originalMaterial.clone();
    markStyleOwnedMaterial(owned);
    return owned;
  }

  if (typeof appearance.material === "function") {
    const mat = appearance.material(extractStyleMaterialMaps(originalMaterial));
    markStyleOwnedMaterial(mat);
    return mat;
  }

  return appearance.material;
}

/**
 * 把 appearance 声明的 color/opacity **原地写入**独享材质（高频路径：
 * applyStyle 快速分支与 getSplitMeshes 同步均调用，零分配零编译）。
 * 仅写声明的字段：color 未声明不动颜色，opacity 未声明不动透明度；
 * 材质数组材质不支持原地 c/o，直接跳过。
 */
export function applyStyleColorOpacity(
  mat: Material,
  appearance: StyleAppearance,
): void {
  if (Array.isArray(mat)) return;
  const colorInput = appearance.color;
  const opacity =
    appearance.opacity != null ? clampOpacity01(appearance.opacity) : undefined;

  if (colorInput !== undefined && materialHasColor(mat)) {
    mat.color.set(colorInput);
  }
  if (opacity !== undefined && materialSupportsOpacity(mat)) {
    (mat as Material & { opacity: number }).opacity = opacity;
    (mat as Material & { transparent?: boolean }).transparent = opacity < 1;
  }
}

/** 释放带所有权标记的独享材质（用户传入的实例材质无标记，不 dispose） */
export function disposeOwnedStyleMaterial(
  material: Material | Material[],
): void {
  if (Array.isArray(material)) return;
  const rec = material as unknown as { userData?: Record<string, unknown> };
  if (rec.userData?.[STYLE_OWNED_MATERIAL_KEY]) material.dispose();
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
