import type { WebGLRenderer } from "three";
import type { StyleConfig } from "./plugin/style-appearance-types";
import type { MaterialBuilder } from "./types";

/**
 * structure.json 中的树节点结构
 */
export interface StructureNode {
  id?: number;
  name?: string;
  bbox?: number[];
  children?: StructureNode[];
  [key: string]: unknown;
}

/**
 * structure.json 的完整数据结构
 */
export interface StructureData {
  defaultTree?: number;
  idField?: string;
  trees: StructureNode[];
}

/**
 * modelInfo.json 的数据结构
 */
export interface ModelInfo {
  animatable: boolean;
  images: number;
  materials: number;
  pbr: boolean;
  textures: number;
  triangles: number;
  vertices: number;
}

/**
 * GLTFParserPlugin configuration options
 */
export interface GLTFParserPluginOptions {
  /**
   * WebGLRenderer instance, required for mesh helper features (hidePartsByOids, etc.)
   */
  renderer?: WebGLRenderer;
  /**
   * Whether to enable metadata support
   * Includes EXT_mesh_features and EXT_structural_metadata extensions
   * @default true
   */
  metadata?: boolean;
  /**
   * Maximum number of workers in the worker pool
   * Maximum value is navigator.hardwareConcurrency
   * @default navigator.hardwareConcurrency
   */
  maxWorkers?: number;

  /**
   * Custom material builder function
   * Used to handle GLTF material extensions or custom material logic
   */
  materialBuilder?: MaterialBuilder;

  /**
   * Callback function before parsing
   * Used to preprocess the buffer before parsing GLTF
   */
  beforeParseTile?: (
    buffer: ArrayBuffer,
    tile: any,
    extension: any,
    uri: string,
    abortSignal: AbortSignal,
  ) => Promise<ArrayBuffer>;

  /**
   * Whether to enable IndexedDB caching for tile data
   * @default false
   */
  useIndexedDB?: boolean;

  /**
   * 初始构件样式，语义与 `setStyle` / `plugin.style` 相同。
   * 在 `init` 内会在已遍历到的瓦片场景就绪后应用；后续瓦片通过 `load-model` / `tiles-load-end` 触发收集器更新并重应用样式。
   */
  style?: StyleConfig | null;
}
