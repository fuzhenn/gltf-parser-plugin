import { BufferGeometry, EventDispatcher, Mesh, Object3D } from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import {
  buildMergedSplitGeometryForTileMesh,
  createMergedSplitMeshFromGeometry,
  disposeMergedSplitGeometryCacheEntry,
  disposeMergedSplitMeshResources,
  getAllOidsFromTiles,
  getPropertyDataByOid,
  getTileMeshesByOid,
  type InternalData,
} from "./mesh-helper";
import {
  buildStyleConditionEvaluatorMap,
  evaluateStyleCondition,
} from "./plugin/style-condition-eval";

/** 挂在瓦片 feature mesh 的 userData 上：按「排序后 OID 集」复用合并 split 的 BufferGeometry */
const TILE_SPLIT_GEOMETRY_CACHE_KEY = "_gltfParserMergedSplitGeometryCache";

function getTileSplitGeometryCache(tileMesh: Mesh): Map<string, BufferGeometry> {
  const existing = tileMesh.userData[
    TILE_SPLIT_GEOMETRY_CACHE_KEY
  ] as Map<string, BufferGeometry> | undefined;
  if (existing) return existing;
  const map = new Map<string, BufferGeometry>();
  tileMesh.userData[TILE_SPLIT_GEOMETRY_CACHE_KEY] = map;
  return map;
}

/** 释放该瓦片 mesh 上缓存的 split 几何；瓦片卸载 / dispose 前应调用（或由 {@link MeshSplitResolver.disposeSplitMeshesByTile}） */
export function disposeTileMeshSplitGeometryCache(tileMesh: Mesh): void {
  const map = tileMesh.userData[
    TILE_SPLIT_GEOMETRY_CACHE_KEY
  ] as Map<string, BufferGeometry> | undefined;
  if (!map) return;
  for (const geom of map.values()) {
    disposeMergedSplitGeometryCacheEntry(geom, tileMesh);
  }
  map.clear();
  delete tileMesh.userData[TILE_SPLIT_GEOMETRY_CACHE_KEY];
}

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
  /**
   * 区分样式 / 高亮等（参与 `meshCollectorQueryCacheKey` 等语义），与几何缓存无关。
   */
  meshCacheNamespace?: string;
}

/**
 * 瓦片级 split mesh 缓存与按 OID / 条件查询（原 GLTFParserPlugin 内 mesh 合并逻辑）
 */
export class MeshSplitResolver {
  constructor(
    private readonly getTiles: () => TilesRenderer | null,
    private readonly getInternalData: () =>
      | InternalData
      | undefined = () => undefined,
  ) {}

  /**
   * 遍历场景，释放所有瓦片 mesh 上挂的 split 几何缓存。
   * 调用前须已通过 `disposeMergedSplitMeshResources` 解绑各 split Mesh 对几何的引用。
   */
  clearCache(): void {
    const tiles = this.getTiles();
    if (!tiles) return;
    tiles.group.traverse((obj) => {
      if (obj instanceof Mesh) {
        disposeTileMeshSplitGeometryCache(obj);
      }
    });
  }

  /** 按 OID 列表取合并 split mesh（每瓦片一条），供中心点等计算 */
  getMeshesByOids(oids: readonly number[]): Mesh[] {
    return this.getMergedSplitMeshesForOidSet(new Set(oids));
  }

  /**
   * 解析结果 + 涉及瓦片 UUID 的稳定签名，供 MeshCollector 在「解析结果未变」时跳过重复 new Mesh。
   */
  getMeshesForCollectorQuerySignature(params: {
    oids: readonly number[];
    condition?: string;
  }): string {
    const targetOids = this.resolveTargetOidsForCollectorQuery(params);
    const tiles = this.getTiles();
    if (!tiles) {
      return targetOids.join(",");
    }
    const oidSet = new Set(targetOids);
    const candidateTiles = new Set<Mesh>();
    for (const oid of oidSet) {
      for (const tm of getTileMeshesByOid(tiles, oid)) {
        candidateTiles.add(tm);
      }
    }
    const uuids = [...candidateTiles]
      .map((m) => m.uuid)
      .sort()
      .join(",");
    return `${targetOids.join(",")}|${uuids}`;
  }

  /**
   * 按查询收集 mesh：可只传 oids、只传 condition（全场景 OID 上筛选）、或两者组合
   * condition 与 setStyle 的 show / conditions 中字符串表达式语义一致
   */
  getMeshesForCollectorQuery(params: {
    oids: readonly number[];
    condition?: string;
    meshCacheNamespace?: string;
  }): Mesh[] {
    const targetOids = this.resolveTargetOidsForCollectorQuery(params);
    return this.getMergedSplitMeshesForOidSet(new Set(targetOids));
  }

