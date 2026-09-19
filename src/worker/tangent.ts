import type { AttributeData, AttributeArray } from "./types";
import { decodeOctUnitVector, dequantizeAttribute } from "./dequantize";

/**
 * Decode tangent data (may have oct-encoding)
 * @param attrData - The attribute data with tangent info
 * @returns Decoded Float32Array with xyzw tangents or original array
 */
export function decodeTangent(
  attrData: AttributeData,
): Float32Array | AttributeArray {
  const { array, quantization: quant } = attrData;

  if (!quant || !quant.octEncoded) {
    // Normal quantization or no quantization
    return quant ? dequantizeAttribute(attrData, 4) : array;
  }

  const maxVal = (1 << quant.quantizationBits) - 1;
  const count = array.length / 3; // oct(2) + w(1)
  const result = new Float32Array(count * 4);

  for (let i = 0; i < count; i++) {
    const q = i * 3;
    const w = i * 4;
    decodeOctUnitVector(array[q], array[q + 1], maxVal, result, w);
    // w 分量：量化值落在上半区间为正手性
    result[w + 3] = array[q + 2] > maxVal / 2 ? 1 : -1;
  }

  return result;
}
