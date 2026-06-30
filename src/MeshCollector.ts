import { BufferGeometry, EventDispatcher, Mesh, Object3D } from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import {
  buildMergedSplitGeometryForTileMesh,
  buildMergedSplitGeometryForTileMeshByPids,
  createMergedSplitMeshFromGeometry,
  createMergedSplitMeshFromGeometryByPids,
  disposeMergedSplitGeometryCacheEntry,
  disposeMergedSplitMeshResources,
  featureIdAttributeToChannel,
  getAllFeatureIdsFromTiles,
  getPropertyDataByFeatureAttribute,
  getTileMeshesByFeatureAttribute,
  isFeatureSourceMesh,
  selectDominantTileMeshesForOidSet,
  selectDominantTileMeshesForPidSet,
  type InternalData,
  type PartIdChannel,
} from "./mesh-helper";
import type { StyleConditionDescriptor } from "./plugin/style-appearance-types";
import {
  buildStyleConditionEvaluatorMap,
  evaluateStyleCondition,
} from "./plugin/style-condition-eval";
import {
  normalizeFeatureIdAttribute,
  resolveStyleConditionContent,
} from "./plugin/style-condition-input";
import { detachStyledMeshFromScene } from "./plugin/style-appearance-shared";

/** 挂在瓦片 feature mesh 的 userData 上：按「排序后 feature id 集 + 通道」复用合并 split 的 BufferGeometry */
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

/** 收集器查询：feature id 范围 + 可选属性条件（语义同 setStyle 的 show / conditions） */
/** 在单个瓦片 scene 内查找包含给定 part id 的 feature source mesh */
function collectCandidateTileMeshesInScene(
  scene: Object3D,
  idSet: Set<number>,
  channel: PartIdChannel,
): Set<Mesh> {
  const mapKey = channel === "pid" ? "pidMap" : "idMap";
  const candidateTiles = new Set<Mesh>();
  scene.traverse((child) => {
    const mesh = child as Mesh;
    if (!isFeatureSourceMesh(mesh)) return;
    const idMap = mesh.userData?.[mapKey] as Record<number, number> | undefined;
    if (!idMap) return;
    for (const partId of idSet) {
      if (idMap[partId] !== undefined) {
        candidateTiles.add(mesh);
        break;
      }
    }
  });
  return candidateTiles;
}

function buildSplitMeshesForTileMeshes(
  tileMeshes: Mesh[],
  idSet: Set<number>,
  featureIdAttribute: number,
): Mesh[] {
  const channel = featureIdAttributeToChannel(featureIdAttribute);
  const sortedKey =
    `f${featureIdAttribute}:` + [...idSet].sort((a, b) => a - b).join(",");
  const result: Mesh[] = [];

  for (const tileMesh of tileMeshes) {
    const perTile = getTileSplitGeometryCache(tileMesh);
    let geometry: BufferGeometry | undefined = perTile.get(sortedKey);
    if (!geometry) {
      const built =
        channel === "pid"
          ? buildMergedSplitGeometryForTileMeshByPids(tileMesh, idSet)
          : buildMergedSplitGeometryForTileMesh(tileMesh, idSet);
      if (built) {
        geometry = built;
        perTile.set(sortedKey, geometry);
      }
    }

    if (!geometry) continue;

    const m =
      channel === "pid"
        ? createMergedSplitMeshFromGeometryByPids(tileMesh, geometry, idSet, {
            splitGeometryManagedByCache: true,
          })
        : createMergedSplitMeshFromGeometry(tileMesh, geometry, idSet, {
            splitGeometryManagedByCache: true,
          });
    if (m) result.push(m);
  }
  return result;
}

export interface MeshCollectorQuery {
  /**
   * 限定在这些 feature id 内收集；不传或空数组时，若提供 condition 则从全场景对应通道中筛选
   */
  featureIds?: readonly number[];
  /**
   * 顶点属性索引，0 → `_FEATURE_ID_0`，1 → `_FEATURE_ID_1`；默认 0
   */
  featureIdAttribute?: number;
  /**
   * @deprecated 请使用 `featureIds` + `featureIdAttribute: 0`
   */
  oids?: readonly number[];
  /**
   * @deprecated 请使用 `featureIds` + `featureIdAttribute: 1`
   */
  pids?: readonly number[];
  /**
   * 属性表达式，如 `type === "wall"`；也支持 `{ content, featureIdAttribute }`
   */
  condition?: string | StyleConditionDescriptor;
  /**
   * 区分样式 / 高亮等（参与 `meshCollectorQueryCacheKey` 等语义），与几何缓存无关。
   */
  meshCacheNamespace?: string;
}

