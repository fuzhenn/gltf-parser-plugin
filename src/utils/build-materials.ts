import {
  DoubleSide,
  FrontSide,
  Material,
  ShaderMaterial,
  Texture,
  Vector3,
  Vector4,
} from "three";
import type { GLTFWorkerData, MaterialBuilder } from "../types";

/** 与 glTF 2.0 / three.js GLTFLoader 一致 */
const GLTF_ALPHA_OPAQUE = "OPAQUE";
const GLTF_ALPHA_MASK = "MASK";
const GLTF_ALPHA_BLEND = "BLEND";

/**
 * 顶点着色器（方案 A：沿用 issue#165 的 GLSL 逻辑，改用 three.js ShaderMaterial 内置命名）
 * three.js 会自动注入：attribute position/normal/uv/color，uniform modelViewMatrix/projectionMatrix 等，
 * 因此这里不再重复声明（重复声明会导致 “redefinition” 编译错误）。
 *
 * 相比原文修正：
 * - 移除未声明的 localPositionMatrix（原文 bug），mvPosition 复用 modelViewMatrix * localPosition；
 * - 补上 HAS_COLOR 分支缺失的 `varying vec4 vColor` 声明。
 */
const VERTEX_SHADER = /* glsl */ `
#ifdef HAS_MAP
varying vec2 vTexCoord;
#endif
#ifdef HAS_COLOR
varying vec4 vColor;
#endif

varying highp vec3 vViewPosition;

void main() {
  vec4 localPosition = vec4(position, 1.0);
  vec4 mvPosition = modelViewMatrix * localPosition;
  gl_Position = projectionMatrix * mvPosition;
  vViewPosition = -mvPosition.xyz;

  #ifdef HAS_MAP
  vTexCoord = uv;
  #endif
  #ifdef HAS_COLOR
  // three.js 的 color attribute 已是归一化浮点，无需像原文那样再除以 255
  vColor = color;
  #endif
}
`;

/**
 * 片元着色器（来自 issue#165，适配 three.js ShaderMaterial）
 *
 * 适配/修正点：
 * - 删除 three.js 会自动注入的 viewMatrix / cameraPosition 声明；projMatrix → projectionMatrix；
 * - 补上 HAS_MAP 下缺失的 `varying vec2 vTexCoord` 声明；
 * - 原文使用了未声明的 glFragColor，这里在 main 内显式声明为局部变量；
 * - lightDiffuse 原文未初始化，这里初始化为 0；
 * - 修正原文一处语法错误的空 `#elif` 为 `#else`；
 * - 结尾直接写 gl_FragColor（ShaderMaterial 默认走 GLSL ES 1.00）。
 *
 * 默认不开启的重型特性（glTF 无法提供对应数据）：HAS_IBL_LIGHTING / SHADING_MODEL_SPECULAR_GLOSSINESS /
 * TONEMAP_OUTPUT / HAS_SHADOWMAP / GAMMA_INPUT / METAL。如需启用，自行补 defines 与对应 uniforms 即可。
 */
