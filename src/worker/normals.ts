import type { AttributeData, AttributeArray } from "./types";
import { dequantizeAttribute } from "./dequantize";

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
    // Convert quantized values to [-1, 1] range
    let x = (array[i * 2] / maxQuantizedValue) * 2 - 1;
    let y = (array[i * 2 + 1] / maxQuantizedValue) * 2 - 1;

    // Oct decoding
    let z = 1 - Math.abs(x) - Math.abs(y);

    if (z < 0) {
      const oldX = x;
      x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
      y = (1 - Math.abs(oldX)) * (y >= 0 ? 1 : -1);
    }

    // Normalize
    const len = Math.sqrt(x * x + y * y + z * z);
    result[i * 3] = x / len;
    result[i * 3 + 1] = y / len;
    result[i * 3 + 2] = z / len;
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

  // Helper: get triangle indices
  const getTriangleIndices = indexArray
    ? (out: number[], i: number) => {
        out[0] = indexArray[i];
        out[1] = indexArray[i + 1];
        out[2] = indexArray[i + 2];
      }
    : (out: number[], i: number) => {
        out[0] = i;
        out[1] = i + 1;
        out[2] = i + 2;
      };

  const triangleCount = indexArray ? indexArray.length / 3 : vertexCount / 3;

  // Temporary vectors for calculation
  const pA = [0, 0, 0];
  const pB = [0, 0, 0];
  const pC = [0, 0, 0];
  const cb = [0, 0, 0];
  const ab = [0, 0, 0];

  const out = [0, 0, 0];
  // Accumulate face normals to vertices
  for (let i = 0; i < triangleCount; i++) {
    // 效率低,out参数
    getTriangleIndices(out, i * 3);

    // Get vertex positions
    pA[0] = posArray[out[0] * 3];
    pA[1] = posArray[out[0] * 3 + 1];
    pA[2] = posArray[out[0] * 3 + 2];

    pB[0] = posArray[out[1] * 3];
    pB[1] = posArray[out[1] * 3 + 1];
    pB[2] = posArray[out[1] * 3 + 2];

    pC[0] = posArray[out[2] * 3];
    pC[1] = posArray[out[2] * 3 + 1];
    pC[2] = posArray[out[2] * 3 + 2];

    // Calculate edge vectors: cb = pC - pB, ab = pA - pB
    cb[0] = pC[0] - pB[0];
    cb[1] = pC[1] - pB[1];
    cb[2] = pC[2] - pB[2];

    ab[0] = pA[0] - pB[0];
    ab[1] = pA[1] - pB[1];
    ab[2] = pA[2] - pB[2];

    // Cross product: faceNormal = cb × ab
    const nx = cb[1] * ab[2] - cb[2] * ab[1];
    const ny = cb[2] * ab[0] - cb[0] * ab[2];
    const nz = cb[0] * ab[1] - cb[1] * ab[0];

    // Accumulate face normal to each vertex of the triangle
    normals[out[0] * 3] += nx;
    normals[out[0] * 3 + 1] += ny;
    normals[out[0] * 3 + 2] += nz;

    normals[out[1] * 3] += nx;
    normals[out[1] * 3 + 1] += ny;
    normals[out[1] * 3 + 2] += nz;

    normals[out[2] * 3] += nx;
    normals[out[2] * 3 + 1] += ny;
    normals[out[2] * 3 + 2] += nz;
  }

  // Normalize all vertex normals
  for (let i = 0; i < vertexCount; i++) {
    let x = normals[i * 3];
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
