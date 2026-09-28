import type { BufferGeometry } from "three";

/** 与源 index 同类型地分配新 index 数组（未指定类型时默认 Uint32Array） */
export function createIndexArray(
  sourceIndex: ArrayLike<number>,
  length: number,
): Uint16Array | Uint32Array {
  if (sourceIndex instanceof Uint32Array) return new Uint32Array(length);
  if (sourceIndex instanceof Uint16Array) return new Uint16Array(length);
  return new Uint32Array(length);
}

/**
 * split index 的取值上界是顶点数而非三角形数：position.count ≤ 65535 时
 * 降为 Uint16，省一半内存与 GPU 上传带宽（大瓦片常用 Uint32 index）。
 */
export function createSplitIndexArray(
  geometry: BufferGeometry,
  length: number,
): Uint16Array | Uint32Array {
  const position = geometry.getAttribute("position");
  return position && position.count <= 65535
    ? new Uint16Array(length)
    : new Uint32Array(length);
}