const FRAGMENT_SHADER = /* glsl */ `
#define saturate(x)        clamp(x, 0.0, 1.0)

#define GET_BASEMAP(UV) (texture2D(baseColorTexture, (UV)))
// three.js 不会向片元阶段注入 projectionMatrix（仅注入到顶点阶段），故此处显式声明；
// 由于它是 three 的内置 uniform，渲染时会自动从相机赋值，无需放入 uniforms。
uniform mat4 projectionMatrix;
#if defined(HAS_IBL_LIGHTING)
    uniform mat4 viewMatrixInverse;
#endif
uniform vec4 baseColorFactor;
uniform vec3 emissiveFactor;
uniform vec3 specularFactor;
uniform float opacity;
uniform float envRotationSin;
uniform float envRotationCos;
uniform float rgbmRange;

#ifdef HAS_MAP
    varying vec2 vTexCoord;
#endif

#ifdef HAS_BASECOLOR_MAP
    uniform sampler2D baseColorTexture;
#endif
#ifdef HAS_NORMAL_MAP
    uniform sampler2D normalTexture;
    vec3 perturbNormal2Arb(vec3 eye_pos, vec3 surf_norm) {
        vec3 q0 = dFdx(eye_pos.xyz);
        vec3 q1 = dFdy(eye_pos.xyz);
        vec3 S = normalize(q0 - q1);
        vec3 T = normalize(-q0 + q1);
        vec3 N = normalize(surf_norm);
        vec3 mapN = texture2D(normalTexture, vTexCoord).rgb * 2.0 - 1.0;
        mat3 tsn = mat3(S, T, N);
        return normalize(tsn * mapN);
    }
#endif
#ifdef HAS_EMISSIVE_MAP
    uniform sampler2D emissiveTexture;
#endif
#ifdef SHADING_MODEL_SPECULAR_GLOSSINESS
    uniform vec4 diffuseFactor;
    #ifdef HAS_DIFFUSE_MAP
        uniform sampler2D diffuseTexture;
    #endif
    #ifdef HAS_SPECULARGLOSSINESS_MAP
        uniform sampler2D specularGlossinessTexture;
    #endif
#endif


#if defined(HAS_COLOR) || defined(HAS_COLOR0)
    varying vec4 vColor;
#endif

#ifdef GAMMA_INPUT
    vec3 InputToLinear(vec3 c) {
        return c * c;
    }
    float InputToLinear(float c) {
        return c * c;
    }
#else
    vec3 InputToLinear(vec3 c) {
        return c;
    }
    float InputToLinear(float c) {
        return c;
    }
#endif

vec3 GET_SPECULAR() {
  #ifdef SHADING_MODEL_SPECULAR_GLOSSINESS
    #ifdef HAS_SPECULARGLOSSINESS_MAP
      return texture2D(specularGlossinessTexture, vTexCoord).rgb;
    #else
      return specularFactor;
    #endif
  #else
      return specularFactor;
  #endif
}

vec3 GET_EMISSIVE() {
  #ifdef HAS_EMISSIVE_MAP
    return texture2D(emissiveTexture, vTexCoord).rgb;
  #else
    return emissiveFactor;
  #endif
}
#if defined(TONEMAP_OUTPUT)
  #if TONEMAP_OUTPUT > 0
      uniform float exposureBias;
      float luminance_post(vec3 rgb) {
          return dot(rgb, vec3(0.299, 0.587, 0.114));
      }
      float luminance_pre(vec3 rgb) {
          return dot(rgb, vec3(0.212671, 0.715160, 0.072169));
      }
      vec3 xyz2rgb(vec3 xyz) {
          vec3 R = vec3(3.240479, -1.537150, -0.498535);
          vec3 G = vec3(-0.969256, 1.875992, 0.041556);
          vec3 B = vec3(0.055648, -0.204043, 1.057311);
          vec3 rgb;
          rgb.b = dot(xyz, B);
          rgb.g = dot(xyz, G);
          rgb.r = dot(xyz, R);
          return rgb;
      }
      vec3 rgb2xyz(vec3 rgb) {
          vec3 X = vec3(0.412453, 0.35758, 0.180423);
          vec3 Y = vec3(0.212671, 0.71516, 0.0721688);
          vec3 Z = vec3(0.0193338, 0.119194, 0.950227);
          vec3 xyz;
          xyz.x = dot(rgb, X);
          xyz.y = dot(rgb, Y);
          xyz.z = dot(rgb, Z);
          return xyz;
      }
      vec3 xyz2xyY(vec3 xyz) {
          float sum = xyz.x + xyz.y + xyz.z;
          sum = 1.0 / sum;
          vec3 xyY;
          xyY.z = xyz.y;
          xyY.x = xyz.x * sum;
          xyY.y = xyz.y * sum;
          return xyY;
      }
      vec3 xyY2xyz(vec3 xyY) {
          float x = xyY.x;
          float y = xyY.y;
          float Y = xyY.z;
          vec3 xyz;
          xyz.y = Y;
          xyz.x = x * (Y / y);
          xyz.z = (1.0 - x - y) * (Y / y);
          return xyz;
      }
      float toneMapCanon_T(float x) {
          float xpow = pow(x, 1.60525727);
          float tmp = ((1.05542877*4.68037409)*xpow) / (4.68037409*xpow + 1.0);
          return clamp(tmp, 0.0, 1.0);
      }
      const float Shift = 1.0 / 0.18;
      float toneMapCanonFilmic_NoGamma(float x) {
          x *= Shift;
          const float A = 0.2;
          const float B = 0.34;
          const float C = 0.002;
          const float D = 1.68;
          const float E = 0.0005;
          const float F = 0.252;
          const float scale = 1.0/0.833837;
          return (((x*(A*x+C*B)+D*E)/(x*(A*x+B)+D*F))-E/F) * scale;
      }
      vec3 toneMapCanonFilmic_WithGamma(vec3 x) {
          x *= Shift;
          const float A = 0.27;
          const float B = 0.29;
          const float C = 0.052;
          const float D = 0.2;
          const float F = 0.18;
          const float scale = 1.0/0.897105;
          return (((x*(A*x+C*B))/(x*(A*x+B)+D*F))) * scale;
      }
      vec3 toneMapCanonOGS_WithGamma_WithColorPerserving(vec3 x) {
          vec3 outColor = x.rgb;
          outColor = min(outColor, vec3(3.0));
          float inLum = luminance_pre(outColor);
          if (inLum > 0.0) {
              float outLum = toneMapCanon_T(inLum);
              outColor = outColor * (outLum / inLum);
              outColor = clamp(outColor, vec3(0.0), vec3(1.0));
          }
          float gamma = 1.0/2.2;
          outColor = pow(outColor, vec3(gamma));
          return outColor;
      }
  #endif
#endif

#if defined(IRR_RGBM) || defined(ENV_RGBM) || defined(ENV_GAMMA) || defined(IRR_GAMMA)
    uniform float envMapExposure;
#endif

uniform vec4 themingColor;
uniform mat3 environmentTransform;

vec3 applyEnvShadow(vec3 colorWithoutShadow, vec3 worldNormal) {
    #if defined(HAS_SHADOWMAP)
        float dp = dot(shadowLightDir, worldNormal);
        float dpValue = (dp + 1.0) / 2.0;
        dpValue = min(1.0, dpValue * 1.5);
        float sv = 1.0;
        vec3 result = colorWithoutShadow * min(sv, dpValue);
        return result;
    #else
        return colorWithoutShadow;
    #endif
}
#ifdef HAS_IBL_LIGHTING
    uniform float reflectivity;
    uniform vec3 hdrHSV;
    uniform samplerCube prefilterMap;
    uniform vec3 diffuseSPH[9];
    uniform vec2 prefilterMiplevel;
    uniform vec2 prefilterSize;
#else
    uniform vec3 ambientColor;
#endif

#if defined(HAS_IBL_LIGHTING)
    vec3 computeDiffuseSPH(const in vec3 normal) {
        vec3 n = environmentTransform * normal;
        float x = n.x;
        float y = n.y;
        float z = n.z;
        vec3 result = (
            diffuseSPH[0] +

            diffuseSPH[1] * x +
            diffuseSPH[2] * y +
            diffuseSPH[3] * z +

            diffuseSPH[4] * z * x +
            diffuseSPH[5] * y * z +
            diffuseSPH[6] * y * x +
            diffuseSPH[7] * (3.0 * z * z - 1.0) +
            diffuseSPH[8] * (x*x - y*y)
        );
        if (length(hdrHSV) > 0.0) {
            result = hsv_apply(result, hdrHSV);
        }
        return max(result, vec3(0.0));
    }

    vec3 decodeRGBM(const in vec4 color, const in float range) {
      if(range <= 0.0) return color.rgb;
      return range * color.rgb * color.a;
    }

    float linRoughnessToMipmap(const in float roughnessLinear) {
        return roughnessLinear;
    }
    vec3 prefilterEnvMapCube(const in float rLinear, const in vec3 R) {
        vec3 dir = R;
        float maxLevels = prefilterMiplevel.x;
        float lod = min(maxLevels, linRoughnessToMipmap(rLinear) * prefilterMiplevel.y);
        vec3 envLight = decodeRGBM(textureCubeLod(prefilterMap, dir, lod), rgbmRange);
        if (length(hdrHSV) > 0.0) {
            return hsv_apply(envLight, hdrHSV);
        } else {
            return envLight;
        }
    }
    vec3 getSpecularDominantDir(const in vec3 N, const in vec3 R, const in float realRoughness) {
        float smoothness = 1.0 - realRoughness;
        float lerpFactor = smoothness * (sqrt(smoothness) + realRoughness);
        return mix(N, R, lerpFactor);
    }
    vec3 getPrefilteredEnvMapColor(const in vec3 normal, const in vec3 eyeVector, const in float roughness, const in vec3 frontNormal) {
        vec3 R = reflect(-eyeVector, normal);
        R = getSpecularDominantDir(normal, R, roughness);
        vec3 prefilteredColor = prefilterEnvMapCube(roughness, environmentTransform * R);
        float factor = clamp(1.0 + dot(R, frontNormal), 0.0, 1.0);
        prefilteredColor *= factor * factor;
        return prefilteredColor;
    }
#else
    vec3 getPrefilteredEnvMapColor(const in vec3 normal, const in vec3 eyeVector, const in float roughness, const in vec3 frontNormal) {
        return ambientColor;
    }
#endif

varying highp vec3 vViewPosition;

vec3 Schlick_v3(vec3 v, float cosHV) {
    float facing = max(1.0 - cosHV, 0.0);
    return v + (1.0 - v) * pow(facing, 5.0);
}
float Schlick_f(float v, float cosHV) {
    float facing = max(1.0 - cosHV, 0.0);
    return v + (1.0 - v) * pow(facing, 5.0);
}


void main() {
    vec4 glFragColor = vec4(vec3(1.0), opacity);
    #ifdef HAS_BASECOLOR_MAP
        vec4 baseColor = GET_BASEMAP(vTexCoord);
        #ifdef GAMMA_INPUT
            baseColor.xyz *= baseColor.xyz;
        #endif
        glFragColor = glFragColor * baseColor;
    #endif

    #ifdef ALPHATEST
        if (glFragColor.a < ALPHATEST) discard;
    #endif
    float specularStrength = 1.0;
    vec3 fdx = dFdx(vViewPosition);
    vec3 fdy = dFdy(vViewPosition);
    vec3 normal = normalize(cross(fdx, fdy));

    vec3 viewDirection;
    if (projectionMatrix[3][3] == 0.0) {
        viewDirection = normalize(vViewPosition);
    } else {
        viewDirection = vec3(0.0, 0.0, 1.0);
    }
    normal = faceforward(normal, -viewDirection, normal);
    vec3 geomNormal = normal;
    #ifdef HAS_NORMAL_MAP
        normal = perturbNormal2Arb(-vViewPosition, normal);
    #endif

    vec3 totalDiffuse = vec3(0.0);
    vec3 totalSpecular = vec3(0.0);

    #ifdef HAS_IBL_LIGHTING
        vec3 worldNormal = mat3(viewMatrixInverse) * normal;
        vec3 indirectDiffuse = glFragColor.rgb * computeDiffuseSPH(worldNormal) * 0.5;
        indirectDiffuse = applyEnvShadow(indirectDiffuse, worldNormal);
        totalDiffuse += InputToLinear(baseColorFactor.rgb) * indirectDiffuse;
    #endif
    vec3 emissive = GET_EMISSIVE();
    #ifdef METAL
        glFragColor.xyz = glFragColor.xyz * (InputToLinear(emissive) + totalDiffuse + InputToLinear(baseColorFactor.rgb) + totalSpecular);
    #else
        glFragColor.xyz = glFragColor.xyz * (InputToLinear(emissive) + totalDiffuse + InputToLinear(baseColorFactor.rgb)) + totalSpecular;
    #endif

    vec3 lightDiffuse = vec3(0.0);

    #ifdef HAS_COLOR
        glFragColor = glFragColor * vColor;
    #endif
    glFragColor.rgb += lightDiffuse;
    #if defined(HAS_IBL_LIGHTING)
        vec3 reflectVec;
        #if defined(HAS_NORMAL_MAP)
            #ifdef ENVMAP_MODE_REFLECTION
                reflectVec = reflect(-viewDirection, normal);
            #else
                reflectVec = refract(-viewDirection, normal, 1.0);
            #endif
        #else
            reflectVec = reflect(-viewDirection, normal);
        #endif

        reflectVec = mat3(viewMatrixInverse) * reflectVec;
        float reflectScale = 1.0;
        vec3 ambient;
        #ifdef HAS_IBL_LIGHTING
          ambient = vec3(0.0);
        #else
          ambient = ambientColor;
        #endif
        ambient *= reflectScale;
        float facing = dot(viewDirection, normal);
        if (facing < -1e-2  || reflectivity == 0.0)
        facing = 1.0;
        else
        facing = max(1e-6, facing);

        vec3 schlickRefl;
        vec3 specular = GET_SPECULAR();
        #ifdef METAL
          schlickRefl = InputToLinear(specular);
        #else
            schlickRefl = Schlick_v3(InputToLinear(specular), facing) * (1.0 - envRotationSin);
            glFragColor.a = mix(glFragColor.a, Schlick_f(glFragColor.a, facing), reflectivity) * envRotationCos;
            float invSchlick = pow(1.0 - facing * 0.5, 5.0);
            float norm_factor = (28.0 / 23.0) * (1.0 - invSchlick) * (1.0 - invSchlick);
            glFragColor.rgb *= norm_factor * (1.0 - InputToLinear(specular));
        #endif
        glFragColor.rgb += ambient.rgb * specularStrength * schlickRefl.rgb;
    #endif
    #if defined(TONEMAP_OUTPUT)
      #if TONEMAP_OUTPUT == 1
          glFragColor.rgb = toneMapCanonOGS_WithGamma_WithColorPerserving(exposureBias * glFragColor.rgb);
          #elif TONEMAP_OUTPUT == 2
          glFragColor.rgb = toneMapCanonFilmic_WithGamma(exposureBias * glFragColor.rgb);
      #endif
    #endif
    glFragColor.rgb = mix(glFragColor.rgb, themingColor.rgb, themingColor.a);
    gl_FragColor = glFragColor;
}
`;

