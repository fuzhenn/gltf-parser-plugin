import { Material, Texture } from "three";

// EXT_mesh_features extension data
interface MeshFeaturesExtension {
  featureIds: Array<{
    featureCount: number;
    propertyTable?: number;
    nullFeatureId?: number;
    label?: string;
    attribute?: number;
    texture?: {
      index: number;
      texCoord?: number;
      channels?: number[];
    };
  }>;
}

// EXT_structural_metadata extension data
interface StructuralMetadataExtension {
  schema: {
    id?: string;
    name?: string;
    description?: string;
    version?: string;
    classes?: Record<
      string,
      {
        name?: string;
        description?: string;
        properties?: Record<
          string,
          {
            name?: string;
            description?: string;
            type: string;
            componentType?: string;
            enumType?: string;
            array?: boolean;
            count?: number;
            normalized?: boolean;
            offset?: number | number[];
            scale?: number | number[];
            min?: number | number[];
            max?: number | number[];
            required?: boolean;
            noData?: any;
            default?: any;
          }
        >;
      }
    >;
    enums?: Record<
      string,
      {
        name?: string;
        description?: string;
        valueType?: string;
        values: Array<{
          name: string;
          value: number;
          description?: string;
        }>;
      }
    >;
  };
  propertyTables?: Array<{
    name?: string;
    class: string;
    count: number;
    properties?: Record<
      string,
      {
        values: number;
        arrayOffsets?: number;
        stringOffsets?: number;
        arrayOffsetType?: string;
        stringOffsetType?: string;
        offset?: number | number[];
        scale?: number | number[];
        min?: number | number[];
        max?: number | number[];
      }
    >;
  }>;
  propertyTextures?: Array<{
    name?: string;
    class: string;
    properties?: Record<
      string,
      {
        index: number;
        texCoord?: number;
        channels?: number[];
        offset?: number | number[];
        scale?: number | number[];
        min?: number | number[];
        max?: number | number[];
      }
    >;
  }>;
  propertyAttributes?: Array<{
    name?: string;
    class: string;
    properties?: Record<
      string,
      {
        attribute: string;
        offset?: number | number[];
        scale?: number | number[];
        min?: number | number[];
        max?: number | number[];
      }
    >;
  }>;
}

// Primitive extension data
export interface PrimitiveExtensions {
  EXT_mesh_features?: MeshFeaturesExtension;
  EXT_structural_metadata?: {
    propertyTextures?: number[];
    propertyAttributes?: number[];
  };
}

export interface GLTFWorkerData {
  textures?: Array<{
    image?: {
      array: Uint8Array;
      width: number;
      height: number;
    };
  }>;
  materials?: Array<{
    pbrMetallicRoughness?: {
      baseColorFactor?: number[];
      baseColorTexture?: { index: number };
      metallicFactor?: number;
      roughnessFactor?: number;
      metallicRoughnessTexture?: { index: number };
    };
    normalTexture?: { index: number; scale?: number };
    occlusionTexture?: { index: number };
    emissiveTexture?: { index: number };
    emissiveFactor?: number[];
    doubleSided?: boolean;
    alphaMode?: string;
    alphaCutoff?: number;
  }>;
  meshes?: Record<
    string,
    {
      primitives: Array<{
        attributes?: {
          POSITION?: { array: Float32Array; itemSize: number };
          NORMAL?: { array: Float32Array; itemSize: number };
          TEXCOORD_0?: { array: Float32Array; itemSize: number };
          COLOR_0?: { array: Float32Array; itemSize: number };
          TANGENT?: { array: Float32Array; itemSize: number };
          // Feature ID attributes (e.g., _FEATURE_ID_0)
          [key: string]:
            | {
                array: Float32Array | Uint16Array | Uint32Array;
                itemSize: number;
              }
            | undefined;
        };
        indices?: { array: Uint16Array | Uint32Array };
        material?: number;
        // Preserve extensions for metadata
        extensions?: PrimitiveExtensions;
      }>;
    }
  >;
  scenes: Array<{
    nodes: Array<GLTFNodeData>;
  }>;
  // Original GLTF JSON for metadata processing
  json?: {
    extensionsUsed?: string[];
    extensions?: {
      EXT_structural_metadata?: StructuralMetadataExtension;
      [key: string]: any;
    };
    meshes?: Array<{
      primitives: Array<{
        extensions?: PrimitiveExtensions;
      }>;
    }>;
    [key: string]: any;
  };
  // Pre-loaded structural metadata data
  structuralMetadata?: {
    schema: StructuralMetadataExtension["schema"];
    propertyTables: StructuralMetadataExtension["propertyTables"];
    buffers: Array<ArrayBuffer>;
  };
}

export interface InstanceData {
  count: number;
  TRANSLATION?: Float32Array;
  ROTATION?: Float32Array;
  SCALE?: Float32Array;
}

export interface GLTFNodeData {
  name?: string;
  mesh: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  children?: GLTFNodeData[];
  instanceData?: InstanceData;
}

export type MaterialBuilder = (
  matData: unknown,
  textureMap: Map<number, Texture>,
) => Material;
