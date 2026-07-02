import {
  Box3,
  Intersection,
  Mesh,
  Object3D,
  Vector3,
  WebGLRenderer,
} from "three";
import {
  FeatureInfo,
  buildOidToFeatureIdMap,
  disposeMergedSplitMeshResources,
  getAllOidsFromTiles,
  getPropertyDataByOid,
  queryFeatureFromIntersection,
} from "./mesh-helper";
import type { InternalData } from "./mesh-helper/mesh";

import {
  MeshCollector,
  MeshSplitResolver,
  resolveMeshCollectorQuery,
  type MeshCollectorQuery,
} from "./MeshCollector";
import {
  buildStyleConditionEvaluatorMap,
  evaluateStyleCondition,
} from "./plugin/style-condition-eval";
import { GLTFWorkerLoader } from "./GLTFWorkerLoader";
import type { PartEffectHost } from "./plugin/part-effect-host";
import { StyleHelper, type StyleConfig } from "./plugin/StyleHelper";
import {
  PartHighlightHelper,
  type HighlightByPidsOptions,
  type HighlightOptions,
} from "./plugin/PartHighlightHelper";
import { InteractionFilter } from "./plugin/InteractionFilter";
import { PartVisibilityHelper } from "./plugin/part-visibility-helper";
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
  engineData?: {
    scene: Object3D;
  };
}

interface TileVisibilityChangeEvent {
  type: "tile-visibility-change";
  scene: Object3D;
  tile: unknown;
  visible: boolean;
}

export class GLTFParserPlugin {
  name = "GLTFParserPlugin";

  private tiles: (TilesRenderer & Record<string, any>) | null = null;
  private _loader: GLTFWorkerLoader | null = null;
  private readonly _gltfRegex = /\.(gltf|glb)$/g;
  private readonly _options: GLTFParserPluginOptions;

  // --- Structure data（tileset.asset.extras.maptalks.structureUri 等，同步解压，不请求 structure.json）---
  private _structureData: StructureData | null = null;
  private _oidNodeMap: Map<number, StructureNode> = new Map();
  /** OID → 从根到该节点的斜杠分隔路径，如 "/1/5/7/"；用于 condition 里按层级匹配后代 */
  private _oidPathMap: Map<number, string> = new Map();

  /**
   * 内部数据：在原始属性表数据上注入层级 `_path`（`"/1/5/7/"` 形式）。
   * 用法：condition 表达式里写 `_path && _path.indexOf('/7/') >= 0` 即可匹配 OID 7 及其所有后代；
   * 结构未就绪时 `_path` 为 `""`，表达式短路返回 false，不会抛错。
   */
  private _internalData: InternalData = (oid, data) => {
    const path = this._oidPathMap.get(oid) ?? "";
    return { ...data, _path: path };
  };

  // --- Model info properties ---
  private _modelInfo: ModelInfo | null = null;
  private _modelInfoPromise: Promise<ModelInfo | null> | null = null;

  private _interactionFilter: InteractionFilter;
  private _styleHelper: StyleHelper | null = null;
  private _partHighlightHelper: PartHighlightHelper | null = null;