  private resolveTargetOidsForCollectorQuery(params: {
    oids: readonly number[];
    condition?: string;
  }): number[] {
    const tiles = this.getTiles();
    if (!tiles) return [];

    const cond = params.condition?.trim();

    if (!cond) {
      if (params.oids.length === 0) return [];
      return [...new Set(params.oids)].sort((a, b) => a - b);
    }

    const candidate =
      params.oids.length === 0
        ? getAllOidsFromTiles(tiles)
        : [...new Set(params.oids)];
    const evaluators = buildStyleConditionEvaluatorMap({ show: cond });
    const internalData = this.getInternalData();
    const targetOids: number[] = [];
    for (const oid of candidate) {
      const data = getPropertyDataByOid(tiles, oid, internalData);
      if (evaluateStyleCondition(cond, data, evaluators)) {
        targetOids.push(oid);
      }
    }
    targetOids.sort((a, b) => a - b);
    return targetOids;
  }

  /**
   * 按 OID 集合：每个瓦片 mesh **新建** 一个 Mesh，几何取自该 tileMesh.userData 上的缓存（按 sortedOids 键）
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
      const perTile = getTileSplitGeometryCache(tileMesh);
      let geometry: BufferGeometry | undefined = perTile.get(sortedKey);
      if (!geometry) {
        const built = buildMergedSplitGeometryForTileMesh(tileMesh, oidSet);
        if (built) {
          geometry = built;
          perTile.set(sortedKey, geometry);
        }
      }

      if (!geometry) {
        continue;
      }
      const m = createMergedSplitMeshFromGeometry(tileMesh, geometry, oidSet, {
        splitGeometryManagedByCache: true,
      });
      if (m) {
        result.push(m);
      }
    }
    return result;
  }

  /**
   * 释放挂在该 feature mesh `userData` 上的合并 split 几何缓存。
   * 通常由插件在 `TilesRenderer` 的 `dispose-model` 中与 {@link releaseSplitMeshesForTileScene} 一起调用。
   */
  disposeSplitMeshesByTile(tileMesh: Mesh): void {
    disposeTileMeshSplitGeometryCache(tileMesh);
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
  const ns = query.meshCacheNamespace?.trim() || "default";
  return `${oidPart}@@${condPart}@@${ns}`;
}

/** StyleHelper 传入 `meshCollectorQueryCacheKey` 等语义区分 */
export const MESH_CACHE_NAMESPACE_STYLE = "style";
/** PartHighlightHelper 传入 `meshCollectorQueryCacheKey` 等语义区分 */
export const MESH_CACHE_NAMESPACE_HIGHLIGHT = "highlight";

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
  private readonly meshCacheNamespace: string;
  /** 实例唯一键（样式/高亮/冻结等按收集器实例追踪） */
  private readonly _interactionGroupKey: string;
  private meshSplit: MeshSplitResolver | null = null;
  private _meshes: Mesh[] = [];
  /** 解析 OID + 瓦片集合 + 本收集器 id，未变则不再 new Mesh */
  private _lastMeshSignature: string | null = null;
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
    this.meshCacheNamespace = query.meshCacheNamespace?.trim() || "default";
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

    const sig = `${this._interactionGroupKey}|${this.meshSplit.getMeshesForCollectorQuerySignature({
      oids: this.queryOids,
      condition: this.condition,
    })}`;

    if (sig === this._lastMeshSignature) {
      return;
    }

    const newMeshes = this.meshSplit.getMeshesForCollectorQuery({
      oids: this.queryOids,
      condition: this.condition,
      meshCacheNamespace: this.meshCacheNamespace,
    });

    for (const mesh of this._meshes) {
      disposeMergedSplitMeshResources(mesh);
    }
    this._meshes = newMeshes;
    this._lastMeshSignature = sig;

    this.dispatchEvent({ type: "mesh-change", meshes: this._meshes });
  }

  /**
   * 3d-tiles `dispose-model` 时调用：释放 `userData.originalMesh` 落在该瓦片 scene 内的 split mesh，
   * 避免随后释放瓦片几何缓存时仍被 split Mesh 引用。
   */
  releaseSplitMeshesForTileScene(scene: Object3D): void {
    if (this._disposed) return;

    const sourceMeshes = new Set<Mesh>();
    scene.traverse((o) => {
      if (o instanceof Mesh) {
        sourceMeshes.add(o);
      }
    });

    const kept: Mesh[] = [];
    for (const sm of this._meshes) {
      const orig = sm.userData?.originalMesh as Mesh | undefined;
      if (orig && sourceMeshes.has(orig)) {
        disposeMergedSplitMeshResources(sm);
      } else {
        kept.push(sm);
      }
    }

    if (kept.length !== this._meshes.length) {
      this._meshes = kept;
      this._lastMeshSignature = null;
      this.dispatchEvent({ type: "mesh-change", meshes: this._meshes });
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    // 清理当前 collector 引用的 split mesh
    if (this._meshes.length > 0) {
      for (const mesh of this._meshes) {
        disposeMergedSplitMeshResources(mesh);
      }
    }

    this._meshes = [];
    this._lastMeshSignature = null;
  }
}
