import { dequantizeAttribute } from "./dequantize";
import type { AttributeData } from "./types";
import { decodeTangent } from "./tangent";

type FeatureIdIndexEntry = { offset: number; length: number };

type FeatureIdIndexData = {
  buffer: Uint16Array | Uint32Array;
  map: Record<number, FeatureIdIndexEntry>;
};

/**
 * 在 worker 内、传回主线程之前，按 `_FEATURE_ID_*` 顶点属性把 index 按 featureId 分组。
 * 分组规则与主线程保持一致：以三角形首个顶点的 feature id 归属整片三角形。
 * 产出的 buffer 为新建 typed array，调用方需将其加入 transferables 零拷贝回传。
 */
function buildFeatureIdIndices(
  indexArray: Uint16Array | Uint32Array | number[],
  attributes: Record<string, any>,
  addTransferable: (arr: any) => void,
): Record<string, FeatureIdIndexData> | undefined {
  let result: Record<string, FeatureIdIndexData> | undefined;

  for (const attrName in attributes) {
    if (!attrName.startsWith("_FEATURE_ID_")) continue;
    const fidArray = attributes[attrName]?.array;
    if (!fidArray) continue;

    const fidChunks = new Map<number, number[]>();
    for (let i = 0; i < indexArray.length; i += 3) {
      const a = indexArray[i]!;
      const b = indexArray[i + 1]!;
      const c = indexArray[i + 2]!;
      const fid = fidArray[a];

      let chunk = fidChunks.get(fid);
      if (!chunk) {
        chunk = [];
        fidChunks.set(fid, chunk);
      }
      chunk.push(a, b, c);
    }

    let total = 0;
    for (const chunk of fidChunks.values()) total += chunk.length;

    const buffer =
      indexArray instanceof Uint16Array
        ? new Uint16Array(total)
        : new Uint32Array(total);
    const map: Record<number, FeatureIdIndexEntry> = {};
    let offset = 0;
    for (const [fid, chunk] of fidChunks) {
      buffer.set(chunk, offset);
      map[fid] = { offset, length: chunk.length };
      offset += chunk.length;
    }

    addTransferable(buffer);
    (result ||= {})[attrName.toLowerCase()] = { buffer, map };
  }

  return result;
}

/**
 * Process and dequantize GLTF data
 * @param data - Raw GLTF data from loader
 * @returns Processed data with transferables array
 */
export function processGLTFData(data: any): {
  data: any;
  transferables: ArrayBuffer[];
} {
  const transferables = data.transferables || [];
  const addTransferable = (arr: any) => {
    if (arr && arr.buffer && !transferables.includes(arr.buffer)) {
      transferables.push(arr.buffer);
    }
  };

  // Helper to process attribute: ensure structure and mark as transferable
  const processAttribute = (
    key: string,
    itemSize: number,
    attributes: Record<string, any>,
    decoder?: (attr: AttributeData) => any,
  ) => {
    const attr = attributes[key];
    if (attr && attr.array) {
      // if else
      const processed = decoder
        ? decoder(attr)
        : attr.quantization
          ? dequantizeAttribute(attr, itemSize)
          : attr.array;
      attributes[key] = { array: processed, itemSize };
      addTransferable(processed);
      return processed;
    }
    return null;
  };

  if (data.meshes) {
    for (const meshData of Object.values(data.meshes) as any[]) {
      for (const primitive of meshData.primitives) {
        const { attributes } = primitive;
        if (!attributes) continue;

        // Process position
        processAttribute("POSITION", 3, attributes);

        // Process normals
        processAttribute("NORMAL", 3, attributes);

        // Process UV
        processAttribute("TEXCOORD_0", 2, attributes);

        // Process vertex colors
        const colorData = attributes.COLOR_0;
        if (colorData && colorData.array) {
          const itemSize = colorData.type === "VEC4" ? 4 : 3;
          processAttribute("COLOR_0", itemSize, attributes);
        }

        // Process tangents
        processAttribute("TANGENT", 4, attributes, decodeTangent);

        // Process Feature ID attributes (for EXT_mesh_features)
        let hasFeatureId = false;
        for (const attrName in attributes) {
          if (attrName.startsWith("_FEATURE_ID_")) {
            processAttribute(attrName, 1, attributes);
            hasFeatureId = true;
          }
        }

        // 解析完成后、回传主线程前，预构建按 fid 分组的 index
        const indexArray = primitive.indices?.array;
        if (hasFeatureId && indexArray && indexArray.length > 0) {
          const featureIdIndices = buildFeatureIdIndices(
            indexArray,
            attributes,
            addTransferable,
          );
          if (featureIdIndices) {
            primitive.featureIdIndices = featureIdIndices;
          }
        }
      }
    }
  }

  // Process EXT_mesh_gpu_instancing on scene nodes
  if (data.scenes) {
    const processNode = (node: any) => {
      const instancingExt = node.extensions?.EXT_mesh_gpu_instancing;
      if (instancingExt?.attributes) {
        const attrs = instancingExt.attributes;
        const refAttr =
          attrs.TRANSLATION ||
          attrs.ROTATION ||
          attrs.SCALE ||
          Object.values(attrs)[0];
        if (refAttr) {
          const refArray = refAttr.array || refAttr;
          const refItemSize =
            refAttr.itemSize ||
            (refAttr === attrs.ROTATION
              ? 4
              : refAttr === attrs.TRANSLATION || refAttr === attrs.SCALE
                ? 3
                : 1);
          const count = refArray.length / refItemSize;

          const instanceData: Record<string, any> = { count };

          for (const [key, attr] of Object.entries(attrs)) {
            const arr = (attr as any).array || attr;
            const itemSize =
              (attr as any).itemSize ||
              (key === "ROTATION"
                ? 4
                : key === "TRANSLATION" || key === "SCALE"
                  ? 3
                  : arr.length / count);
            if (!arr || arr.length !== count * itemSize) continue;

            instanceData[key] = arr;
            addTransferable(arr);
          }

          node.instanceData = instanceData;
        }
      }

      if (node.children) {
        for (const child of node.children) {
          processNode(child);
        }
      }
    };

    for (const scene of data.scenes) {
      if (scene.nodes) {
        for (const node of scene.nodes) {
          processNode(node);
        }
      }
    }
  }

  return { data, transferables };
}
