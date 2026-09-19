import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
} from "three";
import type { GLTFWorkerData } from "../types";

export interface TextureBuildResult {
  textureMap: Map<number, Texture>;
  /** 与 textureMap 同构的稠密数组（下标即 texture index），供按索引取用的元数据处理 */
  textureArray: Texture[];
}

/**
 * Build textures from GLTF data
 */
export function buildTextures(data: GLTFWorkerData): TextureBuildResult {
  const textureMap = new Map<number, Texture>();
  const textureArray: Texture[] = [];

  if (!data.textures) {
    return { textureMap, textureArray };
  }

  for (const [index, textureData] of data.textures.entries()) {
    const imageData = textureData.image;
    let texture: Texture;

    if (imageData?.array) {
      texture = new DataTexture(
        imageData.array,
        imageData.width,
        imageData.height,
        RGBAFormat,
        UnsignedByteType,
      );
      // DataTexture 默认 NearestFilter 且不生成 mipmap，贴图会锯齿/远看闪烁；
      // 对齐 three.js GLTFLoader 的图像纹理采样（WebGL2 支持 NPOT mipmap）
      texture.generateMipmaps = true;
      texture.magFilter = LinearFilter;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.needsUpdate = true;
    } else {
      // 缺图占位纹理
      texture = new Texture();
    }

    // glTF 图像为 sRGB 编码，默认 sRGB；线性槽位（normal 等）由 build-materials 按槽位纠正
    texture.flipY = false;
    texture.colorSpace = SRGBColorSpace;

    textureMap.set(index, texture);
    textureArray[index] = texture;
  }

  return { textureMap, textureArray };
}
