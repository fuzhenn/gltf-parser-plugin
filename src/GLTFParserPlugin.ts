import { TilesRenderer } from "3d-tiles-renderer";
import type {
  GLTFParserPluginOptions,
  ModelInfo,
  StructureData,
  StructureNode,
} from "./types";
import { GLTFWorkerLoader, defaultMaterialBuilder } from "./loader";
import { setMaxWorkers, resolveFetchOptions } from "./utils";
import { tileCache } from "./db";
import { Box3, Intersection, Object3D, Plane, Vector3 } from "three";
import {
  buildStyleConditionEvaluatorMap,
  evaluateStyleCondition,
  type StyleCondition,
  type StyleConditionInput,
  type StyleConfig,
} from "./appearance";
import {
  buildPartIdToFeatureIdMap,
  FeatureInfo,
  getPropertyDataMapFromTiles,
  queryFeatureFromIntersection,
} from "./mesh-helper";
import { StyleHelper } from "./style-helper";
import { ClippingPlanesHelper } from "./plugin/clipping-planes-helper";
import { PartInteractionFilter } from "./plugin/part-interaction-filter";
import {
  bboxArrayToBox3,
  selectByBoxFromOidMap,
  selectByPolygonFromOidMap,
} from "./utils/spatial-selection";
import { parseStructureDataFromTilesSync } from "./utils/tileset-structure";

const GLTF_REGEX = /\.(gltf|glb)$/g;

export class GLTFParserPlugin {
  name = "GLTFParserPlugin";

  private _options: GLTFParserPluginOptions;
  private _tiles: (TilesRenderer & Record<string, any>) | null = null;
  private _styleHelper: StyleHelper | null = null;
  private _loader: GLTFWorkerLoader | null = null;

  // 结构树 / modelInfo 缓存（从 tileset 同步解析或按需拉取）
  private _structureData: StructureData | null = null;
  private readonly _oidNodeMap = new Map<number, StructureNode>();
  private _modelInfo: ModelInfo | null = null;
  private _modelInfoPromise: Promise<ModelInfo | null> | null = null;

  private readonly _clippingPlanesHelper = new ClippingPlanesHelper(
    () => this._tiles,
  );
  private readonly _interactionFilter = new PartInteractionFilter(
    () => this._tiles,
  );

  /**
   * Create a GLTFParserPlugin instance
   * @param options configuration options
   */
  constructor(options: GLTFParserPluginOptions) {
    this._options = options;

    // --- Worker pool setup ---
    setMaxWorkers(this._options.maxWorkers);
  }

  /**
   * Plugin initialization, called by TilesRenderer
   */
  init(tiles: TilesRenderer) {
    this._tiles = tiles;

    // --- GLTF loader setup ---
    const tilesFetchOptions = tiles.fetchOptions;
    const fetchOptions = resolveFetchOptions(
      tilesFetchOptions,
      this._options.fetchOptions,
    );
    const materialBuilder =
      this._options.materialBuilder ?? defaultMaterialBuilder;
    this._loader = new GLTFWorkerLoader(tiles.manager, {
      metadata: this._options.metadata,
      materialBuilder: materialBuilder,
      fetchOptions,
    });
    tiles.manager.addHandler(GLTF_REGEX, this._loader);

    tiles.addEventListener("load-model", this._onLoadModelCB);
    tiles.addEventListener("dispose-model", this._onDisposeModelCB);
    tiles.addEventListener("update-after", this._onUpdateAfterCB);
    tiles.addEventListener("load-root-tileset", this._onLoadRootTilesetCB);
  }

  /**
   * Fetch tile data with IndexedDB caching support
   */
  async fetchData(
    url: string,
    options?: RequestInit,
  ): Promise<Response | ArrayBuffer | object> {
    const isJson = url.toLowerCase().endsWith(".json");
    if (!this._options.useIndexedDB || isJson) {
      return this._tiles!.fetchData(url, options);
    }

    try {
      const cachedData = await tileCache.get(url);

      if (cachedData) {
        return cachedData;
      }

      const response = await this._tiles!.fetchData(url, options);

      if (!response.ok) {
        return response;
      }

      const arrayBuffer = await response.arrayBuffer();

      tileCache.set(url, arrayBuffer).catch((err: unknown) => {
        console.warn("[GLTFParserPlugin] Failed to cache data:", err);
      });

      return arrayBuffer;
    } catch (error) {
      return this._tiles!.fetchData(url, options);
    }
  }

