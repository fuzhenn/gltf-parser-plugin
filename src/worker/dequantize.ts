import type { AttributeData, AttributeArray } from "./types";

/**
 * 解码一对 oct 编码量化分量为单位向量（标准八面体映射），写入 out[offset..offset+2]。
 * normals 与 tangent 的 oct 解码共用此实现。
 */
export function decodeOctUnitVector(
  qx: number,
  qy: number,
  maxVal: number,
  out: Float32Array,
  offset: number,
): void {
  // Convert quantized values to [-1, 1] range
  let x = (qx / maxVal) * 2 - 1;
  let y = (qy / maxVal) * 2 - 1;

  // Oct decoding
  let z = 1 - Math.abs(x) - Math.abs(y);

  if (z < 0) {
    const oldX = x;
    x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    y = (1 - Math.abs(oldX)) * (y >= 0 ? 1 : -1);
  }

  // Normalize
  const len = Math.sqrt(x * x + y * y + z * z);
  out[offset] = x / len;
  out[offset + 1] = y / len;
  out[offset + 2] = z / len;
}

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
  const { array: quantized, quantization: quant } = attrData;

  if (!quant) return quantized;

  // 固定长度的 ArrayBuffer 无法原地扩展，需 decoder 侧以 resizable buffer 分配才行
  const result = new Float32Array(quantized.length);
  const maxQuantizedValue = (1 << quant.quantizationBits) - 1;

  if (quant.range !== undefined && quant.minValues) {
    // value = minValues[j] + (q / maxQuantizedValue) * range
    const { minValues, range } = quant;
    const count = quantized.length / itemSize;

    for (let i = 0; i < count; i++) {
      const base = i * itemSize;
      for (let j = 0; j < itemSize; j++) {
        const idx = base + j;
        result[idx] =
          (quantized[idx] / maxQuantizedValue) * range + minValues[j];
      }
    }
  } else {
    // 缺 range/minValues 时仅按量化位深归一化
    for (let i = 0; i < quantized.length; i++) {
      result[i] = quantized[i] / maxQuantizedValue;
    }
  }

  return result;
}
