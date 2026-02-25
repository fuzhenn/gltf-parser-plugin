import { dequantizeAttribute } from "./dequantize";
import type { AttributeData } from "./types";
import { decodeTangent } from "./tangent";

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
        for (const attrName in attributes) {
          if (attrName.startsWith("_FEATURE_ID_")) {
            processAttribute(attrName, 1, attributes);
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
        const translationAttr = attrs.TRANSLATION;
        const rotationAttr = attrs.ROTATION;
        const scaleAttr = attrs.SCALE;

        // Derive instance count from the first available attribute
        const refAttr = translationAttr || rotationAttr || scaleAttr;
        if (refAttr) {
          const refArray = refAttr.array || refAttr;
          const itemSize =
            refAttr.itemSize || (refAttr === rotationAttr ? 4 : 3);
          const count = refArray.length / itemSize;

          const instanceData: Record<string, any> = { count };

          if (translationAttr) {
            const arr = translationAttr.array || translationAttr;
            instanceData.TRANSLATION = arr;
            addTransferable(arr);
          }
          if (rotationAttr) {
            const arr = rotationAttr.array || rotationAttr;
            instanceData.ROTATION = arr;
            addTransferable(arr);
          }
          if (scaleAttr) {
            const arr = scaleAttr.array || scaleAttr;
            instanceData.SCALE = arr;
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
