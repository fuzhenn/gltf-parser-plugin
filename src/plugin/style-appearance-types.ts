import type {
  BufferGeometry,
  Euler,
  Material,
  Mesh,
  Texture,
  Vector3,
} from "three";

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

/** 条件命中后的外观：材质必填，位姿可选（未传则不改对应分量） */
export interface StyleAppearance {
  /** 直接材质，或根据 {@link StyleMaterialMaps} 从原构件材质生成 */
  material: Material | StyleMaterialResolver;
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
