import { BufferAttribute, BufferGeometry, Material } from "three";
import type {
  FeatureIdIndexData,
  GLTFWorkerData,
  PrimitiveExtensions,
} from "../types";

export interface PrimitiveData {
  geometry: BufferGeometry;
  material: Material;
  primitiveIndex: number;
  extensions?: PrimitiveExtensions;
  featureIdIndices?: Record<string, FeatureIdIndexData>;
}

/** glTF 顶点属性 → three.js 几何 attribute 名及其缺省 itemSize */
const VERTEX_ATTRIBUTE_SLOTS = [
  { gltf: "POSITION", name: "position", itemSize: 3 },
  { gltf: "NORMAL", name: "normal", itemSize: 3 },
  { gltf: "TEXCOORD_0", name: "uv", itemSize: 2 },
  { gltf: "COLOR_0", name: "color", itemSize: 3 },
  { gltf: "TANGENT", name: "tangent", itemSize: 4 },
] as const;

/**
 * Build Mesh Primitives from GLTF data
 */
export function buildMeshPrimitives(
  data: GLTFWorkerData,
  materialMap: Map<number, Material>,
  defaultMaterial: Material,
): Map<number, PrimitiveData[]> {
  const meshMap = new Map<number, PrimitiveData[]>();

  if (!data.meshes) {
    return meshMap;
  }

  for (const meshIndex in data.meshes) {
    const primitives = data.meshes[meshIndex].primitives;
    const primitiveDataList: PrimitiveData[] = [];

    for (const [primitiveIndex, primitive] of primitives.entries()) {
      const geometry = new BufferGeometry();

      // 标准顶点属性
      for (const { gltf, name, itemSize } of VERTEX_ATTRIBUTE_SLOTS) {
        const attrData = primitive.attributes?.[gltf];
        if (attrData?.array) {
          geometry.setAttribute(
            name,
            new BufferAttribute(attrData.array, attrData.itemSize || itemSize),
          );
        }
      }

      // Feature ID attribute（EXT_mesh_features），键名统一小写供样式条件匹配
      if (primitive.attributes) {
        for (const attrName in primitive.attributes) {
          if (!attrName.startsWith("_FEATURE_ID_")) {
            continue;
          }
          const featureIdData = primitive.attributes[attrName];
          if (featureIdData?.array) {
            geometry.setAttribute(
              attrName.toLowerCase(),
              new BufferAttribute(
                featureIdData.array,
                featureIdData.itemSize || 1,
              ),
            );
          }
        }
      }

      // Indices
      if (primitive.indices?.array) {
        geometry.setIndex(new BufferAttribute(primitive.indices.array, 1));
      }

      if (primitive.featureEdges?.positions.length) {
        geometry.userData.featureEdges = primitive.featureEdges;
      }

      // Get material
      const material =
        primitive.material !== undefined
          ? (materialMap.get(primitive.material) ?? defaultMaterial)
          : defaultMaterial;

      primitiveDataList.push({
        geometry,
        material,
        primitiveIndex,
        extensions: primitive.extensions,
        featureIdIndices: primitive.featureIdIndices,
      });
    }

    meshMap.set(Number(meshIndex), primitiveDataList);
  }

  return meshMap;
}
