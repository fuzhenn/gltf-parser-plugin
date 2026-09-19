import { dequantizeAttribute } from "./dequantize";
import type { AttributeData } from "./types";
import type { FeatureIdIndexData, IndexRange } from "../types";
import { decodeTangent } from "./tangent";
import {
  buildFeatureEdgePositions,
  DEFAULT_FEATURE_EDGE_THRESHOLD_DEG,
} from "./edges";

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

    // 两遍扫描直写 typed array，避免中间 number[] 的装箱与二次拷贝：
    // 第一遍按 fid 统计三角数，得出各 fid 的 buffer 区间；第二遍按区间写入
    const triCount = Math.floor(indexArray.length / 3);
    const triCountPerFid = new Map<number, number>();
    for (let i = 0; i < triCount * 3; i += 3) {
      const fid = fidArray[indexArray[i]];
      triCountPerFid.set(fid, (triCountPerFid.get(fid) ?? 0) + 1);
    }

    const buffer =
      indexArray instanceof Uint16Array
        ? new Uint16Array(triCount * 3)
        : new Uint32Array(triCount * 3);
    const featureIdIndexMap: Record<number, IndexRange> = {};
    const writeCursors = new Map<number, number>();
    let offset = 0;
    for (const [fid, count] of triCountPerFid) {
      const length = count * 3;
      featureIdIndexMap[fid] = { offset, length };
      writeCursors.set(fid, offset);
      offset += length;
    }

    for (let i = 0; i < triCount * 3; i += 3) {
      const fid = fidArray[indexArray[i]];
      const write = writeCursors.get(fid)!;
      buffer[write] = indexArray[i];
      buffer[write + 1] = indexArray[i + 1];
      buffer[write + 2] = indexArray[i + 2];
      writeCursors.set(fid, write + 3);
    }

    addTransferable(buffer);
    (result ||= {})[attrName.toLowerCase()] = {
      buffer,
      featureIdIndexMap,
    };
  }

  return result;
}

/** EXT_mesh_gpu_instancing 已知属性的分量数（缺省 1） */
function instanceAttrItemSize(key: string): number {
  return key === "ROTATION" ? 4 : key === "TRANSLATION" || key === "SCALE" ? 3 : 1;
}

/** 处理节点上的 EXT_mesh_gpu_instancing，汇总实例 TRS 属性 */
function processInstancingExtension(
  node: any,
  instancingExt: { attributes: Record<string, any> },
  addTransferable: (arr: any) => void,
): void {
  const attrs = instancingExt.attributes;

  // 以 TRANSLATION/ROTATION/SCALE（或首个属性）的长度确定实例数
  const refKey = attrs.TRANSLATION
    ? "TRANSLATION"
    : attrs.ROTATION
      ? "ROTATION"
      : attrs.SCALE
        ? "SCALE"
        : Object.keys(attrs)[0];
  const refAttr = refKey !== undefined ? attrs[refKey] : undefined;
  if (!refAttr) return;

  const refArray = refAttr.array || refAttr;
  const refItemSize = refAttr.itemSize || instanceAttrItemSize(refKey);
  const count = refArray.length / refItemSize;

  const instanceData: Record<string, any> = { count };

  for (const [key, attr] of Object.entries(attrs)) {
    const arr = attr.array || attr;
    if (!arr) continue;
    const knownSize = instanceAttrItemSize(key);
    const itemSize =
      attr.itemSize || (knownSize !== 1 ? knownSize : arr.length / count);
    if (arr.length !== count * itemSize) continue;

    instanceData[key] = arr;
    addTransferable(arr);
  }

  node.instanceData = instanceData;
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

        const positionArray = attributes.POSITION?.array as
          | Float32Array
          | undefined;
        if (
          positionArray &&
          indexArray &&
          indexArray.length >= 3 &&
          positionArray.length >= 9
        ) {
          const featureEdges = buildFeatureEdgePositions(
            positionArray,
            indexArray,
            DEFAULT_FEATURE_EDGE_THRESHOLD_DEG,
          );
          if (featureEdges.positions.length > 0) {
            addTransferable(featureEdges.positions.buffer);
            primitive.featureEdges = featureEdges;
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
        processInstancingExtension(node, instancingExt, addTransferable);
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
