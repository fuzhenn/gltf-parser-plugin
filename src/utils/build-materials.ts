import {
  DoubleSide,
  FrontSide,
  Material,
  MeshStandardMaterial,
  Texture,
} from "three";
import type { GLTFWorkerData, MaterialBuilder } from "../types";

/** 与 glTF 2.0 / three.js GLTFLoader 一致 */
const GLTF_ALPHA_OPAQUE = "OPAQUE";
const GLTF_ALPHA_MASK = "MASK";
const GLTF_ALPHA_BLEND = "BLEND";

/**
 * Build materials from GLTF data
 */
export function buildMaterials(
  data: GLTFWorkerData,
  textureMap: Map<number, Texture>,
  customMaterialBuilder?: MaterialBuilder,
): Map<number, Material> {
  const materialMap = new Map<number, Material>();

  if (!data.materials) {
    return materialMap;
  }

  const materialBuilder = customMaterialBuilder || defaultMaterialBuilder;

  for (const [index, matData] of data.materials.entries()) {
    const material = materialBuilder(matData, textureMap);

    materialMap.set(index, material);
  }

  return materialMap;
}

function defaultMaterialBuilder(
  matData: any,
  textureMap: Map<number, Texture>,
): Material {
  const material = new MeshStandardMaterial();

  // PBR material properties
  if (matData.pbrMetallicRoughness) {
    const pbr = matData.pbrMetallicRoughness;

    // Base color（A 通道写入 opacity；是否与透明混合由下方 alphaMode 决定，见 glTF 2.0 material）
    if (pbr.baseColorFactor) {
      material.color.setRGB(
        pbr.baseColorFactor[0],
        pbr.baseColorFactor[1],
        pbr.baseColorFactor[2],
      );
      if (pbr.baseColorFactor[3] !== undefined) {
        material.opacity = pbr.baseColorFactor[3];
      }
    }

    // Base color texture
    if (pbr.baseColorTexture && pbr.baseColorTexture.index !== undefined) {
      const tex = textureMap.get(pbr.baseColorTexture.index);
      if (tex) {
        material.map = tex;
      }
    }

    // Metalness and roughness
    material.metalness =
      pbr.metallicFactor !== undefined ? pbr.metallicFactor : 1.0;
    material.roughness =
      pbr.roughnessFactor !== undefined ? pbr.roughnessFactor : 1.0;

    // Metallic roughness texture
    if (
      pbr.metallicRoughnessTexture &&
      pbr.metallicRoughnessTexture.index !== undefined
    ) {
      const tex = textureMap.get(pbr.metallicRoughnessTexture.index);
      if (tex) {
        material.metalnessMap = material.roughnessMap = tex;
      }
    }
  }

  // Normal map
  if (matData.normalTexture && matData.normalTexture.index !== undefined) {
    const tex = textureMap.get(matData.normalTexture.index);
    if (tex) {
      material.normalMap = tex;
      if (matData.normalTexture.scale !== undefined) {
        material.normalScale.set(
          matData.normalTexture.scale,
          matData.normalTexture.scale,
        );
      }
    }
  }

  // Occlusion map
  if (
    matData.occlusionTexture &&
    matData.occlusionTexture.index !== undefined
  ) {
    const tex = textureMap.get(matData.occlusionTexture.index);
    if (tex) {
      material.aoMap = tex;
    }
  }

  // Emissive
  if (matData.emissiveTexture && matData.emissiveTexture.index !== undefined) {
    const tex = textureMap.get(matData.emissiveTexture.index);
    if (tex) {
      material.emissiveMap = tex;
    }
  }
  if (matData.emissiveFactor) {
    material.emissive.setRGB(
      matData.emissiveFactor[0],
      matData.emissiveFactor[1],
      matData.emissiveFactor[2],
    );
  }

  // doubleSided：默认 false（glTF 2.0）
  material.side = matData.doubleSided === true ? DoubleSide : FrontSide;

  // alphaMode / alphaCutoff：与 glTF 2.0 及 three.js GLTFLoader 一致
  // https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#_material_alphamode
  const alphaMode = matData.alphaMode ?? GLTF_ALPHA_OPAQUE;

  if (alphaMode === GLTF_ALPHA_BLEND) {
    material.transparent = true;
    material.depthWrite = false;
  } else {
    material.transparent = false;
    if (alphaMode === GLTF_ALPHA_MASK) {
      material.alphaTest =
        matData.alphaCutoff !== undefined ? matData.alphaCutoff : 0.5;
    } else {
      // OPAQUE：不使用 alpha 裁剪；规范要求忽略 alpha 用于混合，此处与 Loader 一致保留 opacity 供贴图 A 通道等
      material.alphaTest = 0;
    }
  }

  return material;
}
