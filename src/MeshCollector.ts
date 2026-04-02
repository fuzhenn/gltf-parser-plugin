import { EventDispatcher, Mesh } from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import {
  disposeMergedSplitMeshResources,
  getAllOidsFromTiles,
  getPropertyDataByOid,
  getTileMeshesByOid,
  splitMeshByOidsMerged,
} from "./mesh-helper";
import {
  buildStyleConditionEvaluatorMap,
  evaluateStyleCondition,
} from "./plugin/style-condition-eval";

/** 收集器查询：OID 范围 + 可选属性条件（语义同 setStyle 的 show / conditions 中的表达式字符串） */
export interface MeshCollectorQuery {
  /**
   * 限定在这些 OID 内收集；不传或空数组时，若提供 condition 则从全场景 OID 中筛选
   */
  oids?: readonly number[];
  /**
   * 属性表达式，如 `type === "wall"`，与 setStyle 里 `show` 或 `conditions[i][0]`（为 string 时）相同
   */
  condition?: string;
}

/**
 * 瓦片级 split mesh 缓存与按 OID / 条件查询（原 GLTFParserPlugin 内 mesh 合并逻辑）
 */
export class MeshSplitResolver {
  private splitMeshCache = new Map<string, Mesh[]>();

  constructor(private readonly getTiles: () => TilesRenderer | null) {}

  /**
   * 清空 split 缓存并释放独占资源（clone 材质 + 独立 index），避免仅 `Map.clear()` 导致的 GPU/对象滞留。
   * 顶点属性与瓦片共享，不在此处对共享 BufferAttribute 做 dispose。
   */
  clearCache(): void {
    for (const meshes of this.splitMeshCache.values()) {
      for (const mesh of meshes) {
        disposeMergedSplitMeshResources(mesh);
      }
    }
    this.splitMeshCache.clear();
  }

  /** 按 OID 列表取合并 split mesh（每瓦片一条），供中心点等计算 */
  getMeshesByOids(oids: readonly number[]): Mesh[] {
    return this.getMergedSplitMeshesForOidSet(new Set(oids));
  }

  /**
   * 按查询收集 mesh：可只传 oids、只传 condition（全场景 OID 上筛选）、或两者组合
   * condition 与 setStyle 的 show / conditions 中字符串表达式语义一致
   */
  getMeshesForCollectorQuery(params: {
    oids: readonly number[];
    condition?: string;
  }): Mesh[] {
    const tiles = this.getTiles();
    if (!tiles) return [];

    const cond = params.condition?.trim();
    let targetOids: number[];

    if (!cond) {
      if (params.oids.length === 0) return [];
      targetOids = [...new Set(params.oids)].sort((a, b) => a - b);
    } else {
      const candidate =
        params.oids.length === 0
          ? getAllOidsFromTiles(tiles)
          : [...new Set(params.oids)];
      const evaluators = buildStyleConditionEvaluatorMap({ show: cond });
      targetOids = [];
      for (const oid of candidate) {
        const data = getPropertyDataByOid(tiles, oid);
        if (evaluateStyleCondition(cond, data, evaluators)) {
          targetOids.push(oid);
        }
      }
      targetOids.sort((a, b) => a - b);
    }

    return this.getMeshesByOids(targetOids);
  }

