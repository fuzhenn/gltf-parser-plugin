import type { AttributeData, AttributeArray } from "./types";
import { dequantizeAttribute } from "./dequantize";

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

  // Oct-encoded tangents require special handling
  const maxVal = (1 << quant.quantizationBits) - 1;
  const count = array.length / 3; // oct(2) + w(1)
  const result = new Float32Array(count * 4);

  for (let i = 0; i < count; i++) {
    // Decode oct-encoded xyz
    let x = (array[i * 3] / maxVal) * 2 - 1;
    let y = (array[i * 3 + 1] / maxVal) * 2 - 1;
    let z = 1 - Math.abs(x) - Math.abs(y);

    if (z < 0) {
      const oldX = x;
      x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
      y = (1 - Math.abs(oldX)) * (y >= 0 ? 1 : -1);
    }

    const len = Math.sqrt(x * x + y * y + z * z);
    result[i * 4] = x / len;
    result[i * 4 + 1] = y / len;
    result[i * 4 + 2] = z / len;
    // w component: 1 or -1
    result[i * 4 + 3] = array[i * 3 + 2] > maxVal / 2 ? 1 : -1;
  }

  return result;
}
