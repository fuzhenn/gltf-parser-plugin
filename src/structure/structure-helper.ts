import { Box3, Vector3 } from "three";
import type { TilesRenderer } from "3d-tiles-renderer";
import type {
  ModelInfo,
  StructureData,
  StructureNode,
} from "../types";
import {
  bboxArrayToBox3,
  selectByBoxFromOidMap,
  selectByPolygonFromOidMap,
} from "./spatial-selection";
import { parseStructureDataFromTilesSync } from "./tileset-structure";
import {
  getPropertyDataMapFromTiles,
} from "../features";
import {
  buildStyleConditionEvaluatorMap,
  evaluateStyleCondition,
} from "../style";

/**
 * 结构树 / 模型信息 / 空间选择子域：
 * - 从根 tileset 内嵌 structureUri 同步解压结构树并建立 OID → 节点索引；
 * - 提供 oid 查询、包围盒、几何中心、框选/多边形选择；
 * - 拉取与 tileset 同目录的侧车 JSON（modelInfo.json、details/{oid}.glb）。
 */
export class StructureHelper {
  private readonly _getTiles: () => TilesRenderer | null;
  private _structureData: StructureData | null = null;
  private readonly _oidNodeMap = new Map<number, StructureNode>();
  private _modelInfo: ModelInfo | null = null;
  private _modelInfoPromise: Promise<ModelInfo | null> | null = null;

  constructor(getTiles: () => TilesRenderer | null) {
    this._getTiles = getTiles;
  }

  /** 根 tileset 变化时失效缓存（子 tileset 的 load-tileset 不会触发） */
  invalidate(): void {
    this._structureData = null;
    this._oidNodeMap.clear();
  }

  /** 与 tileset 同目录的侧车文件 URL，如 modelInfo.json */
  private _sidecarUrl(fileName: string): string | null {
    const tiles = this._getTiles() as { rootURL?: string } | null;
    if (!tiles?.rootURL) return null;
    return tiles.rootURL.replace(/[^/]+$/, fileName);
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
    const tiles = this._getTiles();
    if (!tiles?.rootTileset) return null;

    const structureData = parseStructureDataFromTilesSync(tiles);
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
    const url = this._sidecarUrl("modelInfo.json");
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

  /** 根据 oid 获取结构树节点（数据来自 tileset 内嵌 structureUri 同步解压） */
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

  /** 计算给定 OID 集合的几何中心（世界坐标系与结构 bbox 一致） */
  getCenterByOids(oids: readonly number[]): Vector3 | null {
    if (!this._getTiles() || oids.length === 0) return null;
    return this._getCenterFromOidList([...new Set(oids)]);
  }

  /**
   * 按属性条件筛选构件（语义同 `setStyle` 的 `show` 表达式字符串），
   * 返回筛选结果的整体中心点；合并方式同 {@link getCenterByOids}。
   */
  getCenterByCondition(condition: string): Vector3 | null {
    const tiles = this._getTiles();
    if (!tiles) return null;
    const cond = condition.trim();
    if (!cond) return null;

    const evaluators = buildStyleConditionEvaluatorMap({ show: cond });
    const matched: number[] = [];
    for (const [oid, data] of getPropertyDataMapFromTiles(tiles)) {
      if (data && evaluateStyleCondition(cond, data, evaluators)) {
        matched.push(oid);
      }
    }
    return matched.length > 0 ? this._getCenterFromOidList(matched) : null;
  }

  /** 完整结构数据（与内嵌 structure JSON 一致） */
  getStructureData(): StructureData | null {
    return this._syncStructureFromTileset();
  }

  /** 选择包围盒范围内的构件（坐标系与结构 bbox 一致） */
  selectByBox(box: Box3): number[] {
    this._syncStructureFromTileset();
    return selectByBoxFromOidMap(this._oidNodeMap, box);
  }

  /** 选择多边形（平面投影）范围内的构件 */
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
    return this._sidecarUrl(`details/${folder}/${oid}.glb`) ?? "";
  }

  /** 获取 modelInfo.json 数据（首次调用时从 tileset URL 推导并请求，结果缓存） */
  async getModelInfo(): Promise<ModelInfo | null> {
    if (this._modelInfo) return this._modelInfo;
    if (!this._modelInfoPromise) {
      this._modelInfoPromise = this._fetchModelInfo();
    }
    return this._modelInfoPromise;
  }
}