  /**
   * Clear all cached tile data from IndexedDB
   */
  async clearCache(): Promise<void> {
    await tileCache.clear();
    console.info("[GLTFParserPlugin] Cache cleared");
  }

  /**
   * Parse tile data
   */
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
    return this._tiles!.parseTile(buffer, tile, extension, uri, abortSignal);
  }

  /**
   * Load model callback
   */
  private _onLoadModelCB = ({ scene }: { scene: Object3D }) => {
    buildPartIdToFeatureIdMap(scene);
    this._styleHelper?.applySceneIfStale(scene);
  };

  private _onDisposeModelCB = ({ scene }: { scene: Object3D }) => {
    this._styleHelper?.disposeTileScene(scene);
  };

  /** 根 tileset 变化时重解析 structure（子 tileset 的 load-tileset 不会触发） */
  private _onLoadRootTilesetCB = (): void => {
    this._structureData = null;
    this._oidNodeMap.clear();
  };

  /**
   * 只补处理"可见且样式代数落后"的瓦片；
   * 不可见的过期瓦片留到变可见时再处理。
   */
  private _onUpdateAfterCB = () => {
    const styleHelper = this._styleHelper;
    const visibleTiles = this._tiles?.visibleTiles as
      | Set<{ engineData?: { scene?: Object3D } }>
      | undefined;
    if (!styleHelper || !visibleTiles) return;

    for (const tile of visibleTiles) {
      const scene = tile?.engineData?.scene;
      if (scene) styleHelper.applySceneIfStale(scene);
    }
  };

  get tiles(): TilesRenderer | null {
    return this._tiles;
  }

  /**
   * 懒创建 StyleHelper（注入交互过滤器引用：冻结视觉与样式共用同一管线）
   */
  private _ensureStyleHelper(): StyleHelper {
    if (!this._styleHelper) {
      this._styleHelper = new StyleHelper(
        this._options.materialBuilder ?? defaultMaterialBuilder,
        this._interactionFilter,
      );
    }
    return this._styleHelper;
  }

  /**
   * 设置构件样式
   * @param style 样式配置，传 null 清除样式
   */
  setStyle(style: StyleConfig | null): void {
    if (!this._tiles) return;
    if (!this._styleHelper && !style) return;
    const styleHelper = this._ensureStyleHelper();

    const scenes: Object3D[] = [];
    this._tiles.forEachLoadedModel((scene: Object3D) => {
      scenes.push(scene);
    });

    // 被移除的条件必须立即从所有瓦片摘除（split 卸载），全量处理不能延后
    styleHelper.setStyle(style, scenes);

    // 新增/变更的样式只立即应用到当前可见瓦片；不可见瓦片由 update-after 按需补齐
    const visibleTiles = this._tiles.visibleTiles as
      | Set<{ engineData?: { scene?: Object3D } }>
      | undefined;
    if (!visibleTiles) return;
    for (const tile of visibleTiles) {
      const scene = tile?.engineData?.scene;
      if (scene) styleHelper.applySceneIfStale(scene);
    }
  }

  /**
   * 当前样式配置。赋值与 `setStyle(...)` 等价，例如 `plugin.style = { conditions }`。
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
    this.setStyle(null);
  }

  /**
   * 冻结构件
   */
  freeze(selection: StyleConditionInput | StyleCondition[]): void {
    if (!this._tiles) return;
    this._interactionFilter.freeze(selection);
    this._ensureStyleHelper().reapplyFrozen(this._tiles);
  }

  /** 取消全部冻结 */
  unfreeze(): void {
    this._interactionFilter.unfreeze();
    if (!this._tiles) return;
    this._ensureStyleHelper().reapplyFrozen(this._tiles);
  }

  /**
   * 查询命中点的构件信息；命中冻结构件时返回无效（冻结集为 fid 域，
   * 拾取返回的 oid 对应 channel 0）。
   */
  queryFeatureFromIntersection(hit: Intersection): FeatureInfo {
    const result = queryFeatureFromIntersection(hit);
    if (result.isValid && result.oid !== undefined) {
      if (this._interactionFilter.isFrozen(0, result.oid)) {
        return { isValid: false, error: "Component is frozen" };
      }
    }
    return result;
  }

  // =============================================
  // 结构树 / 模型信息
  // =============================================

  /** 与 tileset 同目录的侧车 JSON，如 modelInfo.json */
  private _tocJsonUrl(fileName: string): string | null {
    const rootURL = this._tiles?.rootURL as string | undefined;
    if (!rootURL) return null;
    return rootURL.replace(/[^/]+$/, fileName);
  }

  private _buildOidNodeMap(node: StructureNode): void {
    if (node.id !== undefined) this._oidNodeMap.set(node.id, node);
    for (const child of node.children ?? []) this._buildOidNodeMap(child);
  }

  /**
   * 从已加载根 tileset 的内嵌 structure（`asset.extras.maptalks.structureUri`）
   * 同步解压并建索引。rootTileset 尚未就绪时返回 null，可稍后再次调用。
   */
  private _syncStructureFromTileset(): StructureData | null {
    if (this._structureData) return this._structureData;
    if (!this._tiles?.rootTileset) return null;

    const structureData = parseStructureDataFromTilesSync(this._tiles);
    if (!structureData) return null;

    this._structureData = structureData;
    this._oidNodeMap.clear();
    for (const tree of structureData.trees ?? []) {
      this._buildOidNodeMap(tree);
    }
    return structureData;
  }

  /** 合并 OID 列表对应的结构 bbox 并求中心 */
  private _getCenterFromOidList(oids: readonly number[]): Vector3 | null {
    const union = new Box3();
    let hasBox = false;
    for (const oid of oids) {
      const b = this.getBoundingBoxByOid(oid);
      if (b && !b.isEmpty()) {
        if (hasBox) union.union(b);
        else {
          union.copy(b);
          hasBox = true;
        }
      }
    }
    return hasBox && !union.isEmpty() ? union.getCenter(new Vector3()) : null;
  }

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
   * 计算给定 OID 集合的几何中心（世界坐标系与结构 bbox 一致）
   */
  getCenterByOids(oids: readonly number[]): Vector3 | null {
    if (!this._tiles || oids.length === 0) return null;
    return this._getCenterFromOidList([...new Set(oids)]);
  }

  /**
   * 按属性条件筛选构件（语义同 `setStyle` 的 `show` 表达式字符串），
   * 返回筛选结果的整体中心点；合并方式同 {@link getCenterByOids}。
   */
  getCenterByCondition(condition: string): Vector3 | null {
    if (!this._tiles) return null;
    const cond = condition.trim();
    if (!cond) return null;

    const evaluators = buildStyleConditionEvaluatorMap({ show: cond });
    const matched: number[] = [];
    for (const [oid, data] of getPropertyDataMapFromTiles(this._tiles)) {
      if (data && evaluateStyleCondition(cond, data, evaluators)) {
        matched.push(oid);
      }
    }
    return matched.length > 0 ? this._getCenterFromOidList(matched) : null;
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

  /**
   * 获取 modelInfo.json 数据（首次调用时从 tileset URL 推导并请求，结果缓存）
   */
  async getModelInfo(): Promise<ModelInfo | null> {
    if (this._modelInfo) return this._modelInfo;
    if (!this._modelInfoPromise) {
      this._modelInfoPromise = this._fetchModelInfo();
    }
    return this._modelInfoPromise;
  }

  /**
   * 设置剖切平面，作用于 tiles.group 下所有 mesh 材质。
   * 新加载或 LRU 复现的瓦片会自动应用当前配置。
   * @param planes 剖切平面数组；传 null 或空数组清除剖切
   */
  setClippingPlanes(planes: Plane[] | null): void {
    this._clippingPlanesHelper.setClippingPlanes(planes);
  }

  /**
   * Plugin disposal
   */
  dispose() {
    if (this._tiles) {
      this._tiles.manager.removeHandler(GLTF_REGEX);
      this._tiles.removeEventListener("load-model", this._onLoadModelCB);
      this._tiles.removeEventListener("dispose-model", this._onDisposeModelCB);
      this._tiles.removeEventListener("update-after", this._onUpdateAfterCB);
      this._tiles.removeEventListener(
        "load-root-tileset",
        this._onLoadRootTilesetCB,
      );
    }

    if (this._loader) {
      this._loader.removeListeners();
    }
  }
}
