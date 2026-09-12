import {
  DataTexture,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
} from "three";
import type { GLTFWorkerData } from "../types";

export interface TextureBuildResult {
  textureMap: Map<number, Texture>;
  textureArray: (Texture | null)[];
}

/**
 * Build textures from GLTF data
 */
export function buildTextures(data: GLTFWorkerData): TextureBuildResult {
  const textureMap = new Map<number, Texture>();
  const textureArray: (Texture | null)[] = [];

  if (!data.textures) {
    return { textureMap, textureArray };
  }

  for (const [index, textureData] of data.textures.entries()) {
    if (textureData.image && textureData.image.array) {
      const imageData = textureData.image;
      const tex = new DataTexture(
        imageData.array,
        imageData.width,
        imageData.height,
        RGBAFormat,
        UnsignedByteType,
      );
      tex.flipY = false;
      tex.colorSpace = SRGBColorSpace;
      tex.needsUpdate = true;
      textureMap.set(index, tex);
      textureArray[index] = tex;
      continue;
    }

    // Default empty texture
    const texture = new Texture();
    texture.flipY = false;
    textureMap.set(index, texture);
    textureArray[index] = texture;
  }

  return { textureMap, textureArray };
}
