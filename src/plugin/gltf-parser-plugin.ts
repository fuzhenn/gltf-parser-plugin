import { TilesRenderer } from "3d-tiles-renderer";
import type {
  GLTFParserPluginOptions,
  ModelInfo,
  StructureData,
  StructureNode,
} from "../types";
import type { Box3, Intersection, Object3D, Plane, Vector3 } from "three";
import { GLTFWorkerLoader, defaultMaterialBuilder } from "../loader";
import { setMaxWorkers, resolveFetchOptions } from "../utils";
import { tileCache } from "../cache";
import type {
  StyleConfig,
  StyleCondition,
  StyleConditionInput,
} from "../style";
import { StyleHelper } from "../style";
import {
  buildPartIdToFeatureIdMap,
  queryFeatureFromIntersection,
  type FeatureInfo,
} from "../features";
import { PartInteractionFilter } from "../interaction";
import { ClippingPlanesHelper } from "../clipping";
import { StructureHelper } from "../structure";

const GLTF_REGEX = /\.(gltf|glb)$/g;

export class GLTFParserPlugin {
  name = "GLTFParserPlugin";

  private _options: GLTFParserPluginOptions;
  private _tiles: (TilesRenderer & Record<string, any>) | null = null;
  private _styleHelper: StyleHelper | null = null;
  private _loader: GLTFWorkerLoader | null = null;

  private readonly _structureHelper = new StructureHelper(() => this._tiles);
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
    this._structureHelper.invalidate();
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
  // 结构树 / 模型信息 / 空间选择（委托 StructureHelper）
  // =============================================

  /** 根据 oid 获取结构树节点（数据来自 tileset 内嵌 structureUri 同步解压） */
  getNodeTreeByOid(oid: number): StructureNode | null {
    return this._structureHelper.getNodeTreeByOid(oid);
  }

  /**
   * 根据 oid 从结构数据取轴对齐包围盒（`bbox` 为 `[minX,minY,minZ,maxX,maxY,maxZ]`，与 `selectByBox` 一致）
   * @returns 无对应节点或缺少有效 bbox 时返回 `null`
   */
  getBoundingBoxByOid(oid: number): Box3 | null {
    return this._structureHelper.getBoundingBoxByOid(oid);
  }

  /** 计算给定 OID 集合的几何中心（世界坐标系与结构 bbox 一致） */
  getCenterByOids(oids: readonly number[]): Vector3 | null {
    return this._structureHelper.getCenterByOids(oids);
  }

  /**
   * 按属性条件筛选构件（语义同 `setStyle` 的 `show` 表达式字符串），
   * 返回筛选结果的整体中心点；合并方式同 {@link getCenterByOids}。
   */
  getCenterByCondition(condition: string): Vector3 | null {
    return this._structureHelper.getCenterByCondition(condition);
  }

  /** 完整结构数据（与内嵌 structure JSON 一致） */
  getStructureData(): StructureData | null {
    return this._structureHelper.getStructureData();
  }

  /** 选择包围盒范围内的构件（坐标系与结构 bbox 一致） */
  selectByBox(box: Box3): number[] {
    return this._structureHelper.selectByBox(box);
  }

  /** 选择多边形（平面投影）范围内的构件 */
  selectByPolygon(
    polygon: Vector3[],
    axis: "xy" | "xz" | "yz" = "xz",
  ): number[] {
    return this._structureHelper.selectByPolygon(polygon, axis);
  }

  /**
   * 根据 OID 获取精细模型（detail model）的 URL。
   * 路径规则：与 tileset.json 同级 `details/{oid % 1000, 三位零填充}/{oid}.glb`
   */
  getDetailModelUrl(oid: number): string {
    return this._structureHelper.getDetailModelUrl(oid);
  }

  /** 获取 modelInfo.json 数据（首次调用时从 tileset URL 推导并请求，结果缓存） */
  async getModelInfo(): Promise<ModelInfo | null> {
    return this._structureHelper.getModelInfo();
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