export interface ResolvedMeshCollectorQuery {
  featureIds: number[];
  featureIdAttribute: number;
  condition?: string;
}

/** 去重并排序 feature id */
export function normalizeMeshCollectorFeatureIds(
  featureIds: readonly number[],
): number[] {
  return [...new Set(featureIds)].sort((a, b) => a - b);
}

/** @deprecated 请使用 normalizeMeshCollectorFeatureIds */
export function normalizeMeshCollectorOids(oids: readonly number[]): number[] {
  return normalizeMeshCollectorFeatureIds(oids);
}

/** @deprecated 请使用 normalizeMeshCollectorFeatureIds */
export function normalizeMeshCollectorPids(pids: readonly number[]): number[] {
  return normalizeMeshCollectorFeatureIds(pids);
}

function resolveConditionString(
  condition?: string | StyleConditionDescriptor,
): string | undefined {
  if (condition == null) return undefined;
  const content =
    typeof condition === "string"
      ? condition
      : resolveStyleConditionContent(condition);
  if (typeof content !== "string") return undefined;
  const trimmed = content.trim();
  return trimmed || undefined;
}

/** 解析 MeshCollectorQuery，兼容 oids / pids 旧字段 */
export function resolveMeshCollectorQuery(
  query: MeshCollectorQuery,
): ResolvedMeshCollectorQuery {
  const hasFeatureIds =
    normalizeMeshCollectorFeatureIds(query.featureIds ?? []).length > 0;
  const hasOids = normalizeMeshCollectorFeatureIds(query.oids ?? []).length > 0;
  const hasPids = normalizeMeshCollectorFeatureIds(query.pids ?? []).length > 0;

  const legacyCount = [hasFeatureIds, hasOids, hasPids].filter(Boolean).length;
  if (legacyCount > 1) {
    throw new Error(
      "MeshCollectorQuery cannot specify more than one of featureIds, oids, and pids",
    );
  }

  let featureIds: number[] = [];
  let featureIdAttribute = normalizeFeatureIdAttribute(
    query.featureIdAttribute,
  );

  if (hasFeatureIds) {
    featureIds = normalizeMeshCollectorFeatureIds(query.featureIds!);
  } else if (hasOids) {
    featureIds = normalizeMeshCollectorFeatureIds(query.oids!);
    featureIdAttribute = 0;
  } else if (hasPids) {
    featureIds = normalizeMeshCollectorFeatureIds(query.pids!);
    featureIdAttribute = 1;
  }

  const conditionFromQuery = resolveConditionString(query.condition);
  const conditionAttr =
    query.condition != null && typeof query.condition === "object"
      ? normalizeFeatureIdAttribute(query.condition.featureIdAttribute)
      : undefined;

  if (conditionAttr !== undefined && legacyCount === 0) {
    featureIdAttribute = conditionAttr;
  }

  return {
    featureIds,
    featureIdAttribute,
    condition: conditionFromQuery,
  };
}

/**
 * 由查询生成的语义字符串，可用于日志或外部按查询维度分组。
 */
export function meshCollectorQueryCacheKey(query: MeshCollectorQuery): string {
  const resolved = resolveMeshCollectorQuery(query);
  const idPart =
    resolved.featureIds.length > 0 ? resolved.featureIds.join(",") : "*";
  const condRaw = resolved.condition ?? "";
  const condPart = condRaw === "" ? "_" : encodeURIComponent(condRaw);
  const ns = query.meshCacheNamespace?.trim() || "default";
  return `f${resolved.featureIdAttribute}:${idPart}@@${condPart}@@${ns}`;
}

/** StyleHelper 传入 `meshCollectorQueryCacheKey` 等语义区分 */
export const MESH_CACHE_NAMESPACE_STYLE = "style";
/** PartHighlightHelper 传入 `meshCollectorQueryCacheKey` 等语义区分 */
export const MESH_CACHE_NAMESPACE_HIGHLIGHT = "highlight";

/** @deprecated 请使用 meshCollectorQueryCacheKey({ featureIds, featureIdAttribute: 0 }) */
export function meshCollectorGroupKey(oids: readonly number[]): string {
  return meshCollectorQueryCacheKey({ featureIds: oids, featureIdAttribute: 0 });
}

