import type { Euler, Material, Vector3 } from "three";

/** 与 Vector3 等价：Three 的 Vector3 或长度≥3 的 [x,y,z] 数组 */
export type StyleVec3Input = Vector3 | readonly number[];

/** 与 Euler 等价：Three 的 Euler，或 [x,y,z] / [x,y,z,order] */
export type StyleEulerInput = Euler | readonly number[];

/** 条件命中后的外观：材质必填，位姿可选（未传则不改对应分量） */
export interface StyleAppearance {
  material: Material;
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
