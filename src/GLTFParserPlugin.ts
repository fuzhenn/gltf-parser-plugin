import {
  Box3,
  DoubleSide,
  Intersection,
  Material,
  Mesh,
  Object3D,
  WebGLRenderer,
} from "three";
import type { Vector3 } from "three";
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
import {
  ComponentColorHelper,
  type ColorInput,
} from "./plugin/ComponentColorHelper";
import { InteractionFilter } from "./plugin/InteractionFilter";
import { setMaxWorkers } from "./utils";
import {
  selectByBoxFromOidMap,
  selectByPolygonFromOidMap,
} from "./utils/spatial-query";
import { tileCache } from "./db";
import { TilesRenderer } from "3d-tiles-renderer";

import type {
  GLTFParserPluginOptions,
  ModelInfo,
  StructureData,
  StructureNode,
} from "./plugin-types";

export type {
  GLTFParserPluginOptions,
  ModelInfo,
  StructureData,
  StructureNode,
};

interface TileWithCache {
  cached?: {
    scene: Object3D;
  };
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

  // --- Model info properties ---
  private _modelInfo: ModelInfo | null = null;
  private _modelInfoPromise: Promise<ModelInfo | null> | null = null;

  private _interactionFilter: InteractionFilter;
  private _componentColorHelper: ComponentColorHelper | null = null;

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

    this._interactionFilter = new InteractionFilter({
      getCollectorCache: () => this.collectorCache,
    });