  // --- Mesh helper properties ---
  /** 构件显隐（原 `hidePartsByOids` / `showPartsByOids` 逻辑） */
  readonly partVisibility = new PartVisibilityHelper(
    () => this.tiles,
    () => this._internalData,
  );
  /** WebGLRenderer 实例，用于 mesh helper 等扩展 */
  get renderer(): WebGLRenderer | null {
    return this._renderer;
  }
  private _renderer: WebGLRenderer | null = null;
  readonly meshSplit = new MeshSplitResolver(
    () => this.tiles,
    () => this._internalData,
  );
  private collectors: Set<MeshCollector> = new Set();

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
      getCollectors: () => this.collectors,
    });

    setMaxWorkers(this._options.maxWorkers!);
  }

  /**
   * Plugin initialization, called by TilesRenderer
   */
  init(tiles: TilesRenderer) {
    this.tiles = tiles;

    const partFx = this._createPartEffectHost();
    this._styleHelper = new StyleHelper({
      getTiles: () => this.tiles,
      setPartVisibilityConfigLayer: (layerId, attr, configs) =>
        this.partVisibility.setPartVisibilityConfigLayer(layerId, attr, configs),
      removePartVisibilityConfigLayer: (layerId, attr) =>
        this.partVisibility.removePartVisibilityConfigLayer(layerId, attr),
      getMeshCollectorByCondition: partFx.getMeshCollectorByCondition,
      releaseMeshCollector: partFx.releaseMeshCollector,
      getRootGroup: partFx.getRootGroup,
      getInternalData: () => this._internalData,
    });
    this._partHighlightHelper = new PartHighlightHelper(partFx);

    // --- GLTF loader setup ---
    this._loader = new GLTFWorkerLoader(tiles.manager, {
      metadata: this._options.metadata,
      materialBuilder: this._options.materialBuilder,
    });
    tiles.manager.addHandler(this._gltfRegex, this._loader);

    tiles.addEventListener("load-model", this._onLoadModelCB);
    tiles.addEventListener("dispose-model", this._onDisposeModelCB);
    tiles.addEventListener(
      "tile-visibility-change",
      this._onTileVisibilityChangeCB,
    );
    tiles.addEventListener("load-root-tileset", this._onLoadRootTilesetCB);
    this._syncStructureFromTileset();

    tiles.traverse((tile: any) => {
      const tileWithCache = tile as TileWithCache;
      if (tileWithCache.engineData?.scene) {
        this._onLoadModel(tileWithCache.engineData.scene);
      }
      return true;
    }, null);

    // 构造选项里的初始样式（需在场景已有 mesh 后，属性表与 setStyle 才可靠）
    if (this._options.style !== undefined) {
      this._styleHelper?.setStyle(this._options.style ?? null);
    }
  }

  private _createPartEffectHost(): PartEffectHost {
    return {
      getTiles: () => this.tiles ?? null,
      setPartVisibilityConfigLayer: (layerId, attr, configs) =>
        this.partVisibility.setPartVisibilityConfigLayer(
          layerId,
          attr,
          configs,
        ),
      removePartVisibilityConfigLayer: (layerId, attr) =>
        this.partVisibility.removePartVisibilityConfigLayer(layerId, attr),
      hidePartsByFeatureAttribute: (ids, attr) =>
        this.partVisibility.hidePartsByFeatureAttribute(ids, attr),
      showPartsByFeatureAttribute: (ids, attr) =>
        this.partVisibility.showPartsByFeatureAttribute(ids, attr),
      hidePartsByOids: (oids) =>
        this.partVisibility.hidePartsByFeatureAttribute(oids, 0),
      showPartsByOids: (oids) =>
        this.partVisibility.showPartsByFeatureAttribute(oids, 0),
      hidePartsByPids: (pids) =>
        this.partVisibility.hidePartsByFeatureAttribute(pids, 1),
      showPartsByPids: (pids) =>
        this.partVisibility.showPartsByFeatureAttribute(pids, 1),
      getMeshCollectorByCondition: (q) => this.getMeshCollectorByCondition(q),
      releaseMeshCollector: (c) => this.releaseMeshCollector(c),
      getRootGroup: () => this.tiles?.group ?? null,
      getInternalData: () => this._internalData,
    };
  }

  /**
   * 注销通过 {@link getMeshCollectorByCondition} 创建的收集器（与创建成对调用）。
   * 样式/高亮在 clearStyle、切换样式、取消高亮时会内部调用；业务自建收集器也应在不用时调用。
   */
  releaseMeshCollector(collector: MeshCollector): void {
    if (!this.collectors.has(collector)) return;
    this._unregisterMeshCollector(collector);
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
  private _tocJsonUrl(fileName: string): string | null {
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

  /**
   * 构建 OID → 路径字符串（形如 "/1/5/7/"）。
   * 无 `id` 的中间节点不写入自身，但它的父路径会继续传递给子节点；
   * 两端 `/` 是为了让 `path.indexOf('/X/') >= 0` 不会把 `X=7` 误匹配到 `17`/`75`。
   */
  private _buildOidPathMap(
    node: StructureNode,
    prefix: string,
    map: Map<number, string>,
  ): void {
    let cur = prefix;
    if (typeof node.id === "number") {
      cur = `${prefix}${node.id}/`;
      map.set(node.id, cur);
    }
    if (node.children) {
      for (const child of node.children) {
        this._buildOidPathMap(child, cur, map);
      }
    }
  }

  /** 仅根 tileset 变化时重解析 structureUri（子 tileset 的 load-tileset 不会触发） */
  private _onLoadRootTilesetCB = (): void => {
    this._structureData = null;
    this._oidNodeMap.clear();
    this._oidPathMap.clear();
    this._syncStructureFromTileset();
  };

  /**
   * 从已加载根 tileset 的内嵌 structure（`asset.extras.maptalks.structureUri`）同步解压并建索引。
   * rootTileset 尚未就绪时返回 null，可稍后再次调用。
   */
  private _syncStructureFromTileset(): StructureData | null {
    if (this._structureData) {
      return this._structureData;
    }
    if (!this.tiles?.rootTileset) {
      return null;
    }

    const structureData = parseEmbeddedStructureDataFromTilesSync(this.tiles);
    if (!structureData) {
      return null;
    }

    this._structureData = structureData;
    this._oidNodeMap.clear();
    this._oidPathMap.clear();
    if (structureData.trees) {
      for (const tree of structureData.trees) {
        this._buildOidNodeMap(tree, this._oidNodeMap);
        this._buildOidPathMap(tree, "/", this._oidPathMap);
      }
    }
    return structureData;
  }

  /**
   * 根据 oid 获取结构树节点（数据来自 tileset 内嵌 structureUri 同步解压）
   */
  getNodeTreeByOid(oid: number): StructureNode | null {
    this._syncStructureFromTileset();
    return this._oidNodeMap.get(oid) ?? null;
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
   * 计算给定 OID 集合的几何中心（世界坐标系与结构 bbox / 瓦片 mesh 一致）。
   * 优先合并结构树中的轴对齐 bbox；若无有效 bbox 则合并对应 split mesh 的世界包围盒。
   */
  getCenterByOids(oids: readonly number[]): Vector3 | null {
    if (!this.tiles || oids.length === 0) return null;
    const unique = [...new Set(oids)];
    if (unique.length === 0) return null;
    return this._getCenterFromOidList(unique);
  }

  /**
   * 按属性条件筛选构件（语义同 `setStyle` 的 `show` / conditions 中的表达式字符串），
   * 返回筛选结果的整体中心点；合并方式同 {@link getCenterByOids}。
   */
  getCenterByCondition(condition: string): Vector3 | null {
    if (!this.tiles) return null;
    const cond = condition.trim();
    if (!cond) return null;

    const evaluators = buildStyleConditionEvaluatorMap({ show: cond });
    const targetOids: number[] = [];
    for (const oid of getAllOidsFromTiles(this.tiles)) {
      const data = getPropertyDataByOid(this.tiles, oid, this._internalData);
      if (evaluateStyleCondition(cond, data, evaluators)) {
        targetOids.push(oid);
      }
    }
    if (targetOids.length === 0) return null;
    return this._getCenterFromOidList(targetOids);
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

  /**
   * 根据 OID 获取精细模型（detail model）的 URL。
   * 路径规则：与 tileset.json 同级 `details/{oid % 1000, 三位零填充}/{oid}.glb`
   */
  getDetailModelUrl(oid: number): string {
    const folder = String(oid % 1000).padStart(3, "0");
    return this._tocJsonUrl(`details/${folder}/${oid}.glb`) ?? "";
  }

  // =============================================
  // Model Info Methods
  // =============================================

  private async _fetchModelInfo(): Promise<ModelInfo | null> {
    const url = this._tocJsonUrl("modelInfo.json");
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
   * 3d-tiles-renderer 插件钩子：瓦片 parse 完成、scene 加入 `tiles.group` 之前被 `await`。
   *
   * 在此提前构建 idMap/pidMap 并按当前样式/高亮隐藏列表过滤 `geometry.index`，
   * 使被照料的构件从首帧起即为隐藏状态，避免多级瓦片加载时原始 mesh「先出现后消失」。
   *
   * 时序上早于 `needs-update` / `load-model`，可消除「update 先把 scene 挂进 group、
   * 随后 load-model 才 hide」的竞态。
   */
  processTileModel(scene: Object3D, _tile: unknown): void {
    buildOidToFeatureIdMap(scene);
    this.partVisibility.applyVisibilityToScene(scene);
    (
      scene.userData as { _gltfParserPreVisibilityApplied?: boolean }
    )._gltfParserPreVisibilityApplied = true;
  }

  /**
   * Load model callback
   */
  private _onLoadModelCB = ({ scene }: { scene: Object3D }) => {
    this._onLoadModel(scene);
  };

  /**
   * LRU 瓦片再次显示时不会走 load-model。
   * 对本 scene 做 idMap + 显隐，并增量应用样式/高亮 split mesh（不全局遍历）。
   */
  private _onTileVisibilityChangeCB = (event: TileVisibilityChangeEvent) => {
    if (!event.visible || !event.scene) return;
    buildOidToFeatureIdMap(event.scene);
    this.partVisibility.applyVisibilityToScene(event.scene);
    this._styleHelper?.applyStyleToTileScene(event.scene);
    this._partHighlightHelper?.applyHighlightToTileScene(event.scene);
    this._appendOtherCollectorsForTileScene(event.scene);
  };

  private _appendOtherCollectorsForTileScene(scene: Object3D): void {
    const managed = new Set<MeshCollector>();
    for (const c of this._styleHelper?.getStyleCollectors() ?? []) {
      managed.add(c);
    }
    for (const c of this._partHighlightHelper?.getHighlightCollectors() ?? []) {
      managed.add(c);
    }

    for (const collector of this.collectors) {
      if (managed.has(collector)) continue;
      collector.appendMeshesForTileScene(scene);
    }
  }

  /**
   * 瓦片卸载（LRU 等触发 disposeTile）前，先卸掉依赖该 tile 场景的 split mesh，再清瓦片 userData 上的几何缓存。
   * 与 3d-tiles-renderer 中 `TilesRenderer.disposeTile` 派发顺序一致。
   */
  private _onDisposeModelCB = ({ scene }: { scene: Object3D }) => {
    for (const collector of this.collectors) {
      collector.releaseSplitMeshesForTileScene(scene);
    }
    scene.traverse((obj) => {
      if (obj instanceof Mesh) {
        this.meshSplit.disposeSplitMeshesByTile(obj);
      }
    });
  };

  private _onLoadModel(scene: Object3D) {
    scene.traverse((obj) => {
      if (obj instanceof Mesh) {
        this.meshSplit.disposeSplitMeshesByTile(obj);
      }
    });

    const ud = scene.userData as { _gltfParserPreVisibilityApplied?: boolean };
    if (ud._gltfParserPreVisibilityApplied) {
      delete ud._gltfParserPreVisibilityApplied;
      return;
    }

    buildOidToFeatureIdMap(scene);
    this.partVisibility.applyVisibilityToScene(scene);
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

  /**
   * 将 `freeze` / `unfreeze` / `isolate` / `unisolate` 的参数解析为 OID 列表。
   * 数组参数视为 OID 列表；字符串参数视为与 `setStyle` 中 `show` 同语义的属性条件表达式。
   */
  private _getOidsForInteractionFilterSelection(
    selection: number[] | string,
  ): number[] {
    if (Array.isArray(selection)) {
      return [...new Set(selection)];
    }
    const cond = selection.trim();
    if (!cond || !this.tiles) {
      return [];
    }
    const evaluators = buildStyleConditionEvaluatorMap({ show: cond });
    const targetOids: number[] = [];
    for (const oid of getAllOidsFromTiles(this.tiles)) {
      const data = getPropertyDataByOid(this.tiles, oid, this._internalData);
      if (evaluateStyleCondition(cond, data, evaluators)) {
        targetOids.push(oid);
      }
    }
    return targetOids;
  }

  /**
   * 冻结构件（射线拾取等交互将忽略这些构件）。参数为 OID 数组，或与 `setStyle` 的 `show` 同语义的属性条件字符串。
   */
  freeze(selection: number[] | string): void {
    const oids = this._getOidsForInteractionFilterSelection(selection);
    if (oids.length === 0) return;
    this._interactionFilter.freezeByOids(oids);
  }

  /**
   * 取消冻结。参数为 OID 数组，或与 `setStyle` 的 `show` 同语义的属性条件字符串（匹配到的 OID 会从冻结集中移除）。
   */
  unfreeze(selection: number[] | string): void {
    const oids = this._getOidsForInteractionFilterSelection(selection);
    if (oids.length === 0) return;
    this._interactionFilter.unfreezeByOids(oids);
  }

  /** 取消全部冻结 */
  unfreezeAll(): void {
    this._interactionFilter.unfreeze();
  }

  /**
   * 仅显示这些构件的交互（其余构件交互被屏蔽）。参数为 OID 数组，或与 `setStyle` 的 `show` 同语义的属性条件字符串。
   */
  isolate(selection: number[] | string): void {
    const oids = this._getOidsForInteractionFilterSelection(selection);
    if (oids.length === 0) return;
    this._interactionFilter.isolateByOids(oids);
  }

  /**
   * 从隔离集合中移除指定 OID。参数为 OID 数组，或与 `setStyle` 的 `show` 同语义的属性条件字符串。
   */
  unisolate(selection: number[] | string): void {
    const oids = this._getOidsForInteractionFilterSelection(selection);
    if (oids.length === 0) return;
    this._interactionFilter.unisolateByOids(oids);
  }

  /** 取消全部隔离（恢复为未隔离状态） */
  unisolateAll(): void {
    this._interactionFilter.unisolate();
  }

  /**
   * 合并 OID 列表对应的结构 bbox；若无可用 bbox 则使用 split mesh 世界包围盒并求中心。
   */
  private _getCenterFromOidList(oids: readonly number[]): Vector3 | null {
    this._syncStructureFromTileset();

    const union = new Box3();
    let hasStructureBox = false;
    for (const oid of oids) {
      const b = this.getBoundingBoxByOid(oid);
      if (b && !b.isEmpty()) {
        if (!hasStructureBox) {
          union.copy(b);
          hasStructureBox = true;
        } else {
          union.union(b);
        }
      }
    }
    if (hasStructureBox && !union.isEmpty()) {
      return union.getCenter(new Vector3());
    }

    const meshes = this.meshSplit.getMeshesByOids(oids);
    if (meshes.length === 0) return null;

    const meshBox = new Box3();
    for (const mesh of meshes) {
      mesh.updateMatrixWorld(true);
      meshBox.expandByObject(mesh);
    }
    for (const mesh of meshes) {
      disposeMergedSplitMeshResources(mesh);
    }
    if (meshBox.isEmpty()) return null;
    return meshBox.getCenter(new Vector3());
  }

  /**
   * 根据查询创建新的 MeshCollector（featureIds + 可选 condition）。
   * 每次调用都会新建实例；相同 condition / featureIds 多次调用会得到多个独立收集器，可同时存在。
   */
  getMeshCollectorByCondition(query: MeshCollectorQuery): MeshCollector {
    const resolved = resolveMeshCollectorQuery(query);
    if (resolved.featureIds.length === 0 && !resolved.condition) {
      throw new Error(
        "getMeshCollectorByCondition requires non-empty featureIds and/or a condition",
      );
    }

    const collector = new MeshCollector(query);
    this._registerMeshCollector(collector);
    const groupKey = collector.getInteractionGroupKey();

    this._interactionFilter.onCollectorMeshChange(groupKey, collector.meshes);

    collector.addEventListener("mesh-change", (event) => {
      this._interactionFilter.onCollectorMeshChange(groupKey, event.meshes);
    });

    return collector;
  }

  /**
   * 设置构件样式（条件可见性 + 条件材质）
   * @param style 样式配置，传 null 清除样式
   */
  setStyle(style: StyleConfig | null): void {
    this._styleHelper?.setStyle(style);
  }

  /**
   * 当前样式配置。赋值与 `setStyle(...)` 等价，例如 `plugin.style = { show, conditions }`。
   */
  get style(): StyleConfig | null {
    return this._styleHelper?.style ?? null;
  }

  set style(style: StyleConfig | null) {
    this.setStyle(style);
  }

  /**
   * 清除构件样式
   */
  clearStyle(): void {
    this._styleHelper?.clearStyle();
  }

  /**
   * 高亮指定构件（语义与 setStyle 一致：show、conditions、可选 featureIds，另需 name 标识分组）
   * @param options 高亮配置；PID 通道请设 `featureIdAttribute: 1` 或使用 conditions 对象形式
   */
  highlight(options: HighlightOptions): void {
    this._partHighlightHelper?.highlight(options);
  }

  /**
   * @deprecated 请使用 highlight({ ...options, featureIdAttribute: 1 })
   */
  highlightByPids(options: HighlightByPidsOptions): void {
    this._partHighlightHelper?.highlightByPids(options);
  }

  /**
   * @deprecated 请使用 getHighlightByName
   */
  getHighlightByPidName(name: string): HighlightByPidsOptions | undefined {
    return this._partHighlightHelper?.getHighlightByPidName(name);
  }

  /**
   * 按名称获取最近一次 highlight 传入的配置（取消高亮后返回 undefined）
   */
  getHighlightByName(name: string): HighlightOptions | undefined {
    return this._partHighlightHelper?.getHighlightByName(name);
  }

  /**
   * 按名称获取 highlight 位姿对应的4×4 矩阵（列主序 16 个数）。多种不同 TRS 条件并存时返回 undefined。
   */
  getHighlightMatrixByName(name: string): number[] | undefined {
    return this._partHighlightHelper?.getHighlightMatrixByName(name);
  }

  /**
   * 取消指定名称的高亮
   * @param name 高亮组名称
   */
  cancelHighlight(name: string): void {
    this._partHighlightHelper?.cancelHighlight(name);
  }

  /**
   * 取消指定名称的 PID 高亮
   */
  cancelHighlightByPid(name: string): void {
    this._partHighlightHelper?.cancelHighlightByPid(name);
  }

  /**
   * 取消所有高亮
   */
  cancelAllHighlight(): void {
    this._partHighlightHelper?.cancelAllHighlight();
  }

  /**
   * 取消所有 PID 高亮
   */
  cancelAllHighlightByPid(): void {
    this._partHighlightHelper?.cancelAllHighlightByPid();
  }

  _registerMeshCollector(collector: MeshCollector): void {
    collector._onRegister(this.meshSplit);
    this.collectors.add(collector);
  }

  _unregisterMeshCollector(collector: MeshCollector): void {
    const key = collector.getInteractionGroupKey();
    this.collectors.delete(collector);
    this._interactionFilter.onUnregisterCollector(key);
    collector.dispose();
  }

  /**
   * Plugin disposal
   */
  dispose() {
    if (this.tiles) {
      this.tiles.manager.removeHandler(this._gltfRegex);
      this.tiles.removeEventListener("load-model", this._onLoadModelCB);
      this.tiles.removeEventListener("dispose-model", this._onDisposeModelCB);
      this.tiles.removeEventListener(
        "tile-visibility-change",
        this._onTileVisibilityChangeCB,
      );
      this.tiles.removeEventListener(
        "load-root-tileset",
        this._onLoadRootTilesetCB,
      );
    }

    if (this._loader) {
      this._loader.removeListeners();
    }

    // 先让样式/高亮 releaseMeshCollector，再注销其余自建收集器；InteractionFilter 需在此之后 dispose（onUnregisterCollector 仍有效）
    this._styleHelper?.dispose();
    this._styleHelper = null;
    this._partHighlightHelper?.dispose();
    this._partHighlightHelper = null;

    for (const collector of this.collectors) {
      this._unregisterMeshCollector(collector);
    }
    this.collectors.clear();

    this._interactionFilter.dispose();

    this.meshSplit.clearCache();

    this._structureData = null;
    this._oidNodeMap.clear();
    this._oidPathMap.clear();

    // Clear model info data
    this._modelInfo = null;
    this._modelInfoPromise = null;

    this._loader = null;
    this.tiles = null;
  }
}
