import type { AttributeData, AttributeArray } from "./types";
import { decodeOctUnitVector, dequantizeAttribute } from "./dequantize";

/**
 * Decode oct-encoded normals
 * @param attrData - The attribute data with oct-encoded normals
 * @returns Decoded Float32Array with xyz normals or original array
 */
export function decodeOctEncodedNormals(
  attrData: AttributeData,
): Float32Array | AttributeArray {
  const { array, quantization: quant } = attrData;

  if (!quant || !quant.octEncoded) {
    return quant ? dequantizeAttribute(attrData, 3) : array;
  }

  const maxQuantizedValue = (1 << quant.quantizationBits) - 1;
  const count = array.length / 2; // oct-encoded has 2 components
  const result = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const q = i * 2;
    decodeOctUnitVector(array[q], array[q + 1], maxQuantizedValue, result, i * 3);
  }

  return result;
}

/**
 * Compute vertex normals from position and index data
 * @param posArray - Position array (xyz per vertex)
 * @param indexArray - Index array (optional, null for non-indexed geometry)
 * @returns Computed normals as Float32Array
 */
export function computeVertexNormals(
  posArray: Float32Array,
  indexArray: Uint16Array | Uint32Array | null,
): Float32Array {
  const vertexCount = posArray.length / 3;
  const normals = new Float32Array(posArray.length);

  // 将单个三角面的法线（未归一化，隐含面积权重）累加到三个顶点
  const accumulateFaceNormal = (i0: number, i1: number, i2: number) => {
    const ax = posArray[i0 * 3];
    const ay = posArray[i0 * 3 + 1];
    const az = posArray[i0 * 3 + 2];
    const bx = posArray[i1 * 3];
    const by = posArray[i1 * 3 + 1];
    const bz = posArray[i1 * 3 + 2];
    const cx = posArray[i2 * 3];
    const cy = posArray[i2 * 3 + 1];
    const cz = posArray[i2 * 3 + 2];

    // cb = C - B，ab = A - B，面法线 = cb × ab（与 three.js 一致）
    const cbx = cx - bx;
    const cby = cy - by;
    const cbz = cz - bz;
    const abx = ax - bx;
    const aby = ay - by;
    const abz = az - bz;

    const nx = cby * abz - cbz * aby;
    const ny = cbz * abx - cbx * abz;
    const nz = cbx * aby - cby * abx;

    normals[i0 * 3] += nx;
    normals[i0 * 3 + 1] += ny;
    normals[i0 * 3 + 2] += nz;

    normals[i1 * 3] += nx;
    normals[i1 * 3 + 1] += ny;
    normals[i1 * 3 + 2] += nz;

    normals[i2 * 3] += nx;
    normals[i2 * 3 + 1] += ny;
    normals[i2 * 3 + 2] += nz;
  };

  // 有索引：每 3 个索引一个三角；无索引：每 3 个连续顶点一个三角
  if (indexArray) {
    for (let i = 0; i < indexArray.length; i += 3) {
      accumulateFaceNormal(indexArray[i], indexArray[i + 1], indexArray[i + 2]);
    }
  } else {
    for (let v = 0; v < vertexCount; v += 3) {
      accumulateFaceNormal(v, v + 1, v + 2);
    }
  }

  // Normalize all vertex normals
  for (let i = 0; i < vertexCount; i++) {
    const x = normals[i * 3];
    const y = normals[i * 3 + 1];
    const z = normals[i * 3 + 2];
    const len = Math.sqrt(x * x + y * y + z * z);

    if (len > 0) {
      const invLen = 1 / len;
      normals[i * 3] *= invLen;
      normals[i * 3 + 1] *= invLen;
      normals[i * 3 + 2] *= invLen;
    }
  }

  return normals;
}
