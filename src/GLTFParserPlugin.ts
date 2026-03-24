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
  FeatureInfo,
  applyVisibilityToScene,
  buildOidToFeatureIdMap,
  getAllOidsFromTiles,
  getPropertyDataByOid,
  getTileMeshesByOid,
  queryFeatureFromIntersection,
  splitMeshByOidsMerged,
} from "./mesh-helper";

import {
  MeshCollector,
  meshCollectorQueryCacheKey,
  normalizeMeshCollectorOids,
  type MeshCollectorQuery,
  type MeshHelperHost,
} from "./MeshCollector";
import { evaluateStyleCondition } from "./plugin/style-condition-eval";
import { GLTFWorkerLoader } from "./GLTFWorkerLoader";
import type { PartEffectHost } from "./plugin/part-effect-host";
import { PartColorHelper } from "./plugin/PartColorHelper";
import type { ColorInput } from "./utils/color-input";
import { PartBlinkHelper } from "./plugin/PartBlinkHelper";
import { PartFrameHelper } from "./plugin/PartFrameHelper";
import {
  StyleHelper,
  type StyleConfig,
} from "./plugin/StyleHelper";
import {
  PartHighlightHelper,
  type HighlightOptions,
} from "./plugin/PartHighlightHelper";
import { InteractionFilter } from "./plugin/InteractionFilter";
import { setMaxWorkers } from "./utils";
import {
  bboxArrayToBox3,
  selectByBoxFromOidMap,
  selectByPolygonFromOidMap,
} from "./utils/spatial-query";
import { tileCache } from "./db";
import { parseEmbeddedStructureDataFromTilesSync } from "./utils/tileset-structure-uri";
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

  // --- Structure data（tileset.asset.extras.maptalks.structureUri 等，同步解压，不请求 structure.json）---
  private _structureData: StructureData | null = null;
  private _oidNodeMap: Map<number, StructureNode> = new Map();
  /** rootTileset 已存在且已尝试过内嵌解析后仍为 null，则不再重复 gunzip */
  private _structureEmbedResolved = false;

  // --- Model info properties ---
  private _modelInfo: ModelInfo | null = null;
  private _modelInfoPromise: Promise<ModelInfo | null> | null = null;

  private _interactionFilter: InteractionFilter;
  private _partColorHelper: PartColorHelper | null = null;
  private _partBlinkHelper: PartBlinkHelper | null = null;
  private _partFrameHelper: PartFrameHelper | null = null;
  private _styleHelper: StyleHelper | null = null;
  private _partHighlightHelper: PartHighlightHelper | null = null;

  // --- Mesh helper properties ---
  oids: number[] = [];
  /** WebGLRenderer 实例，用于 mesh helper 等扩展 */
  get renderer(): WebGLRenderer | null {
    return this._renderer;
  }
  private _renderer: WebGLRenderer | null = null;
  private splitMeshCache: Map<string, Mesh[]> = new Map();
  private collectors: Set<MeshCollector> = new Set();
  private collectorCache: Map<string, MeshCollector> = new Map();

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
      this._renderer = options.renderer;
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

    const partFx = this._createPartEffectHost();
    this._partColorHelper = new PartColorHelper(partFx);
    this._partBlinkHelper = new PartBlinkHelper(partFx);
    this._partFrameHelper = new PartFrameHelper(partFx);
    this._styleHelper = new StyleHelper({
      getTiles: () => this.tiles,
      hidePartsByOids: partFx.hidePartsByOids,
      showPartsByOids: partFx.showPartsByOids,
      getMeshCollectorByCondition: partFx.getMeshCollectorByCondition,
      getScene: partFx.getScene,
    });
    this._partHighlightHelper = new PartHighlightHelper(partFx);

    // --- GLTF loader setup ---
    this._loader = new GLTFWorkerLoader(tiles.manager, {
      metadata: this._options.metadata,
      materialBuilder: this._options.materialBuilder,
    });
    tiles.manager.addHandler(this._gltfRegex, this._loader);

    tiles.addEventListener("load-model", this._onLoadModelCB);
    tiles.addEventListener("tiles-load-end", this._onTilesLoadEndCB);
    tiles.addEventListener("load-root-tileset", this._onLoadRootTilesetCB);
    this._syncStructureFromTileset();

    tiles.traverse((tile: any) => {
      const tileWithCache = tile as TileWithCache;
      if (tileWithCache.cached?.scene) {
        this._onLoadModel(tileWithCache.cached.scene);
      }
      return true;
    }, null);
  }

  private _createPartEffectHost(): PartEffectHost {
    return {
      hidePartsByOids: (oids) => this.hidePartsByOids(oids),
      showPartsByOids: (oids) => this.showPartsByOids(oids),
      getMeshCollectorByOid: (oid) => this.getMeshCollectorByOid(oid),
      getMeshCollectorByCondition: (q) => this.getMeshCollectorByCondition(q),
      getScene: () => this.tiles?.group ?? null,
    };
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

  /** 与 tileset 同目录的侧车 JSON，如 structure.json / modelInfo.json */
  private _sidecarJsonUrl(fileName: string): string | null {
    const rootURL = this.tiles?.rootURL as string | undefined;
    if (!rootURL) return null;
    return rootURL.replace(/[^/]+$/, fileName);
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

  /** 仅根 tileset 变化时重解析 structureUri（子 tileset 的 load-tileset 不会触发） */
  private _onLoadRootTilesetCB = (): void => {
    this._structureData = null;
    this._oidNodeMap.clear();
    this._structureEmbedResolved = false;
    this._syncStructureFromTileset();
  };

  /**
   * 从已加载根 tileset 的内嵌 structure（优先 asset.extras.maptalks.structureUri）同步解压并建索引。
   * rootTileset 尚未就绪时返回 null，可稍后再次调用；已成功或已判定无内嵌数据后见 _structureEmbedResolved。
   */
  private _syncStructureFromTileset(): StructureData | null {
    if (this._structureData) {
      return this._structureData;
    }
    if (this._structureEmbedResolved) {
      return null;
    }
    if (!this.tiles?.rootTileset) {
      return null;
    }

    const embedded = parseEmbeddedStructureDataFromTilesSync(this.tiles);
    this._structureEmbedResolved = true;

    if (!embedded) {
      return null;
    }

    this._structureData = embedded;
    this._oidNodeMap.clear();
    if (embedded.trees) {
      for (const tree of embedded.trees) {
        this._buildOidNodeMap(tree, this._oidNodeMap);
      }
    }
    return embedded;
  }

  /**
   * 根据 oid 获取结构树节点（数据来自 tileset 内嵌 structureUri 同步解压）
   */
  getNodeTreeByOid(oid: number): StructureNode | null {
    this._syncStructureFromTileset();
    return this._oidNodeMap.get(oid) ?? null;
  }

  /**
   * 根据 oid 数组批量获取结构树节点
   */
  getNodeTreeByOids(oids: number[]): Map<number, StructureNode> {
    this._syncStructureFromTileset();
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
   * 根据 oid 从结构数据取轴对齐包围盒（`bbox` 为 `[minX,minY,minZ,maxX,maxY,maxZ]`，与 `selectByBox` 一致）
   * @returns 无对应节点或缺少有效 bbox 时返回 `null`
   */
  getBoundingBoxByOid(oid: number): Box3 | null {
    this._syncStructureFromTileset();
    const node = this._oidNodeMap.get(oid);
    return bboxArrayToBox3(node?.bbox);
  }

  /**
   * 完整结构数据（与内嵌 structure JSON 一致）
   */
  getStructureData(): StructureData | null {
    return this._syncStructureFromTileset();
  }

  /**
   * 选择包围盒范围内的构件（坐标系与结构 bbox 一致）
   */
  selectByBox(box: Box3): number[] {
    this._syncStructureFromTileset();
    return selectByBoxFromOidMap(this._oidNodeMap, box);
  }

  /**
   * 选择多边形（平面投影）范围内的构件
   */
  selectByPolygon(
    polygon: Vector3[],
    axis: "xy" | "xz" | "yz" = "xz",
  ): number[] {
    this._syncStructureFromTileset();
    return selectByPolygonFromOidMap(this._oidNodeMap, polygon, axis);
  }

  // =============================================
  // Model Info Methods
  // =============================================

  private async _fetchModelInfo(): Promise<ModelInfo | null> {
    const url = this._sidecarJsonUrl("modelInfo.json");
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
    applyVisibilityToScene(scene, new Set(this.oids));
  }

  private _notifyCollectors(): void {
    for (const collector of this.collectors) {
      collector._updateMeshes();
    }
    this._styleHelper?.onTilesLoadEnd();
  }

  _registerCollector(collector: MeshCollector): void {
    this.collectors.add(collector);
  }

  _unregisterCollector(collector: MeshCollector): void {
    const key = collector.getCacheKey();
    this.collectors.delete(collector);
    this.collectorCache.delete(key);
    this._interactionFilter.onUnregisterCollector(key);
  }

  /**
   * 遍历所有已加载瓦片，应用可见性过滤
   */
  private _applyVisibilityToAllTiles(): void {
    if (!this.tiles) return;
    const hiddenSet = new Set(this.oids);
    this.tiles.traverse((tile: any) => {
      const tileWithCache = tile as TileWithCache;
      if (tileWithCache.cached?.scene) {
        applyVisibilityToScene(tileWithCache.cached.scene, hiddenSet);
      }
      return true;
    }, null);
  }

  /**
   * 设置材质（DoubleSide 等基础配置）
   */
  private _setupMaterial(mesh: Mesh) {
    const material = mesh.material as Material;

    if (material.userData._meshHelperSetup) {
      return;
    }
    material.userData._meshHelperSetup = true;

    material.side = DoubleSide;
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
   * 按 OID 集合：每个瓦片 mesh 只生成 **一个** 合并后的 split mesh（同一组 oid / condition 一条几何）
   */
  private _getMergedSplitMeshesForOidSet(oidSet: Set<number>): Mesh[] {
    if (!this.tiles || oidSet.size === 0) return [];

    const sortedKey = [...oidSet].sort((a, b) => a - b).join(",");
    const result: Mesh[] = [];
    const candidateTiles = new Set<Mesh>();

    for (const oid of oidSet) {
      for (const tm of getTileMeshesByOid(this.tiles, oid)) {
        candidateTiles.add(tm);
      }
    }

    for (const tileMesh of candidateTiles) {
      const cacheKey = `merged|${tileMesh.uuid}|${sortedKey}`;
      let cached = this.splitMeshCache.get(cacheKey);
      if (!cached) {
        const m = splitMeshByOidsMerged(tileMesh, oidSet);
        cached = m ? [m] : [];
        this.splitMeshCache.set(cacheKey, cached);
      }
      result.push(...cached);
    }
    return result;
  }

  /**
   * 内部方法：根据单个 oid 获取 split mesh（每瓦片合并为一条）
   */
  _getMeshesByOidInternal(oid: number): Mesh[] {
    return this._getMergedSplitMeshesForOidSet(new Set([oid]));
  }

  /**
   * 内部方法：根据多个 oid 获取合并 split mesh（每瓦片一条，而非每 oid 一条）
   */
  _getMeshesByOidsInternal(oids: readonly number[]): Mesh[] {
    return this._getMergedSplitMeshesForOidSet(new Set(oids));
  }

  /**
   * 按查询收集 mesh：可只传 oids、只传 condition（全场景 OID 上筛选）、或两者组合
   * condition 与 setStyle 的 show / conditions 中字符串表达式语义一致
   */
  _getMeshesForCollectorQueryInternal(params: {
    oids: readonly number[];
    condition?: string;
  }): Mesh[] {
    if (!this.tiles) return [];

    const cond = params.condition?.trim();
    let targetOids: number[];

    if (!cond) {
      if (params.oids.length === 0) return [];
      targetOids = [...new Set(params.oids)].sort((a, b) => a - b);
    } else {
      const candidate =
        params.oids.length === 0
          ? getAllOidsFromTiles(this.tiles)
          : [...new Set(params.oids)];
      targetOids = [];
      for (const oid of candidate) {
        const data = getPropertyDataByOid(this.tiles, oid);
        if (evaluateStyleCondition(cond, data)) {
          targetOids.push(oid);
        }
      }
      targetOids.sort((a, b) => a - b);
    }

    return this._getMeshesByOidsInternal(targetOids);
  }

  /**
   * 根据查询获取 MeshCollector（oids + 可选 condition，缓存键相同则复用实例）
   */
  getMeshCollectorByCondition(query: MeshCollectorQuery): MeshCollector {
    const oids = query.oids ?? [];
    const hasOids = normalizeMeshCollectorOids(oids).length > 0;
    const hasCond = Boolean(query.condition?.trim());
    if (!hasOids && !hasCond) {
      throw new Error(
        "getMeshCollectorByCondition requires non-empty oids and/or a condition string",
      );
    }

    const key = meshCollectorQueryCacheKey(query);
    const existing = this.collectorCache.get(key);
    if (existing) {
      return existing;
    }
    const collector = new MeshCollector(query, this);
    this.collectorCache.set(key, collector);

    this._interactionFilter.onCollectorMeshChange(key, collector.meshes);

    collector.addEventListener("mesh-change", (event) => {
      this._interactionFilter.onCollectorMeshChange(key, event.meshes);
    });

    return collector;
  }

  /**
   * 根据单个 oid 获取 MeshCollector（等价于 getMeshCollectorByCondition({ oids: [oid] })）
   */
  getMeshCollectorByOid(oid: number): MeshCollector {
    return this.getMeshCollectorByCondition({ oids: [oid] });
  }

  /**
   * Hide the corresponding part of the original mesh according to the OID array
   */
  hidePartsByOids(oids: number[]): void {
    this.oids = oids;
    this._applyVisibilityToAllTiles();
  }

  /**
   * Restore the display of the corresponding mesh according to the OID array
   */
  showPartsByOids(oids: number[]): void {
    const oidSet = new Set(oids);
    this.oids = this.oids.filter((existingOid) => !oidSet.has(existingOid));
    this._applyVisibilityToAllTiles();
  }

  /**
   * 根据 oid 数组设置构件颜色
   * 隐藏原 mesh，将 split mesh 替换材质后加入场景（使用 tiles.group）
   * @param oids 构件 OID 数组
   * @param color 颜色值，支持 hex 数字、颜色字符串（如 "#ff0000"）、THREE.Color 对象
   */
  setPartColorByOids(oids: number[], color: ColorInput): void {
    this._partColorHelper?.setPartColorByOids(oids, color);
  }

  /**
   * 恢复指定构件的颜色
   * 从场景移除 split mesh，恢复原 mesh 显示
   * @param oids 构件 OID 数组
   */
  restorePartColorByOids(oids: number[]): void {
    this._partColorHelper?.restorePartColorByOids(oids);
  }

  /**
   * 根据 oid 数组设置构件透明度
   * @param oids 构件 OID 数组
   * @param opacity 透明度，0-1，0 完全透明，1 完全不透明
   */
  setPartOpacityByOids(oids: number[], opacity: number): void {
    this._partColorHelper?.setPartOpacityByOids(oids, opacity);
  }

  /**
   * 恢复指定构件的透明度
   * @param oids 构件 OID 数组
   */
  restorePartOpacityByOids(oids: number[]): void {
    this._partColorHelper?.restorePartOpacityByOids(oids);
  }

  /**
   * 设置需要闪烁的构件
   * @param oids 构件 OID 数组
   */
  setBlinkPartsByOids(oids: number[]): void {
    this._partBlinkHelper?.setBlinkPartsByOids(oids);
  }

  /**
   * 设置闪烁颜色
   * @param color 颜色值，支持 hex 数字、颜色字符串（如 "#ff0000"）、THREE.Color 对象
   */
  setBlinkColor(color: ColorInput): void {
    this._partBlinkHelper?.setBlinkColor(color);
  }

  /**
   * 设置闪烁周期时间（毫秒）
   * @param ms 一个完整闪烁周期（暗->亮->暗）的时长，默认 1000
   */
  setBlinkIntervalTime(ms: number): void {
    this._partBlinkHelper?.setBlinkIntervalTime(ms);
  }

  /**
   * 清除所有闪烁构件
   */
  clearAllBlinkParts(): void {
    this._partBlinkHelper?.clearAllBlinkParts();
  }

  /**
   * 设置需要线框显示的构件
   * @param oids 构件 OID 数组
   */
  setFramePartsByOids(oids: number[]): void {
    this._partFrameHelper?.setFramePartsByOids(oids);
  }

  /**
   * 清除所有线框显示构件
   */
  clearAllFrameParts(): void {
    this._partFrameHelper?.clearAllFrameParts();
  }

  /**
   * 设置指定构件的线框填充颜色
   * @param oids 构件 OID 数组
   * @param color 颜色值，支持 hex 数字、颜色字符串（如 "#ff0000"）、THREE.Color 对象
   */
  setFrameFillColor(oids: number[], color: ColorInput): void {
    this._partFrameHelper?.setFrameFillColor(oids, color);
  }

  /**
   * 设置指定构件的线框边框颜色
   * @param oids 构件 OID 数组
   * @param color 颜色值，支持 hex 数字、颜色字符串（如 "#ff0000"）、THREE.Color 对象
   */
  setFrameEdgeColor(oids: number[], color: ColorInput): void {
    this._partFrameHelper?.setFrameEdgeColor(oids, color);
  }

  /**
   * 设置构件样式（条件可见性 + 条件材质）
   * @param style 样式配置，传 null 清除样式
   */
  setStyle(style: StyleConfig | null): void {
    this._styleHelper?.setStyle(style);
  }

  /**
   * 当前样式配置，只读
   */
  get style(): StyleConfig | null {
    return this._styleHelper?.style ?? null;
  }

  /**
   * 清除构件样式
   */
  clearStyle(): void {
    this._styleHelper?.clearStyle();
  }

  /**
   * 高亮指定构件
   * @param options 高亮配置，包含 name、ids、material
   */
  highlight(options: HighlightOptions): void {
    this._partHighlightHelper?.highlight(options);
  }

  /**
   * 取消指定名称的高亮
   * @param name 高亮组名称
   */
  cancelHighlight(name: string): void {
    this._partHighlightHelper?.cancelHighlight(name);
  }

  /**
   * 取消所有高亮
   */
  cancelAllHighlight(): void {
    this._partHighlightHelper?.cancelAllHighlight();
  }

  /**
   * Restore the original materials of the mesh
   */
  showAllParts(): void {
    this.oids = [];
    this._applyVisibilityToAllTiles();
  }

  /**
   * 获取当前隐藏的 OID 数量（兼容旧 API）
   */
  getFeatureIdCount(): number {
    return this.oids.length;
  }

  /**
   * Plugin disposal
   */
  dispose() {
    if (this.tiles) {
      this.tiles.manager.removeHandler(this._gltfRegex);
      this.tiles.removeEventListener("load-model", this._onLoadModelCB);
      this.tiles.removeEventListener("tiles-load-end", this._onTilesLoadEndCB);
      this.tiles.removeEventListener("load-root-tileset", this._onLoadRootTilesetCB);
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
    this._structureEmbedResolved = false;

    // Clear model info data
    this._modelInfo = null;
    this._modelInfoPromise = null;

    this._interactionFilter.dispose();
    this._partColorHelper = null;
    this._partBlinkHelper?.dispose();
    this._partBlinkHelper = null;
    this._partFrameHelper?.dispose();
    this._partFrameHelper = null;
    this._styleHelper?.dispose();
    this._styleHelper = null;
    this._partHighlightHelper?.dispose();
    this._partHighlightHelper = null;

    this._loader = null;
    this.tiles = null;
  }
}
