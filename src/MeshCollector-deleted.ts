import {
  BufferGeometry,
  EventDispatcher,
  InstancedMesh,
  Mesh,
  Object3D,
} from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import {
  buildMergedSplitGeometryForTileMesh,
  buildMergedSplitGeometryForTileMeshByPids,
  createMergedSplitMeshFromGeometry,
  createMergedSplitMeshFromGeometryByPids,
  disposeMergedSplitGeometryCacheEntry,
  disposeStyledMeshResources,
  featureIdAttributeToChannel,
  forEachLoadedFeatureSource,
  getAllFeatureIdsFromTiles,
  getPropertyDataByFeatureAttribute,
  getPropertyDataFromUserData,
  getTileMeshesByFeatureAttribute,
  isTileInstancedMesh,
  isTileMesh,
  selectDominantTileMeshesForOidSet,
  selectDominantTileMeshesForPidSet,
  type InternalData,
  type PartIdChannel,
} from "./mesh-helper";
import {
  buildSplitInstancedMeshForTileMesh,
  disposeTileMeshInstanceSplitCache,
} from "./mesh-helper/instance-split";
import type {
  StyleCondition,
  StyleConditionDescriptor,
  StyleConditionInput,
  StyleShowInput,
} from "./plugin/style-appearance-types";
import {
  buildStyleConditionEvaluatorMap,
  evaluateStyleCondition,
} from "./appearance";
import {
  normalizeFeatureIdAttribute,
  resolveShowFeatureIdAttribute,
  resolveStyleConditionContent,
  resolveStyleConditionFeatureIdAttribute,
} from "./appearance";
import {
  appearanceGroupKey,
  detachStyledMeshFromScene,
  resolveConditionsAppearance,
} from "./plugin/style-appearance-shared";

/** 挂在瓦片 feature mesh 的 userData 上：按「排序后 feature id 集 + 通道」复用合并 split 的 BufferGeometry */
const TILE_SPLIT_GEOMETRY_CACHE_KEY = "_gltfParserMergedSplitGeometryCache";

function getTileSplitGeometryCache(
  tileMesh: Mesh,
): Map<string, BufferGeometry> {
  const existing = tileMesh.userData[TILE_SPLIT_GEOMETRY_CACHE_KEY] as
    | Map<string, BufferGeometry>
    | undefined;
  if (existing) return existing;
  const map = new Map<string, BufferGeometry>();
  tileMesh.userData[TILE_SPLIT_GEOMETRY_CACHE_KEY] = map;
  return map;
}

/** 释放该瓦片 feature 源上缓存的 split 几何 / instance 下标；瓦片卸载前应调用 */
export function disposeTileMeshSplitGeometryCache(tileMesh: Mesh): void {
  const map = tileMesh.userData[TILE_SPLIT_GEOMETRY_CACHE_KEY] as
    | Map<string, BufferGeometry>
    | undefined;
  if (map) {
    for (const geom of map.values()) {
      disposeMergedSplitGeometryCacheEntry(geom, tileMesh);
    }
    map.clear();
    delete tileMesh.userData[TILE_SPLIT_GEOMETRY_CACHE_KEY];
  }
  if (tileMesh instanceof InstancedMesh) {
    disposeTileMeshInstanceSplitCache(tileMesh);
  }
}

function isTileFeatureSource(obj: Object3D): obj is Mesh {
  return isTileMesh(obj) || isTileInstancedMesh(obj);
}

/** 在单个瓦片 scene 内查找包含给定 part id 的 feature 源 */
function collectCandidateFeatureSourcesInScene(
  scene: Object3D,
  idSet: Set<number>,
  channel: PartIdChannel,
): Set<Mesh> {
  const mapKey = channel === "pid" ? "_tile_pidMap" : "_tile_oidMap";
  const candidateTiles = new Set<Mesh>();
  scene.traverse((child) => {
    if (!isTileFeatureSource(child)) return;
    const idMap = child.userData?.[mapKey] as
      | Record<number, number>
      | undefined;
    if (!idMap) return;
    for (const partId of idSet) {
      if (idMap[partId] !== undefined) {
        candidateTiles.add(child);
        break;
      }
    }
  });
  return candidateTiles;
}

