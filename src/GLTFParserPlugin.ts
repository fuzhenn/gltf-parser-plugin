import {
  DoubleSide,
  Intersection,
  Material,
  Mesh,
  Object3D,
  WebGLRenderer,
} from "three";
import {
  FeatureIdUniforms,
  FeatureInfo,
  buildOidToFeatureIdMap,
  getSplitMeshesFromTile,
  getTileMeshesByOid,
  queryFeatureFromIntersection,
} from "./mesh-helper";

import { MeshCollector, type MeshHelperHost } from "./MeshCollector";
import { GLTFWorkerLoader } from "./GLTFWorkerLoader";
import type { MaterialBuilder } from "./types";
import { setMaxWorkers } from "./utils";
import { tileCache } from "./db";
import { TilesRenderer } from "3d-tiles-renderer";

interface TileWithCache {
  cached?: {
    scene: Object3D;
  };
}

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
 * GLTFParserPlugin configuration options
 */
export interface GLTFParserPluginOptions {
  /**
   * WebGLRenderer instance, required for mesh helper features (hideByOids, etc.)
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
}

export class GLTFParserPlugin implements MeshHelperHost {
  name = "GLTFParserPlugin";

  private tiles: (TilesRenderer & Record<string, any>) | null = null;
  private _loader: GLTFWorkerLoader | null = null;
  private readonly _gltfRegex = /\.(gltf|glb)$/g;
  private readonly _options: GLTFParserPluginOptions;

  // --- Structure data properties ---
  private _structureData: StructureData | null = null;
  private _oidNodeMap: Map<number, StructureNode> = new Map();
  private _structurePromise: Promise<StructureData | null> | null = null;

  // --- Mesh helper properties ---
  oids: number[] = [];
  private renderer: WebGLRenderer | null = null;
  private splitMeshCache: Map<string, Mesh[]> = new Map();
  private maxUniformVectors: number = 1024;
  private featureIdCount: number = 32;
  private collectors: Set<MeshCollector> = new Set();
  private collectorCache: Map<number, MeshCollector> = new Map();

  /**
   * Create a GLTFParserPlugin instance
   * @param options configuration options
   */
  constructor(options?: GLTFParserPluginOptions) {
    this._options = {
      metadata: true,
      maxWorkers: navigator.hardwareConcurrency || 4,
      useIndexedDB: false,
      ...options,
    };

    if (options?.renderer) {
      this.renderer = options.renderer;
    }

    setMaxWorkers(this._options.maxWorkers!);
  }

  /**
   * Plugin initialization, called by TilesRenderer
   */
  init(tiles: TilesRenderer) {
    this.tiles = tiles;

    // --- GLTF loader setup ---
    this._loader = new GLTFWorkerLoader(tiles.manager, {
      metadata: this._options.metadata,
      materialBuilder: this._options.materialBuilder,
    });
    tiles.manager.addHandler(this._gltfRegex, this._loader);

    // --- Mesh helper setup ---
    if (this.renderer) {
      this._updateWebGLLimits();
    }

    tiles.addEventListener("load-model", this._onLoadModelCB);
    tiles.addEventListener("tiles-load-end", this._onTilesLoadEndCB);

    tiles.traverse((tile: any) => {
      const tileWithCache = tile as TileWithCache;
      if (tileWithCache.cached?.scene) {
        this._onLoadModel(tileWithCache.cached.scene);
      }
      return true;
    }, null);
  }

  // =============================================
  // GLTF Parser Methods
  // =============================================

  /**
   * Fetch tile data with IndexedDB caching support
   */
  async fetchData(
    url: string,
    options?: RequestInit,
  ): Promise<Response | ArrayBuffer | object> {
    const isJson = url.toLowerCase().endsWith(".json");
    if (!this._options.useIndexedDB || isJson) {
      return this.tiles!.fetchData(url, options);
    }

    try {
      const cachedData = await tileCache.get(url);

      if (cachedData) {
        return cachedData;
      }

      const response = await this.tiles!.fetchData(url, options);

      if (!response.ok) {
        return response;
      }

      const arrayBuffer = await response.arrayBuffer();

      tileCache.set(url, arrayBuffer).catch((err: unknown) => {
        console.warn("[GLTFParserPlugin] Failed to cache data:", err);
      });

      return arrayBuffer;
    } catch (error) {
      return this.tiles!.fetchData(url, options);
    }
  }

  /**
   * Clear all cached tile data from IndexedDB
   */
  async clearCache(): Promise<void> {
    await tileCache.clear();
    console.info("[GLTFParserPlugin] Cache cleared");
  }

  async parseTile(
    buffer: ArrayBuffer,
    tile: any,
    extension: any,
    uri: string,
    abortSignal: AbortSignal,
  ) {
    if (this._options.beforeParseTile) {
      buffer = await this._options.beforeParseTile(
        buffer,
        tile,
        extension,
        uri,
        abortSignal,
      );
    }
    return this.tiles!.parseTile(buffer, tile, extension, uri, abortSignal);
  }

