import type { AttributeData, AttributeArray } from "./types";

/**
 * Dequantize Draco quantized data
 * @param attrData - The attribute data with quantization info
 * @param itemSize - Number of components per vertex (e.g., 3 for position)
 * @returns Dequantized Float32Array or original array if no quantization
 */
export function dequantizeAttribute(
  attrData: AttributeData,
  itemSize: number,
): Float32Array | AttributeArray {
  const { array, quantization: quant } = attrData;

  if (!quant) return array;

  const count = array.length / itemSize;
  // TODO 利用arraybuffer.resize方法复用array
  const result = new Float32Array(array.length);
  const maxQuantizedValue = (1 << quant.quantizationBits) - 1;

  // Dequantize using range and minValues
  if (quant.range !== undefined && quant.minValues) {
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < itemSize; j++) {
        const idx = i * itemSize + j;
        result[idx] =
          (array[idx] / maxQuantizedValue) * quant.range + quant.minValues[j];
      }
    }
  } else {
    // Simple normalization
    for (let i = 0; i < array.length; i++) {
      result[i] = array[i] / maxQuantizedValue;
    }
  }

  return result;
}
