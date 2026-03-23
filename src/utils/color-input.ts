import { Color } from "three";

/** 可解析为 THREE.Color 的输入 */
export type ColorInput = number | string | Color;

export function toColor(value: ColorInput): Color {
  return value instanceof Color ? value : new Color(value);
}