    setMaxWorkers(this._options.maxWorkers!);
  }

  /**
   * Plugin initialization, called by TilesRenderer
   */
  init(tiles: TilesRenderer) {
    this.tiles = tiles;

    this._componentColorHelper = new ComponentColorHelper({
      hideByOids: (oids) => this.hideByOids(oids),
      unhideByOids: (oids) => this.unhideByOids(oids),
      getMeshCollectorByOid: (oid) => this.getMeshCollectorByOid(oid),
      getScene: () => this.tiles?.group ?? null,
    });

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
      console.warn(
        "[GLTFParserPlugin] Cannot derive structure.json URL: tiles not initialized",
      );
      return null;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(
          `[GLTFParserPlugin] Failed to fetch structure.json: ${response.status}`,
        );
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
  async getNodeTreeByOids(oids: number[]): Promise<Map<number, StructureNode>> {
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

  /**
   * 选择包围盒范围内的构件（包含相交和包含两种情况）
   * @param box 查询用的 Box3 范围，坐标系与 structure.json 中 bbox 一致
   * @returns 范围内所有构件的 oid 数组
   */
  async selectByBox(box: Box3): Promise<number[]> {
    await this._ensureStructureLoaded();
    return selectByBoxFromOidMap(this._oidNodeMap, box);
  }

  /**
   * 选择多边形（平面投影）范围内的构件（包含相交和包含两种情况）
   * @param polygon 多边形顶点数组（Vector3），按顺序连接构成闭合多边形
   * @param axis 投影平面，决定使用 bbox 的哪两个轴做 2D 判定
   *   - 'xz'（默认）：俯视图，取 bbox 的 x/z 坐标
   *   - 'xy'：正视图，取 bbox 的 x/y 坐标
   *   - 'yz'：侧视图，取 bbox 的 y/z 坐标
   * @returns 范围内所有构件的 oid 数组
   */
  async selectByPolygon(
    polygon: Vector3[],
    axis: "xy" | "xz" | "yz" = "xz",
  ): Promise<number[]> {
    await this._ensureStructureLoaded();
    return selectByPolygonFromOidMap(this._oidNodeMap, polygon, axis);
  }

  // =============================================
  // Model Info Methods
  // =============================================

  private _getModelInfoUrl(): string | null {
    const rootURL = this.tiles?.rootURL as string | undefined;
    if (!rootURL) return null;
    return rootURL.replace(/[^/]+$/, "modelInfo.json");
  }

  private async _fetchModelInfo(): Promise<ModelInfo | null> {
    const url = this._getModelInfoUrl();
    if (!url) {
      console.warn(
        "[GLTFParserPlugin] Cannot derive modelInfo.json URL: tiles not initialized",
      );
      return null;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(
          `[GLTFParserPlugin] Failed to fetch modelInfo.json: ${response.status}`,
        );
        return null;
      }
      const data: ModelInfo = await response.json();
      this._modelInfo = data;
      return data;
    } catch (error) {
      console.error("[GLTFParserPlugin] Error loading modelInfo.json:", error);
      return null;
    }
  }

  private async _ensureModelInfoLoaded(): Promise<ModelInfo | null> {
    if (this._modelInfo) return this._modelInfo;
    if (!this._modelInfoPromise) {
      this._modelInfoPromise = this._fetchModelInfo();
    }
    return this._modelInfoPromise;
  }

  /**
   * 获取 modelInfo.json 数据
   * 包含模型的基本信息：动画支持、材质数量、顶点数、三角形数等
   * 首次调用时会自动从 tileset URL 推导并请求 modelInfo.json
   */
  async getModelInfo(): Promise<ModelInfo | null> {
    return this._ensureModelInfoLoaded();
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
    const oid = collector.getOid();
    this.collectors.delete(collector);
    this.collectorCache.delete(oid);
    this._interactionFilter.onUnregisterCollector(oid);
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
        `The number of OIDs to hide (${currentOidCount}) exceeds the WebGL MAX_FRAGMENT_UNIFORM_VECTORS limit (${maxUniformVectors}).`,
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
             varying float vFeatureId;`,
      );

      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
             vFeatureId = _feature_id_0;`,
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
             }`,
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        "void main() {",
        `void main() {
           if(shouldHideFeature(vFeatureId)) {
             discard;
           }`,
      );
    };
  }

  /**
   * Query feature information from intersection
   * Respects freeze and isolate filters
   */
  queryFeatureFromIntersection(hit: Intersection): FeatureInfo {
    const result = queryFeatureFromIntersection(hit);

    if (result.isValid && result.oid !== undefined) {
      if (this._interactionFilter.isOidBlocked(result.oid)) {
        return {
          isValid: false,
          error: this._interactionFilter.getFrozenOids().includes(result.oid)
            ? "Component is frozen"
            : "Component is not in isolated set",
        };
      }
    }

    return result;
  }

  // =============================================
  // Interaction Filter Methods (delegated)
  // =============================================

  freezeByOids(oids: number[]): void {
    this._interactionFilter.freezeByOids(oids);
  }

  freezeByOid(oid: number): void {
    this._interactionFilter.freezeByOid(oid);
  }

  unfreezeByOids(oids: number[]): void {
    this._interactionFilter.unfreezeByOids(oids);
  }

  unfreezeByOid(oid: number): void {
    this._interactionFilter.unfreezeByOid(oid);
  }

  unfreeze(): void {
    this._interactionFilter.unfreeze();
  }

  getFrozenOids(): number[] {
    return this._interactionFilter.getFrozenOids();
  }

  isolateByOids(oids: number[]): void {
    this._interactionFilter.isolateByOids(oids);
  }

  isolateByOid(oid: number): void {
    this._interactionFilter.isolateByOid(oid);
  }

  unisolateByOids(oids: number[]): void {
    this._interactionFilter.unisolateByOids(oids);
  }

  unisolateByOid(oid: number): void {
    this._interactionFilter.unisolateByOid(oid);
  }

  unisolate(): void {
    this._interactionFilter.unisolate();
  }

  getIsolatedOids(): number[] {
    return this._interactionFilter.getIsolatedOids();
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

    this._interactionFilter.onCollectorMeshChange(oid, collector.meshes);

    collector.addEventListener("mesh-change", (event) => {
      this._interactionFilter.onCollectorMeshChange(oid, event.meshes);
    });

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
   * 根据 oid 数组设置构件颜色
   * 隐藏原 mesh，将 split mesh 替换材质后加入场景（使用 tiles.group）
   * @param oids 构件 OID 数组
   * @param color 颜色值，支持 hex 数字、颜色字符串（如 "#ff0000"）、THREE.Color 对象
   */
  setComponentColorByOids(oids: number[], color: ColorInput): void {
    this._componentColorHelper?.setComponentColorByOids(oids, color);
  }

  /**
   * 恢复指定构件的颜色
   * 从场景移除 split mesh，unhide 原 mesh
   * @param oids 构件 OID 数组
   */
  restoreComponentColorByOids(oids: number[]): void {
    this._componentColorHelper?.restoreComponentColorByOids(oids);
  }

  /**
   * 根据 oid 数组设置构件透明度
   * @param oids 构件 OID 数组
   * @param opacity 透明度，0-1，0 完全透明，1 完全不透明
   */
  setComponentOpacityByOids(oids: number[], opacity: number): void {
    this._componentColorHelper?.setComponentOpacityByOids(oids, opacity);
  }

  /**
   * 恢复指定构件的透明度
   * @param oids 构件 OID 数组
   */
  restoreComponentOpacityByOids(oids: number[]): void {
    this._componentColorHelper?.restoreComponentOpacityByOids(oids);
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

    // Clear model info data
    this._modelInfo = null;
    this._modelInfoPromise = null;

    this._interactionFilter.dispose();
    this._componentColorHelper = null;

    this._loader = null;
    this.tiles = null;
  }
}