  /**
   * 按 OID 集合：每个瓦片 mesh 只生成 **一个** 合并后的 split mesh（同一组 oid / condition 一条几何）
   */
  private getMergedSplitMeshesForOidSet(oidSet: Set<number>): Mesh[] {
    const tiles = this.getTiles();
    if (!tiles || oidSet.size === 0) return [];

    const sortedKey = [...oidSet].sort((a, b) => a - b).join(",");
    const result: Mesh[] = [];
    const candidateTiles = new Set<Mesh>();

    for (const oid of oidSet) {
      for (const tm of getTileMeshesByOid(tiles, oid)) {
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
   * 清理指定 tileMesh 相关的所有 split mesh
   * 在瓦片 dispose 时调用
   */
  disposeSplitMeshesByTile(tileMesh: Mesh): void {
    const prefix = `merged|${tileMesh.uuid}|`;
    const keysToDelete: string[] = [];

    for (const key of this.splitMeshCache.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      const meshes = this.splitMeshCache.get(key);
      if (meshes) {
        for (const mesh of meshes) {
          disposeMergedSplitMeshResources(mesh);
        }
      }
      this.splitMeshCache.delete(key);
    }
  }
}

export interface MeshChangeEvent {
  type: "mesh-change";
  meshes: Mesh[];
}

export type MeshCollectorEventMap = {
  "mesh-change": MeshChangeEvent;
};

/** 去重并排序 OID */
export function normalizeMeshCollectorOids(oids: readonly number[]): number[] {
  return [...new Set(oids)].sort((a, b) => a - b);
}

/**
 * 由查询（oids + condition）生成的语义字符串，可用于日志或外部按查询维度分组。
 */
export function meshCollectorQueryCacheKey(query: MeshCollectorQuery): string {
  const oidsNorm = normalizeMeshCollectorOids(query.oids ?? []);
  const oidPart = oidsNorm.length > 0 ? oidsNorm.join(",") : "*";
  const condRaw = query.condition?.trim() ?? "";
  const condPart = condRaw === "" ? "_" : encodeURIComponent(condRaw);
  return `${oidPart}@@${condPart}`;
}

/** @deprecated 请使用 meshCollectorQueryCacheKey({ oids }) */
export function meshCollectorGroupKey(oids: readonly number[]): string {
  return meshCollectorQueryCacheKey({ oids });
}

/**
 * MeshCollector - 按查询条件监听并收集 split mesh
 */
export class MeshCollector extends EventDispatcher<MeshCollectorEventMap> {
  private static _nextInteractionId = 0;

  private readonly queryOids: number[];
  private readonly condition: string | undefined;
  /** 实例唯一键（样式/高亮/冻结等按收集器实例追踪） */
  private readonly _interactionGroupKey: string;
  private meshSplit: MeshSplitResolver | null = null;
  private _meshes: Mesh[] = [];
  private _disposed: boolean = false;

  constructor(query: MeshCollectorQuery) {
    super();
    const oids = normalizeMeshCollectorOids(query.oids ?? []);
    const condition = query.condition?.trim() || undefined;
    if (oids.length === 0 && !condition) {
      throw new Error(
        "MeshCollector requires at least one OID in oids and/or a non-empty condition",
      );
    }
    this.queryOids = oids;
    this.condition = condition;
    this._interactionGroupKey = `mc-${++MeshCollector._nextInteractionId}`;
  }

  /**
   * 挂接到插件（meshSplit、MeshCollectorLifecycle）。须在使用前调用一次。
   */
  _onRegister(meshSplit: MeshSplitResolver): void {
    if (this._disposed) return;
    this.meshSplit = meshSplit;
    
    this._updateMeshes();
  }

  /** 实例唯一标识（样式/高亮监听、冻结/隔离等按收集器实例区分） */
  getInteractionGroupKey(): string {
    return this._interactionGroupKey;
  }

  /** 查询里显式传入的 OID（规范化后）；仅用 condition 筛选时可能为空数组 */
  getOids(): readonly number[] {
    return this.queryOids;
  }

  /** 有显式 OID 时返回第一个；否则无意义（可能为 undefined） */
  getOid(): number | undefined {
    return this.queryOids[0];
  }

  get meshes(): Mesh[] {
    return this._meshes;
  }

  /** 与 setStyle 一致的条件表达式（若有） */
  getCondition(): string | undefined {
    return this.condition;
  }

  _updateMeshes(): void {
    if (this._disposed) return;
    if (!this.meshSplit) return;

    const newMeshes = this.meshSplit.getMeshesForCollectorQuery({
      oids: this.queryOids,
      condition: this.condition,
    });

    const hasChanged =
      newMeshes.length !== this._meshes.length ||
      newMeshes.some((mesh: Mesh, i: number) => mesh !== this._meshes[i]);

    if (hasChanged) {
      this._meshes = newMeshes;
      this.dispatchEvent({ type: "mesh-change", meshes: this._meshes });
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    // 清理当前 collector 引用的 split mesh
    if ( this._meshes.length > 0) {
      for (const mesh of this._meshes) {
        disposeMergedSplitMeshResources(mesh);
      }
    }

    this._meshes = [];
  }
}