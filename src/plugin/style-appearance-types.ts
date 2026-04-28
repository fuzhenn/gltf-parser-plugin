import type {
  BufferGeometry,
  Euler,
  Material,
  Mesh,
  Texture,
  Vector3,
} from "three";
import type { ColorInput } from "../utils/color-input";

/** 与 Vector3 等价：Three 的 Vector3 或长度≥3 的 [x,y,z] 数组 */
export type StyleVec3Input = Vector3 | readonly number[];

/** 与 Euler 等价：Three 的 Euler，或 [x,y,z] / [x,y,z,order] */
export type StyleEulerInput = Euler | readonly number[];

/**
 * 从构件原始材质上可读取的常见贴图（供 material 为函数时使用，如解构 { map, normalMap }）
 */
export interface StyleMaterialMaps {
  map?: Texture | null;
  normalMap?: Texture | null;
  metalnessMap?: Texture | null;
  roughnessMap?: Texture | null;
  aoMap?: Texture | null;
  emissiveMap?: Texture | null;
}

/**
 * 基于原始贴图生成最终材质（与直接传入 Material 实例二选一）
 */
export type StyleMaterialResolver = (maps: StyleMaterialMaps) => Material;

/**
 * 用几何与（解析后的）材质构建 Mesh；返回值会合并回同一 mesh 实例以保持收集器引用
 */
export type StyleMeshFactory = (
  geometry: BufferGeometry,
  material: Material,
) => Mesh;

/** 条件命中后的外观：材质与位姿均可选（未传则保留原 mesh 对应分量） */
export interface StyleAppearance {
  /**
   * 直接材质，或根据 {@link StyleMaterialMaps} 从原构件材质生成。
   * 不含 `color` / `opacity` 字段；着色与透明度请使用同级的 {@link StyleAppearance.color}、{@link StyleAppearance.opacity}。
   */
  material?: Material | StyleMaterialResolver;
  /**
   * 与 `material` 同级：直接以颜色参与解析（可被 JSON 序列化）。
   * - 仅提供 `color`（且无 `material`）：使用默认 `MeshStandardMaterial`；
   * - 与 `material` 同时提供：解析 material 后写入其 `.color`（若存在该属性）。
   *   实例材质会克隆后再改；回调返回的材质会直接修改 `.color`，请确保每次返回新实例。
   */
  color?: ColorInput;
  /**
   * 与 `material` 同级：0–1，写入解析结果材质的 `opacity` / `transparent`（若材质支持）。
   * 可与 `color` 组合；仅 `opacity` 时会在原材质或默认色材质上应用透明度。
   */
  opacity?: number;
  /**
   * 可选：自定义 Mesh 构建；默认仅替换 geometry/material。
   * 返回的 Mesh 会将其 geometry、material 写回当前 split mesh，uuid 不变。
   */
  mesh?: StyleMeshFactory;
  translation?: StyleVec3Input;
  scale?: StyleVec3Input;
  rotation?: StyleEulerInput;
  /** mesh 局部空间中的枢轴；未传则 (0,0,0) */
  origin?: StyleVec3Input;
}

/** 条件项：[条件表达式或 true, 外观对象] */
export type StyleCondition = [string | boolean, StyleAppearance];

/** 样式配置 */
export interface StyleConfig {
  show?: string;
  conditions?: StyleCondition[];
}
