import { BufferAttribute, BufferGeometry, Material, MeshStandardMaterial } from "three";
import type { GLTFWorkerData, PrimitiveExtensions } from "../types";

export interface PrimitiveData {
  geometry: BufferGeometry;
  material: Material;
  primitiveIndex: number;
  extensions?: PrimitiveExtensions;
}

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
    const meshData = data.meshes[meshIndex];
    const primitiveDataList: PrimitiveData[] = [];
    const primitives = meshData.primitives;

    for (
      let primitiveIndex = 0;
      primitiveIndex < primitives.length;
      primitiveIndex++
    ) {
      const primitive = primitives[primitiveIndex];
      const geometry = new BufferGeometry();

      // Handle vertex attributes
      if (primitive.attributes) {
        // Position
        const posData = primitive.attributes.POSITION;
        if (posData && posData.array) {
          geometry.setAttribute(
            "position",
            new BufferAttribute(posData.array, posData.itemSize || 3),
          );
        }

        // Normal
        const normalData = primitive.attributes.NORMAL;
        if (normalData && normalData.array) {
          geometry.setAttribute(
            "normal",
            new BufferAttribute(normalData.array, normalData.itemSize || 3),
          );
        }

        // UV coordinates
        const uvData = primitive.attributes.TEXCOORD_0;
        if (uvData && uvData.array) {
          geometry.setAttribute(
            "uv",
            new BufferAttribute(uvData.array, uvData.itemSize || 2),
          );
        }

        // Vertex color
        const colorData = primitive.attributes.COLOR_0;
        if (colorData && colorData.array) {
          geometry.setAttribute(
            "color",
            new BufferAttribute(colorData.array, colorData.itemSize || 3),
          );
        }

        // Tangent
        const tangentData = primitive.attributes.TANGENT;
        if (tangentData && tangentData.array) {
          geometry.setAttribute(
            "tangent",
            new BufferAttribute(tangentData.array, tangentData.itemSize || 4),
          );
        }

        // Feature ID attribute (for EXT_mesh_features)
        for (const attrName in primitive.attributes) {
          if (attrName.startsWith("_FEATURE_ID_")) {
            const featureIdData = primitive.attributes[attrName];
            if (featureIdData && featureIdData.array) {
              const normalizedName = attrName
                .toLowerCase()
                .replace("_feature_id_", "_feature_id_");
              geometry.setAttribute(
                normalizedName,
                new BufferAttribute(
                  featureIdData.array,
                  featureIdData.itemSize || 1,
                ),
              );
            }
          }
        }
      }

      // Indices
      const indexData = primitive.indices;
      if (indexData && indexData.array) {
        geometry.setIndex(new BufferAttribute(indexData.array, 1));
      }

      // Get material
      const material =
        primitive.material !== undefined
          ? materialMap.get(primitive.material) || defaultMaterial
          : defaultMaterial;

      if (!geometry.hasAttribute("normal") && material instanceof MeshStandardMaterial) {
        material.flatShading = true;
      }

      primitiveDataList.push({
        geometry,
        material,
        primitiveIndex,
        extensions: primitive.extensions,
      });
    }

    meshMap.set(Number(meshIndex), primitiveDataList);
  }

  return meshMap;
}