/**
 * 瓦片级 split mesh 缓存与按 feature id / 条件查询（原 GLTFParserPlugin 内 mesh 合并逻辑）
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

  /** @deprecated 请使用 getMeshesByFeatureIds(featureIds, 0) */
  getMeshesByOids(oids: readonly number[]): Mesh[] {
    return this.getMeshesByFeatureIds(oids, 0);
  }

  /** @deprecated 请使用 getMeshesByFeatureIds(featureIds, 1) */
  getMeshesByPids(pids: readonly number[]): Mesh[] {
    return this.getMeshesByFeatureIds(pids, 1);
  }

  getMeshesByFeatureIds(
    featureIds: readonly number[],
    featureIdAttribute = 0,
  ): Mesh[] {
    return this.getMergedSplitMeshesForIdSet(
      new Set(featureIds),
      featureIdAttribute,
    );
  }

  /**
   * 按查询收集 mesh：可只传 featureIds、只传 condition（全场景对应通道上筛选）、或两者组合
   */
  getMeshesForCollectorQuery(params: ResolvedMeshCollectorQuery): Mesh[] {
    const targetIds = this.resolveTargetIdsForCollectorQuery(params);
    return this.getMergedSplitMeshesForIdSet(
      new Set(targetIds),
      params.featureIdAttribute,
    );
  }

  /**
   * 仅在给定瓦片 scene 内为 idSet 构建 split mesh（不全局遍历）。
   */
  getMergedSplitMeshesForIdSetInScene(
    idSet: Set<number>,
    featureIdAttribute: number,
    scene: Object3D,
  ): Mesh[] {
    if (idSet.size === 0) return [];

    const channel = featureIdAttributeToChannel(featureIdAttribute);
    const candidateTiles = collectCandidateTileMeshesInScene(
      scene,
      idSet,
      channel,
    );
    const tileMeshes =
      channel === "pid"
        ? selectDominantTileMeshesForPidSet(candidateTiles, idSet)
        : selectDominantTileMeshesForOidSet(candidateTiles, idSet);

    return buildSplitMeshesForTileMeshes(tileMeshes, idSet, featureIdAttribute);
  }

  private resolveTargetIdsForCollectorQuery(
    params: ResolvedMeshCollectorQuery,
  ): number[] {
    const tiles = this.getTiles();
    if (!tiles) return [];

    const { featureIds, featureIdAttribute, condition } = params;

    if (!condition) {
      if (featureIds.length === 0) return [];
      return [...featureIds];
    }

    const candidate =
      featureIds.length === 0
        ? getAllFeatureIdsFromTiles(tiles, featureIdAttribute)
        : [...new Set(featureIds)];
    const evaluators = buildStyleConditionEvaluatorMap({ show: condition });
    const internalData = this.getInternalData();
    const targetIds: number[] = [];
    for (const partId of candidate) {
      const data = getPropertyDataByFeatureAttribute(
        tiles,
        partId,
        featureIdAttribute,
        internalData,
      );
      if (evaluateStyleCondition(condition, data, evaluators)) {
        targetIds.push(partId);
      }
    }
    targetIds.sort((a, b) => a - b);
    return targetIds;
  }

  /**
   * 按 feature id 集合：每个瓦片 mesh 新建一个 Mesh，几何取自 tileMesh.userData 缓存
   */
  private getMergedSplitMeshesForIdSet(
    idSet: Set<number>,
    featureIdAttribute: number,
  ): Mesh[] {
    const tiles = this.getTiles();
    if (!tiles || idSet.size === 0) return [];

    const channel = featureIdAttributeToChannel(featureIdAttribute);
    const candidateTiles = new Set<Mesh>();

    for (const partId of idSet) {
      for (const tm of getTileMeshesByFeatureAttribute(
        tiles,
        partId,
        featureIdAttribute,
      )) {
        candidateTiles.add(tm);
      }
    }

    const tileMeshes =
      channel === "pid"
        ? selectDominantTileMeshesForPidSet(candidateTiles, idSet)
        : selectDominantTileMeshesForOidSet(candidateTiles, idSet);

    return buildSplitMeshesForTileMeshes(tileMeshes, idSet, featureIdAttribute);
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

/**
 * MeshCollector - 按查询条件监听并收集 split mesh
 */
export class MeshCollector extends EventDispatcher<MeshCollectorEventMap> {
  private static _nextInteractionId = 0;

  private readonly resolvedQuery: ResolvedMeshCollectorQuery;
  /** 实例唯一键（样式/高亮/冻结等按收集器实例追踪） */
  private readonly _interactionGroupKey: string;
  private meshSplit: MeshSplitResolver | null = null;
  private _meshes: Mesh[] = [];
  private _disposed: boolean = false;

  constructor(query: MeshCollectorQuery) {
    super();
    const resolved = resolveMeshCollectorQuery(query);
    if (resolved.featureIds.length === 0 && !resolved.condition) {
      throw new Error(
        "MeshCollector requires at least one feature id and/or a non-empty condition",
      );
    }
    this.resolvedQuery = resolved;
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

  getFeatureIds(): readonly number[] {
    return this.resolvedQuery.featureIds;
  }

  getFeatureIdAttribute(): number {
    return this.resolvedQuery.featureIdAttribute;
  }

  /** @deprecated 请使用 getFeatureIds()（featureIdAttribute 为 0 时） */
  getOids(): readonly number[] {
    return this.resolvedQuery.featureIdAttribute === 0
      ? this.resolvedQuery.featureIds
      : [];
  }

  /** @deprecated 请使用 getFeatureIds()[0]（featureIdAttribute 为 0 时） */
  getOid(): number | undefined {
    return this.getOids()[0];
  }

  /** @deprecated 请使用 getFeatureIds()（featureIdAttribute 为 1 时） */
  getPids(): readonly number[] {
    return this.resolvedQuery.featureIdAttribute === 1
      ? this.resolvedQuery.featureIds
      : [];
  }

  /** @deprecated 请使用 getFeatureIds()[0]（featureIdAttribute 为 1 时） */
  getPid(): number | undefined {
    return this.getPids()[0];
  }

  /** @deprecated 请使用 getFeatureIdAttribute() */
  getPartIdChannel(): PartIdChannel {
    return featureIdAttributeToChannel(this.resolvedQuery.featureIdAttribute);
  }

  get meshes(): Mesh[] {
    return this._meshes;
  }

  getCondition(): string | undefined {
    return this.resolvedQuery.condition;
  }

  /**
   * 全量重建 split mesh（仅在样式/高亮整体更新或收集器首次注册时调用）。
   */
  _updateMeshes(): void {
    if (this._disposed) return;
    if (!this.meshSplit) return;

    const newMeshes = this.meshSplit.getMeshesForCollectorQuery(
      this.resolvedQuery,
    );

    for (const mesh of this._meshes) {
      detachStyledMeshFromScene(mesh);
      disposeMergedSplitMeshResources(mesh);
    }
    this._meshes = newMeshes;

    this.dispatchEvent({ type: "mesh-change", meshes: this._meshes });
  }

  /**
   * 为单个瓦片 scene 增量追加 split mesh（tile-visibility-change 路径，不全局遍历）。
   * @returns 本次新创建的 split mesh
   */
  appendMeshesForTileScene(scene: Object3D): Mesh[] {
    if (this._disposed) return [];
    if (!this.meshSplit) return [];
    if (this.resolvedQuery.featureIds.length === 0) return [];

    const idSet = new Set(this.resolvedQuery.featureIds);
    const newMeshes = this.meshSplit.getMergedSplitMeshesForIdSetInScene(
      idSet,
      this.resolvedQuery.featureIdAttribute,
      scene,
    );
    if (newMeshes.length === 0) return [];

    const existingOrigins = new Set(
      this._meshes
        .map((m) => (m.userData?.originalMesh as Mesh | undefined)?.uuid)
        .filter(Boolean),
    );
    const toAdd = newMeshes.filter((m) => {
      const orig = m.userData?.originalMesh as Mesh | undefined;
      return orig && !existingOrigins.has(orig.uuid);
    });
    if (toAdd.length === 0) return [];

    this._meshes.push(...toAdd);
    this.dispatchEvent({ type: "mesh-change", meshes: this._meshes });
    return toAdd;
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
        detachStyledMeshFromScene(sm);
        disposeMergedSplitMeshResources(sm);
      } else {
        kept.push(sm);
      }
    }

    if (kept.length !== this._meshes.length) {
      this._meshes = kept;
      this.dispatchEvent({ type: "mesh-change", meshes: this._meshes });
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    if (this._meshes.length > 0) {
      for (const mesh of this._meshes) {
        detachStyledMeshFromScene(mesh);
        disposeMergedSplitMeshResources(mesh);
      }
    }

    this._meshes = [];
  }
}