  // =============================================
  // Structure Data Methods
  // =============================================

  private _getStructureUrl(): string | null {
    const rootURL = this.tiles?.rootURL as string | undefined;
    if (!rootURL) return null;
    return rootURL.replace(/[^/]+$/, "structure.json");
  }

  private _buildOidNodeMap(
    node: StructureNode,
    map: Map<number, StructureNode>,
  ): void {
    if (node.id !== undefined) {
      map.set(node.id, node);
    }
    if (node.children) {
      for (const child of node.children) {
        this._buildOidNodeMap(child, map);
      }
    }
  }

  private async _fetchStructureData(): Promise<StructureData | null> {
    const url = this._getStructureUrl();
    if (!url) {
      console.warn("[GLTFParserPlugin] Cannot derive structure.json URL: tiles not initialized");
      return null;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`[GLTFParserPlugin] Failed to fetch structure.json: ${response.status}`);
        return null;
      }
      const data: StructureData = await response.json();
      this._structureData = data;

      this._oidNodeMap.clear();
      if (data.trees) {
        for (const tree of data.trees) {
          this._buildOidNodeMap(tree, this._oidNodeMap);
        }
      }

      return data;
    } catch (error) {
      console.error("[GLTFParserPlugin] Error loading structure.json:", error);
      return null;
    }
  }

  private async _ensureStructureLoaded(): Promise<StructureData | null> {
    if (this._structureData) return this._structureData;
    if (!this._structurePromise) {
      this._structurePromise = this._fetchStructureData();
    }
    return this._structurePromise;
  }

  /**
   * 根据 oid 获取 structure.json 中对应的节点树数据
   * 包含 bbox、children、name 等完整结构信息
   * 首次调用时会自动从 tileset URL 推导并请求 structure.json
   */
  async getNodeTreeByOid(oid: number): Promise<StructureNode | null> {
    await this._ensureStructureLoaded();
    return this._oidNodeMap.get(oid) ?? null;
  }

  /**
   * 根据 oid 数组批量获取 structure.json 中对应的节点树数据
   */
  async getNodeTreeByOids(
    oids: number[],
  ): Promise<Map<number, StructureNode>> {
    await this._ensureStructureLoaded();
    const result = new Map<number, StructureNode>();
    for (const oid of oids) {
      const node = this._oidNodeMap.get(oid);
      if (node) {
        result.set(oid, node);
      }
    }
    return result;
  }

  /**
   * 获取完整的 structure.json 数据
   * 首次调用时会自动请求
   */
  async getStructureData(): Promise<StructureData | null> {
    return this._ensureStructureLoaded();
  }

  // =============================================
  // Mesh Helper Methods (from MaptalksTilerPlugin)
  // =============================================

  /**
   * Load model callback
   */
  private _onLoadModelCB = ({ scene }: { scene: Object3D }) => {
    this._onLoadModel(scene);
  };

  /**
   * Tiles load end callback
   */
  private _onTilesLoadEndCB = () => {
    this._notifyCollectors();
  };

  private _onLoadModel(scene: Object3D) {
    this.splitMeshCache.clear();

    buildOidToFeatureIdMap(scene);
    scene.traverse((c) => {
      if ((c as Mesh).material) {
        this._setupMaterial(c as Mesh);
      }
    });
  }

  private _notifyCollectors(): void {
    for (const collector of this.collectors) {
      collector._updateMeshes();
    }
  }

  _registerCollector(collector: MeshCollector): void {
    this.collectors.add(collector);
  }

  _unregisterCollector(collector: MeshCollector): void {
    this.collectors.delete(collector);
    this.collectorCache.delete(collector.getOid());
  }

  private _updateWebGLLimits() {
    const gl = this.renderer!.getContext();
    const maxVectors = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
    this.maxUniformVectors = maxVectors;
  }

  /**
   * Dynamically calculate FEATURE_ID_COUNT based on WebGL limits and current oid count
   */
  private _calculateFeatureIdCount(): number {
    const maxUniformVectors = this.maxUniformVectors;
    const currentOidCount = this.oids.length;

    if (currentOidCount > maxUniformVectors) {
      throw new Error(
        `The number of OIDs to hide (${currentOidCount}) exceeds the WebGL MAX_FRAGMENT_UNIFORM_VECTORS limit (${maxUniformVectors}).`
      );
    }

    const minFeatureIdCount = 32;

    if (currentOidCount <= minFeatureIdCount) {
      return minFeatureIdCount;
    }

    const powerOf2 = Math.ceil(Math.log2(currentOidCount));
    return Math.pow(2, powerOf2);
  }

  /**
   * Set up shader modification for hiding specific features
   */
  private _setupMaterial(mesh: Mesh) {
    const material = mesh.material as Material;

    if (material.userData._meshHelperSetup) {
      return;
    }
    material.userData._meshHelperSetup = true;

    material.side = DoubleSide;

    const previousOnBeforeCompile = material.onBeforeCompile;

    if (!material.defines) {
      material.defines = {};
    }

    material.userData._materialFeatureIdCount = this.featureIdCount;

    Object.defineProperty(material.defines, "FEATURE_ID_COUNT", {
      get: () => {
        if (material.userData._materialFeatureIdCount !== this.featureIdCount) {
          material.userData._materialFeatureIdCount = this.featureIdCount;
          material.needsUpdate = true;
        }
        return material.userData._materialFeatureIdCount;
      },
      enumerable: true,
      configurable: true,
    });

    material.onBeforeCompile = (shader, renderer) => {
      previousOnBeforeCompile?.call(material, shader, renderer);

      if (shader.vertexShader.includes("varying float vFeatureId;")) {
        return;
      }

      shader.uniforms.hiddenFeatureIds = new FeatureIdUniforms(mesh, this);

      shader.vertexShader = shader.vertexShader.replace(
        "#include <common>",
        `#include <common>
             attribute float _feature_id_0;
             varying float vFeatureId;`
      );

      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
             vFeatureId = _feature_id_0;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>
             uniform float hiddenFeatureIds[FEATURE_ID_COUNT];
             varying float vFeatureId;
      
             bool shouldHideFeature(float featureId) {
               for(int i = 0; i < FEATURE_ID_COUNT; i++) {
                 if(abs(hiddenFeatureIds[i] - featureId) < 0.001) {
                   return true;
                 }
               }
               return false;
             }`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        "void main() {",
        `void main() {
           if(shouldHideFeature(vFeatureId)) {
             discard;
           }`
      );
    };
  }

  /**
   * Query feature information from intersection
   */
  queryFeatureFromIntersection(hit: Intersection): FeatureInfo {
    return queryFeatureFromIntersection(hit);
  }

  /**
   * 内部方法：根据 oid 获取 mesh 数组
   */
  _getMeshesByOidInternal(oid: number): Mesh[] {
    const tileMeshes = getTileMeshesByOid(this.tiles!, oid);

    const allSplitMeshes: Mesh[] = [];

    for (const tileMesh of tileMeshes) {
      const cacheKey = `${oid}_${tileMesh.uuid}`;

      let splitMeshes = this.splitMeshCache.get(cacheKey);

      if (!splitMeshes) {
        splitMeshes = getSplitMeshesFromTile(tileMesh, oid);
        this.splitMeshCache.set(cacheKey, splitMeshes);
      }
      allSplitMeshes.push(...splitMeshes);
    }

    return allSplitMeshes;
  }

  /**
   * 根据 oid 获取 MeshCollector
   * MeshCollector 会监听瓦片变化，自动更新 meshes 并触发 mesh-change 事件
   * 内部缓存：相同 oid 多次调用会返回同一个 collector 实例
   */
  getMeshCollectorByOid(oid: number): MeshCollector {
    const existing = this.collectorCache.get(oid);
    if (existing) {
      return existing;
    }
    const collector = new MeshCollector(oid, this);
    this.collectorCache.set(oid, collector);
    return collector;
  }

  /**
   * Hide the corresponding part of the original mesh according to the OID array
   */
  hideByOids(oids: number[]): void {
    this.oids = oids;
    this.featureIdCount = this._calculateFeatureIdCount();
  }

  /**
   * Restore the display of the corresponding mesh according to the OID array
   */
  unhideByOids(oids: number[]): void {
    const oidSet = new Set(oids);
    const newOids = this.oids.filter((existingOid) => !oidSet.has(existingOid));
    this.oids = newOids;
    this.featureIdCount = this._calculateFeatureIdCount();
  }

  /**
   * Restore the original materials of the mesh
   */
  unhide(): void {
    this.oids = [];
    this.featureIdCount = this._calculateFeatureIdCount();
  }

  /**
   * Get the current feature ID count
   */
  getFeatureIdCount(): number {
    return this.featureIdCount;
  }

  /**
   * Plugin disposal
   */
  dispose() {
    if (this.tiles) {
      this.tiles.manager.removeHandler(this._gltfRegex);
      this.tiles.removeEventListener("load-model", this._onLoadModelCB);
      this.tiles.removeEventListener("tiles-load-end", this._onTilesLoadEndCB);
    }

    if (this._loader) {
      this._loader.removeListeners();
    }

    for (const collector of this.collectors) {
      collector.dispose();
    }
    this.collectors.clear();
    this.collectorCache.clear();

    this.splitMeshCache.clear();

    this._structureData = null;
    this._oidNodeMap.clear();
    this._structurePromise = null;

    this._loader = null;
    this.tiles = null;
  }
}