/** 将数值格式化为 GLSL float 字面量（define 值必须带小数点） */
function toGLSLFloat(value: number): string {
  const s = String(value);
  return s.includes(".") || s.includes("e") || s.includes("E") ? s : `${s}.0`;
}

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
  const uniforms: Record<string, { value: unknown }> = {
    baseColorFactor: { value: new Vector4(1, 1, 1, 1) },
    emissiveFactor: { value: new Vector3(0, 0, 0) },
    opacity: { value: 1.0 },
    // themingColor.a 为 0 时末尾的 mix 不产生任何影响
    themingColor: { value: new Vector4(0, 0, 0, 0) },
    baseColorTexture: { value: null as Texture | null },
    normalTexture: { value: null as Texture | null },
    emissiveTexture: { value: null as Texture | null },
  };
  const defines: Record<string, string | boolean> = {};

  // PBR base color：rgb 进 baseColorFactor，a 进 opacity（alpha 走 opacity 链路）
  if (matData.pbrMetallicRoughness) {
    const pbr = matData.pbrMetallicRoughness;

    if (pbr.baseColorFactor) {
      (uniforms.baseColorFactor.value as Vector4).set(
        pbr.baseColorFactor[0],
        pbr.baseColorFactor[1],
        pbr.baseColorFactor[2],
        pbr.baseColorFactor[3] !== undefined ? pbr.baseColorFactor[3] : 1,
      );
      if (pbr.baseColorFactor[3] !== undefined) {
        uniforms.opacity.value = pbr.baseColorFactor[3];
      }
    }

    // Base color texture -> HAS_MAP + HAS_BASECOLOR_MAP
    if (pbr.baseColorTexture && pbr.baseColorTexture.index !== undefined) {
      const tex = textureMap.get(pbr.baseColorTexture.index);
      if (tex) {
        uniforms.baseColorTexture.value = tex;
        defines.HAS_MAP = "";
        defines.HAS_BASECOLOR_MAP = "";
      }
    }
  }

  // Normal map（IBL 关闭时 normal 不参与光照，仅保持与原 shader 一致的接线）
  if (matData.normalTexture && matData.normalTexture.index !== undefined) {
    const tex = textureMap.get(matData.normalTexture.index);
    if (tex) {
      uniforms.normalTexture.value = tex;
      defines.HAS_MAP = "";
      defines.HAS_NORMAL_MAP = "";
    }
  }

  // Emissive
  if (matData.emissiveTexture && matData.emissiveTexture.index !== undefined) {
    const tex = textureMap.get(matData.emissiveTexture.index);
    if (tex) {
      uniforms.emissiveTexture.value = tex;
      defines.HAS_MAP = "";
      defines.HAS_EMISSIVE_MAP = "";
    }
  }
  if (matData.emissiveFactor) {
    (uniforms.emissiveFactor.value as Vector3).set(
      matData.emissiveFactor[0],
      matData.emissiveFactor[1],
      matData.emissiveFactor[2],
    );
  }

  // doubleSided：默认 false（glTF 2.0）
  const side = matData.doubleSided === true ? DoubleSide : FrontSide;

  // alphaMode / alphaCutoff：与 glTF 2.0 及 three.js GLTFLoader 一致
  // https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#_material_alphamode
  const alphaMode = matData.alphaMode ?? GLTF_ALPHA_OPAQUE;

  let transparent = false;
  let depthWrite = true;

  if (alphaMode === GLTF_ALPHA_BLEND) {
    transparent = true;
    depthWrite = false;
  } else if (alphaMode === GLTF_ALPHA_MASK) {
    // shader 内通过 #ifdef ALPHATEST 手动 discard
    const cutoff =
      matData.alphaCutoff !== undefined ? matData.alphaCutoff : 0.5;
    defines.ALPHATEST = toGLSLFloat(cutoff);
  }

  const material = new ShaderMaterial({
    uniforms,
    defines,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side,
    transparent,
    depthWrite,
  });

  return material;
}