function buildStyledMeshesForSources(
  tileMeshes: Mesh[],
  idSet: Set<number>,
  featureIdAttribute: number,
  cacheKey?: string,
): Mesh[] {
  const channel = featureIdAttributeToChannel(featureIdAttribute);
  const result: Mesh[] = [];

  for (const tileMesh of tileMeshes) {
    if (
      tileMesh instanceof InstancedMesh &&
      isTileInstancedMesh(tileMesh)
    ) {
      const instanced = buildSplitInstancedMeshForTileMesh(
        tileMesh,
        idSet,
        featureIdAttribute,
        cacheKey,
      );
      if (instanced) result.push(instanced);
      continue;
    }

    if (!isTileMesh(tileMesh)) continue;

    let geometry: BufferGeometry | undefined;
    if (cacheKey) {
      const perTile = getTileSplitGeometryCache(tileMesh);
      geometry = perTile.get(cacheKey);
      if (!geometry) {
        const built =
          channel === "pid"
            ? buildMergedSplitGeometryForTileMeshByPids(tileMesh, idSet)
            : buildMergedSplitGeometryForTileMesh(tileMesh, idSet);
        if (built) {
          geometry = built;
          perTile.set(cacheKey, geometry);
        }
      }
    } else {
      const built =
        channel === "pid"
          ? buildMergedSplitGeometryForTileMeshByPids(tileMesh, idSet)
          : buildMergedSplitGeometryForTileMesh(tileMesh, idSet);
      geometry = built ?? undefined;
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

/** 单瓦片 scene 增量路径：在 mesh 本地 OID 上 re-evaluate 规则（不依赖全局 featureIds 快照） */
export interface CollectorMatchRule {
  featureIdAttribute: number;
  /** 显式限定 id；与 condition / appearance 分组组合使用 */
  idFilter?: readonly number[];
  /** setStyle：show + conditions first-match，命中指定 appearance 分组 */
  show?: StyleShowInput;
  styleConditions?: StyleCondition[];
  appearanceGroupKey?: string;
  /** 单条 condition（自建 collector 等） */
  matchCondition?: string;
  /** highlight all-match：任一 entry 命中且 appearance 分组一致 */
  highlightEntries?: Array<{
    show?: StyleShowInput;
    condition: StyleConditionInput;
    appearanceGroupKey: string;
  }>;
}

function collectTileMeshesFromScene(scene: Object3D): Mesh[] {
  const tileMeshes: Mesh[] = [];
  scene.traverse((child) => {
    if (isTileFeatureSource(child)) {
      tileMeshes.push(child as Mesh);
    }
  });
  return tileMeshes;
}

function collectPartIdsFromTileMesh(
  tileMesh: Mesh,
  channel: PartIdChannel,
): number[] {
  const mapKey = channel === "pid" ? "_tile_pidMap" : "_tile_oidMap";
  const idMap = tileMesh.userData?.[mapKey] as
    | Record<number, number>
    | undefined;
  if (!idMap) return [];
  return Object.keys(idMap).map((k) => Number(k));
}

function resolveMatchedPartIdsOnTileMesh(
  tileMesh: Mesh,
  params: ResolvedMeshCollectorQuery,
  internalData?: InternalData,
): Set<number> {
  const { featureIdAttribute, featureIds, condition, matchRule } = params;
  const channel = featureIdAttributeToChannel(featureIdAttribute);
  const idFilter =
    matchRule?.idFilter != null
      ? new Set(matchRule.idFilter)
      : featureIds.length > 0
        ? new Set(featureIds)
        : null;

  const localPartIds = collectPartIdsFromTileMesh(tileMesh, channel);
  if (localPartIds.length === 0) return new Set();

  const matchedPartIds = new Set<number>();

  if (matchRule?.styleConditions && matchRule.appearanceGroupKey) {
    const showForChannel =
      matchRule.show != null &&
      resolveShowFeatureIdAttribute(matchRule.show) === featureIdAttribute
        ? matchRule.show
        : undefined;
    const evaluators = buildStyleConditionEvaluatorMap({
      show: matchRule.show,
      conditions: matchRule.styleConditions,
    });
    for (const partId of localPartIds) {
      if (idFilter && !idFilter.has(partId)) continue;
      const propertyData = getPropertyDataFromUserData(
        tileMesh.userData,
        partId,
        featureIdAttribute,
        internalData,
      );
      if (propertyData == null) continue;
      if (
        showForChannel &&
        !evaluateStyleCondition(showForChannel, propertyData, evaluators)
      ) {
        continue;
      }
      const appearance = resolveConditionsAppearance(
        matchRule.styleConditions,
        propertyData,
        evaluators,
        featureIdAttribute,
      );
      if (!appearance) continue;
      if (appearanceGroupKey(appearance) !== matchRule.appearanceGroupKey) continue;
      matchedPartIds.add(partId);
    }
    return matchedPartIds;
  }

  if (matchRule?.highlightEntries?.length && matchRule.appearanceGroupKey) {
    for (const partId of localPartIds) {
      if (idFilter && !idFilter.has(partId)) continue;
      const propertyData = getPropertyDataFromUserData(
        tileMesh.userData,
        partId,
        featureIdAttribute,
        internalData,
      );
      if (propertyData == null && !idFilter) continue;

      for (const entry of matchRule.highlightEntries) {
        const evaluators = buildStyleConditionEvaluatorMap({
          show: entry.show,
          conditions: [[entry.condition, {}]] as StyleCondition[],
        });
        const showForChannel =
          entry.show != null &&
          resolveShowFeatureIdAttribute(entry.show) === featureIdAttribute
            ? entry.show
            : undefined;
        if (
          showForChannel &&
          !evaluateStyleCondition(showForChannel, propertyData, evaluators)
        ) {
          continue;
        }
        if (
          resolveStyleConditionFeatureIdAttribute(entry.condition) !==
          featureIdAttribute
        ) {
          continue;
        }
        if (
          !evaluateStyleCondition(entry.condition, propertyData, evaluators)
        ) {
          continue;
        }
        if (entry.appearanceGroupKey !== matchRule.appearanceGroupKey) continue;
        matchedPartIds.add(partId);
        break;
      }
    }
    return matchedPartIds;
  }

  const matchCondition = matchRule?.matchCondition ?? condition;
  const showInput = matchRule?.show;
  if (matchCondition || showInput) {
    const evaluators = buildStyleConditionEvaluatorMap({
      show: showInput,
      conditions: matchCondition
        ? ([[matchCondition, {}]] as StyleCondition[])
        : [],
    });
    const showForChannel =
      showInput != null &&
      resolveShowFeatureIdAttribute(showInput) === featureIdAttribute
        ? showInput
        : undefined;
    for (const partId of localPartIds) {
      if (idFilter && !idFilter.has(partId)) continue;
      const propertyData = getPropertyDataFromUserData(
        tileMesh.userData,
        partId,
        featureIdAttribute,
        internalData,
      );
      if (propertyData == null && !idFilter) continue;
      if (
        showForChannel &&
        !evaluateStyleCondition(showForChannel, propertyData, evaluators)
      ) {
        continue;
      }
      if (
        matchCondition &&
        !evaluateStyleCondition(matchCondition, propertyData, evaluators)
      ) {
        continue;
      }
      matchedPartIds.add(partId);
    }
    return matchedPartIds;
  }

  if (idFilter) {
    for (const partId of localPartIds) {
      if (idFilter.has(partId)) matchedPartIds.add(partId);
    }
  }
  return matchedPartIds;
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
   * 属性表达式，如 `type === "wall"`；也支持 `{ content, featureIdAttribute }`
   */
  condition?: string | StyleConditionDescriptor;
  /**
   * 单瓦片 scene 增量时在本 mesh OID 上 re-evaluate；全量路径仍可用 featureIds 快照。
   */
  matchRule?: CollectorMatchRule;
  /**
   * 区分样式 / 高亮等（参与 `meshCollectorQueryCacheKey` 等语义），与几何缓存无关。
   */
  meshCacheNamespace?: string;
  /** 样式/高亮代际 uid（每次 setStyle / reapplyHighlight 递增） */
  generationUid?: number;
  /** 同一代际内 collector 序号（对应该次样式/高亮中的 condition 分组） */
  conditionIndex?: number;
}

export interface ResolvedMeshCollectorQuery {
  featureIds: number[];
  featureIdAttribute: number;
  condition?: string;
  matchRule?: CollectorMatchRule;
  /** 瓦片级 split / instance subset 缓存键（由 generationUid + conditionIndex 生成） */
  tileSubsetCacheKey?: string;
}

/** 瓦片级 subset/split 缓存键：feature 通道 + 命名空间 + 代际 uid + condition 序号 */
export function buildTileSubsetCacheKey(
  featureIdAttribute: number,
  namespace: string,
  generationUid: number,
  conditionIndex: number,
): string {
  return `f${featureIdAttribute}:${namespace}:${generationUid}:c${conditionIndex}`;
}

/** 去重并排序 feature id */
export function normalizeMeshCollectorFeatureIds(
  featureIds: readonly number[],
): number[] {
  return [...new Set(featureIds)].sort((a, b) => a - b);
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

/** 解析 MeshCollectorQuery */
export function resolveMeshCollectorQuery(
  query: MeshCollectorQuery,
): ResolvedMeshCollectorQuery {
  const featureIds = normalizeMeshCollectorFeatureIds(query.featureIds ?? []);
  let featureIdAttribute = normalizeFeatureIdAttribute(
    query.featureIdAttribute,
  );

  const conditionFromQuery = resolveConditionString(query.condition);
  const conditionAttr =
    query.condition != null && typeof query.condition === "object"
      ? normalizeFeatureIdAttribute(query.condition.featureIdAttribute)
      : undefined;

  if (conditionAttr !== undefined && featureIds.length === 0) {
    featureIdAttribute = conditionAttr;
  }

  const matchRule = query.matchRule
    ? {
        ...query.matchRule,
        featureIdAttribute:
          query.matchRule.featureIdAttribute ?? featureIdAttribute,
      }
    : undefined;

  let tileSubsetCacheKey: string | undefined;
  if (query.generationUid != null && query.conditionIndex != null) {
    const ns = query.meshCacheNamespace?.trim() || "default";
    tileSubsetCacheKey = buildTileSubsetCacheKey(
      featureIdAttribute,
      ns,
      query.generationUid,
      query.conditionIndex,
    );
  }

  return {
    featureIds,
    featureIdAttribute,
    condition: conditionFromQuery,
    matchRule,
    tileSubsetCacheKey,
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

/**
 * 瓦片级 split mesh 缓存与按 feature id / 条件查询（原 GLTFParserPlugin 内 mesh 合并逻辑）
 */
export class MeshSplitResolver {
  constructor(
    private readonly getTiles: () => TilesRenderer | null,
    private readonly getInternalData: () => InternalData | undefined = () =>
      undefined,
  ) {}

  /**
   * 遍历场景，释放所有瓦片 mesh 上挂的 split 几何缓存。
   * 调用前须已通过 `disposeMergedSplitMeshResources` 解绑各 split Mesh 对几何的引用。
   */
  clearCache(): void {
    const tiles = this.getTiles();
    if (!tiles) return;
    forEachLoadedFeatureSource(tiles, (source) => {
      disposeTileMeshSplitGeometryCache(source);
    });
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
      params.tileSubsetCacheKey,
    );
  }

  /**
   * 仅在给定瓦片 scene 内为 idSet 构建 split mesh（不全局遍历）。
   */
  getMergedSplitMeshesForIdSetInScene(
    idSet: Set<number>,
    featureIdAttribute: number,
    scene: Object3D,
    cacheKey?: string,
  ): Mesh[] {
    if (idSet.size === 0) return [];

    const channel = featureIdAttributeToChannel(featureIdAttribute);
    const candidateTiles = collectCandidateFeatureSourcesInScene(
      scene,
      idSet,
      channel,
    );
    const tileMeshes =
      channel === "pid"
        ? selectDominantTileMeshesForPidSet(candidateTiles, idSet)
        : selectDominantTileMeshesForOidSet(candidateTiles, idSet);

    return buildStyledMeshesForSources(
      tileMeshes,
      idSet,
      featureIdAttribute,
      cacheKey,
    );
  }

  /**
   * 在单个瓦片 scene 内按规则现场 evaluate 本地 OID，再 split（流式加载增量路径）。
   */
  getMergedSplitMeshesForRuleInScene(
    scene: Object3D,
    params: ResolvedMeshCollectorQuery,
  ): Mesh[] {
    const sceneTileMeshes = collectTileMeshesFromScene(scene);
    if (sceneTileMeshes.length === 0) return [];

    const channel = featureIdAttributeToChannel(params.featureIdAttribute);
    const internalData = this.getInternalData();
    const meshHits = new Map<Mesh, Set<number>>();

    for (const tileMesh of sceneTileMeshes) {
      const matchedPartIds = resolveMatchedPartIdsOnTileMesh(
        tileMesh,
        params,
        internalData,
      );
      if (matchedPartIds.size > 0) {
        meshHits.set(tileMesh, matchedPartIds);
      }
    }

    if (meshHits.size === 0) return [];

    const unionHits = new Set<number>();
    for (const hits of meshHits.values()) {
      for (const id of hits) unionHits.add(id);
    }

    const tileMeshes =
      channel === "pid"
        ? selectDominantTileMeshesForPidSet(new Set(meshHits.keys()), unionHits)
        : selectDominantTileMeshesForOidSet(
            new Set(meshHits.keys()),
            unionHits,
          );

    const result: Mesh[] = [];
    for (const tileMesh of tileMeshes) {
      const matchedPartIds = meshHits.get(tileMesh);
      if (!matchedPartIds || matchedPartIds.size === 0) continue;
      result.push(
        ...buildStyledMeshesForSources(
          [tileMesh],
          matchedPartIds,
          params.featureIdAttribute,
          params.tileSubsetCacheKey,
        ),
      );
    }
    return result;
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
    cacheKey?: string,
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

    return buildStyledMeshesForSources(
      tileMeshes,
      idSet,
      featureIdAttribute,
      cacheKey,
    );
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
    if (
      resolved.featureIds.length === 0 &&
      !resolved.condition &&
      !resolved.matchRule
    ) {
      throw new Error(
        "MeshCollector requires at least one feature id, a non-empty condition, and/or matchRule",
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

  get meshes(): Mesh[] {
    return this._meshes;
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
      disposeStyledMeshResources(mesh);
    }
    this._meshes = newMeshes;

    this.dispatchEvent({ type: "mesh-change", meshes: this._meshes });
  }

  /**
   * 为单个瓦片 scene 增量追加 split mesh。
   * @returns 本次新创建的 split mesh
   */
  appendMeshesForTileScene(scene: Object3D): Mesh[] {
    if (this._disposed) return [];
    if (!this.meshSplit) return [];

    const useRulePath =
      this.resolvedQuery.matchRule != null ||
      (this.resolvedQuery.condition != null &&
        this.resolvedQuery.featureIds.length === 0);

    const newMeshes = useRulePath
      ? this.meshSplit.getMergedSplitMeshesForRuleInScene(
          scene,
          this.resolvedQuery,
        )
      : this.appendMeshesByExplicitFeatureIds(scene);
    if (newMeshes.length === 0) return [];

    const existingOrigins = new Set(
      this._meshes
        .map((m) => (m.userData?._originalMesh as Mesh | undefined)?.uuid)
        .filter(Boolean),
    );
    const toAdd = newMeshes.filter((m) => {
      const orig = m.userData?._originalMesh as Mesh | undefined;
      return orig && !existingOrigins.has(orig.uuid);
    });
    if (toAdd.length === 0) return [];

    this._meshes.push(...toAdd);
    this.dispatchEvent({ type: "mesh-change", meshes: this._meshes });
    return toAdd;
  }

  /** 显式 featureIds 列表的增量路径（无 matchRule / condition 规则时） */
  private appendMeshesByExplicitFeatureIds(scene: Object3D): Mesh[] {
    if (this.resolvedQuery.featureIds.length === 0) return [];

    const idSet = new Set(this.resolvedQuery.featureIds);
    return this.meshSplit!.getMergedSplitMeshesForIdSetInScene(
      idSet,
      this.resolvedQuery.featureIdAttribute,
      scene,
      this.resolvedQuery.tileSubsetCacheKey,
    );
  }

  /**
   * 3d-tiles `dispose-model` 时调用：释放 `userData._originalMesh` 落在该瓦片 scene 内的 split mesh，
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
      const orig = sm.userData?._originalMesh as Mesh | undefined;
      if (orig && sourceMeshes.has(orig)) {
        detachStyledMeshFromScene(sm);
        disposeStyledMeshResources(sm);
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
        disposeStyledMeshResources(mesh);
      }
    }

    this._meshes = [];
  }
}
