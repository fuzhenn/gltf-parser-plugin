import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  InstancedMesh,
  Mesh,
  Object3D,
  Sphere,
  Vector3,
} from "three";

import { TilesRenderer } from "3d-tiles-renderer";

import type {
  FeatureEdgeData,
  FeatureIdIndexData,
  IndexRange,
} from "../types";
import type { InstanceFeatures } from "../mesh/types";

/** 与源 index 同类型地分配新 index 数组（未指定类型时默认 Uint32Array） */
function createIndexArray(
  sourceIndex: ArrayLike<number>,
  length: number,
): Uint16Array | Uint32Array {
  if (sourceIndex instanceof Uint32Array) return new Uint32Array(length);
  if (sourceIndex instanceof Uint16Array) return new Uint16Array(length);
  return new Uint32Array(length);
}

/**
 * split index 的取值上界是顶点数而非三角形数：position.count ≤ 65535 时
 * 降为 Uint16，省一半内存与 GPU 上传带宽（大瓦片常用 Uint32 index）。
 */
function createSplitIndexArray(
  geometry: BufferGeometry,
  length: number,
): Uint16Array | Uint32Array {
  const position = geometry.getAttribute("position");
  return position && position.count <= 65535
    ? new Uint16Array(length)
    : new Uint32Array(length);
}

/** OID 对应 `_FEATURE_ID_0`，PID 对应 `_FEATURE_ID_1` */
export type PartIdChannel = "oid" | "pid";

const PART_ID_CHANNEL_CONFIG = {
  oid: {
    featureIndex: 0,
    mapKey: "_tile_oidMap",
    idKey: "oid",
    collectorKey: "collectorOids",
    namePrefix: "merged_features",
  },
  pid: {
    featureIndex: 1,
    mapKey: "_tile_pidMap",
    idKey: "pid",
    collectorKey: "collectorPids",
    namePrefix: "merged_pids",
  },
} as const;

export interface ResolvedFeatureChannel {
  geometry: BufferGeometry;
  featureIdAttr: BufferAttribute;
  featureIdConfig: {
    attribute?: number;
    propertyTable?: number;
  } | null;
}

/**
 * 解析 OID/PID 通道对应的 feature id 顶点属性。
 * PID 在 meshFeatures.featureIds[1] 未声明时，回退读取 geometry 上的 `_feature_id_1`。
 */
export function resolveFeatureChannelOnMesh(
  mesh: Mesh,
  channel: PartIdChannel,
): ResolvedFeatureChannel | null {
  const { meshFeatures } = mesh.userData;
  if (!meshFeatures) return null;

  const geometry = meshFeatures.geometry ?? mesh.geometry;
  if (!geometry) return null;

  const cfg = PART_ID_CHANNEL_CONFIG[channel];
  const featureIds = meshFeatures.featureIds ?? [];
  const featureIdConfig = featureIds[cfg.featureIndex];

  if (featureIdConfig != null) {
    const attr = geometry.getAttribute(
      `_feature_id_${featureIdConfig.attribute}`,
    );
    if (attr) {
      return { geometry, featureIdAttr: attr, featureIdConfig };
    }
  }

  if (channel === "pid") {
    const attr = geometry.getAttribute("_feature_id_1");
    if (attr) {
      return {
        geometry,
        featureIdAttr: attr,
        featureIdConfig: featureIds[1] ?? null,
      };
    }
  }

  return null;
}

function getPartIdMap(
  mesh: Mesh,
  channel: PartIdChannel,
): Record<number, number> | undefined {
  return mesh.userData?.[PART_ID_CHANNEL_CONFIG[channel].mapKey] as
    | Record<number, number>
    | undefined;
}

/**
 * split 必须从「隐藏原片前」的完整 index 抽取三角形。
 * 显隐规则会改写 `geometry.index`；若用当前 index，被隐藏构件的三角已被删掉 → split 为空。
 */
/** 完整 index（优先 userData 备份），供 split / hide 使用 */
export function getFeatureSplitSourceIndex(
  tileMesh: Mesh,
  geometry: BufferGeometry,
): ArrayLike<number> | null {
  const stored = tileMesh.userData._originalIndex;
  if (stored instanceof BufferAttribute) {
    const arr = stored.array;
    if (arr && arr.length > 0) return arr;
  }
  return geometry.index?.array ?? null;
}

/**
 * 首次过滤前把 geometry.index 的属性对象引用备份到 userData._originalIndex，
 */
export function snapshotOriginalIndex(
  mesh: Mesh,
  geometry: BufferGeometry,
): BufferAttribute | null {
  const stored = mesh.userData._originalIndex;
  if (stored instanceof BufferAttribute) return stored;
  const current = geometry.index;
  if (!current) return null;
  mesh.userData._originalIndex = current;
  return current;
}

/**
 * 取 worker 预构建并挂在 mesh.userData 上的按 fid 分组 index。
 */
function getFeatureIdIndexCache(
  mesh: Mesh,
  attrName: string,
): FeatureIdIndexData | undefined {
  return mesh.userData._featureIdIndexCaches?.[attrName];
}

/** 排除 hiddenFids 后，按 fid 索引表拼接可见 index */
export function buildVisibleIndex(
  mesh: Mesh,
  sourceIndex: ArrayLike<number>,
  attrName: string,
  hiddenFids: Set<number>,
): Uint16Array | Uint32Array {
  const cache = getFeatureIdIndexCache(mesh, attrName);
  if (!cache) return createIndexArray(sourceIndex, 0);

  const { featureIdIndexMap, buffer } = cache;

  let totalLength = 0;
  const indexRanges: IndexRange[] = [];
  for (const [fidKey, entry] of Object.entries(featureIdIndexMap)) {
    if (!hiddenFids.has(Number(fidKey))) {
      totalLength += entry.length;
      indexRanges.push(entry);
    }
  }

  const result = createIndexArray(sourceIndex, totalLength);
  let writeOffset = 0;
  for (const range of indexRanges) {
    result.set(
      buffer.subarray(range.offset, range.offset + range.length),
      writeOffset,
    );
    writeOffset += range.length;
  }
  return result;
}

type MergedSplitContext = {
  geometry: BufferGeometry;
  featureIdAttr: BufferAttribute;
  sourceIndex: ArrayLike<number>;
  indexCache: FeatureIdIndexData;
  /** 按 targetFids 顺序收集的 index 段（无 entry 的 fid 已剔除），与 totalIndexLength 严格一致 */
  entries: IndexRange[];
  totalIndexLength: number;
};

function resolveMergedSplitContext(
  originalMesh: Mesh,
  idSet: ReadonlySet<number>,
  channel: PartIdChannel,
): MergedSplitContext | null {
  const idMap = getPartIdMap(originalMesh, channel);
  if (!idMap) return null;

  const resolved = resolveFeatureChannelOnMesh(originalMesh, channel);
  if (!resolved) return null;

  const { geometry, featureIdAttr, featureIdConfig } = resolved;
  const attrName = `_feature_id_${featureIdConfig?.attribute ?? (channel === "pid" ? 1 : 0)}`;

  const targetFids = new Set<number>();
  for (const partId of idSet) {
    const fid = idMap[partId];
    if (fid !== undefined) {
      targetFids.add(fid);
    }
  }
  if (targetFids.size === 0) return null;

  const sourceIndex = getFeatureSplitSourceIndex(originalMesh, geometry);
  if (!sourceIndex || sourceIndex.length === 0) return null;

  const indexCache = getFeatureIdIndexCache(originalMesh, attrName);
  if (!indexCache) return null;
  const { featureIdIndexMap } = indexCache;

  const entries: IndexRange[] = [];
  let totalIndexLength = 0;
  for (const fid of targetFids) {
    const entry = featureIdIndexMap[fid];
    if (!entry) continue;
    entries.push(entry);
    totalIndexLength += entry.length;
  }
  if (totalIndexLength === 0) return null;

  return {
    geometry,
    featureIdAttr,
    sourceIndex,
    indexCache,
    entries,
    totalIndexLength,
  };
}

function computeLocalBBoxForIndexRanges(
  geometry: BufferGeometry,
  buffer: Uint16Array | Uint32Array,
  entries: IndexRange[],
): Box3 | null {
  const posAttr = geometry.getAttribute("position");
  if (!posAttr) return null;

  const positions = posAttr.array as Float32Array;
  const itemSize = posAttr.itemSize || 3;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const entry of entries) {
    const end = entry.offset + entry.length;
    for (let i = entry.offset; i < end; i++) {
      const base = buffer[i]! * itemSize;
      const x = positions[base]!;
      const y = positions[base + 1]!;
      const z = positions[base + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }

  if (minX === Infinity) return null;
  return new Box3(new Vector3(minX, minY, minZ), new Vector3(maxX, maxY, maxZ));
}

/** 合并多个 feature 的三角形为单一 BufferGeometry（共享顶点属性，index 为并集） */
function createGeometryForFeatureIdSet(
  context: MergedSplitContext,
): BufferGeometry | null {
  const {
    geometry: originalGeometry,
    indexCache,
    entries,
    totalIndexLength,
  } = context;
  const { buffer } = indexCache;

  const newGeometry = new BufferGeometry();
  const attributes = originalGeometry.attributes;
  for (const attributeName in attributes) {
    newGeometry.setAttribute(attributeName, attributes[attributeName]);
  }

  const newIndices = createSplitIndexArray(originalGeometry, totalIndexLength);
  let writeOffset = 0;
  for (const entry of entries) {
    newIndices.set(
      buffer.subarray(entry.offset, entry.offset + entry.length),
      writeOffset,
    );
    writeOffset += entry.length;
  }
  newGeometry.setIndex(new BufferAttribute(newIndices, 1));

  // 顶点属性与瓦片共享（全量顶点），不预设紧致包围盒会让 three 首帧对全量顶点
  // 懒计算 boundingSphere，且包围球会膨胀到整瓦片，导致 split mesh 视锥剔除失效
  const localBBox = computeLocalBBoxForIndexRanges(
    originalGeometry,
    buffer,
    entries,
  );
  if (localBBox) {
    newGeometry.boundingBox = localBBox;
    newGeometry.boundingSphere = localBBox.getBoundingSphere(new Sphere());
  }

  const sourceEdges = originalGeometry.userData.featureEdges as
    | FeatureEdgeData
    | undefined;
  if (sourceEdges) {
    newGeometry.userData.featureEdges = sourceEdges;
  }

  return newGeometry;
}

/**
 * 仅构建合并后的 split 几何（与瓦片共享顶点属性 + 独立 index），供多路 Mesh 复用。
 */
function buildMergedSplitGeometryForTileMeshByChannel(
  originalMesh: Mesh,
  idSet: ReadonlySet<number>,
  channel: PartIdChannel,
): BufferGeometry | null {
  const context = resolveMergedSplitContext(originalMesh, idSet, channel);
  if (!context) return null;

  const newGeometry = createGeometryForFeatureIdSet(context);
  if (!newGeometry || newGeometry.attributes.position.count === 0) {
    return null;
  }

  return newGeometry;
}

export function buildMergedSplitGeometryForTileMesh(
  originalMesh: Mesh,
  oidSet: ReadonlySet<number>,
): BufferGeometry | null {
  return buildMergedSplitGeometryForTileMeshByChannel(
    originalMesh,
    oidSet,
    "oid",
  );
}

/** 按 PID 集合从瓦片 mesh 构建合并 split 几何（使用 `_FEATURE_ID_1`） */
export function buildMergedSplitGeometryForTileMeshByPids(
  originalMesh: Mesh,
  pidSet: ReadonlySet<number>,
): BufferGeometry | null {
  return buildMergedSplitGeometryForTileMeshByChannel(
    originalMesh,
    pidSet,
    "pid",
  );
}

export function addMeshUserData(
  tileMesh: Mesh,
  splitMesh: Mesh,
  idSet: ReadonlySet<number>,
  channel: PartIdChannel,
  options?: { splitGeometryManagedByCache?: boolean },
) {
  if (idSet.size === 0) return null;

  const cfg = PART_ID_CHANNEL_CONFIG[channel];
  const idMap = getPartIdMap(tileMesh, channel);
  if (!idMap) return null;

  const resolved = resolveFeatureChannelOnMesh(tileMesh, channel);
  if (!resolved) return null;

  const idsOnMesh: number[] = [];
  for (const partId of idSet) {
    if (idMap[partId] !== undefined) {
      idsOnMesh.push(partId);
    }
  }
  idsOnMesh.sort((a, b) => a - b);
  if (idsOnMesh.length === 0) return null;
  const primaryId = idsOnMesh[0]!;

  const { structuralMetadata } = tileMesh.userData;
  const propertyTableIndex = resolved.featureIdConfig?.propertyTable;

  let propertyData: unknown = null;
  if (
    structuralMetadata &&
    propertyTableIndex !== undefined &&
    idMap[primaryId] !== undefined
  ) {
    try {
      propertyData = structuralMetadata.getPropertyTableData(
        propertyTableIndex,
        idMap[primaryId]!,
      );
    } catch {
      // ignore
    }
  }

  const userData: Record<string, unknown> = {
    ...tileMesh.userData,
    featureId: idMap[primaryId],
    [cfg.idKey]: primaryId,
    [cfg.collectorKey]: idsOnMesh,
    _originalMesh: tileMesh,
    propertyData,
    _isSplit: true,
    isMergedSplit: true,
    partIdChannel: channel,
  };
  if (options?.splitGeometryManagedByCache) {
    userData.splitGeometryManagedByCache = true;
  }
  splitMesh.userData = userData;

  splitMesh.name = `${cfg.namePrefix}_${idsOnMesh.length}_${primaryId}`;
}

/** 瓦片内原始普通 mesh（非 InstancedMesh、非 split） */
export function isTileMesh(obj: Object3D): obj is Mesh {
  return (
    obj instanceof Mesh &&
    !(obj instanceof InstancedMesh) &&
    !!obj.userData.meshFeatures &&
    !!obj.userData.structuralMetadata &&
    !obj.userData._isSplit
  );
}

export function isTileInstancedMesh(obj: Object3D): obj is InstancedMesh {
  return (
    obj instanceof InstancedMesh &&
    !!obj.userData.instanceFeatures &&
    !!obj.userData.structuralMetadata &&
    !obj.userData._isSplit
  );
}

/**
 * 遍历当前已加载的瓦片 feature 源（普通 mesh + InstancedMesh，按 uuid 去重）。
 */
export function forEachLoadedFeatureSource(
  tiles: TilesRenderer,
  fn: (source: Mesh | InstancedMesh) => void,
): void {
  const seen = new Set<string>();
  const visitRoot = (root: Object3D) => {
    root.traverse((child) => {
      if (
        (!isTileMesh(child) && !isTileInstancedMesh(child)) ||
        seen.has(child.uuid)
      )
        return;
      seen.add(child.uuid);
      fn(child);
    });
  };
  visitRoot(tiles.group);
  tiles.traverse((tile: unknown) => {
    const scene = (tile as { engineData?: { scene?: Object3D } }).engineData
      ?.scene;
    if (scene) visitRoot(scene);
    return true;
  }, null);
}

/**
 * 从 userData 读取零件属性（自动区分 meshFeatures / instanceFeatures）。
 */
export function getPropertyDataFromUserData(
  userData: Record<string, unknown>,
  partId: number,
  featureIdAttribute: number,
  internalData?: InternalData,
): Record<string, unknown> | null {
  const instanceFeatures = userData.instanceFeatures as
    | InstanceFeatures
    | undefined;
  if (instanceFeatures) {
    const structuralMetadata = userData.structuralMetadata as
      | {
          getPropertyTableData(
            tableIndex: number,
            id: number,
          ): Record<string, unknown>;
        }
      | undefined;
    const idMap = getPartIdMapForFeatureAttribute(userData, featureIdAttribute);
    if (!structuralMetadata || !idMap) return null;

    const fid = idMap[partId];
    if (fid === undefined) return null;

    const propertyTableIndex =
      instanceFeatures.featureIds[featureIdAttribute]?.propertyTable;
    if (propertyTableIndex === undefined) {
      return featureIdAttribute === 1 ? { _pid: partId, pid: partId } : null;
    }

    try {
      const data = structuralMetadata.getPropertyTableData(
        propertyTableIndex,
        fid,
      );
      return featureIdAttribute === 0 && internalData
        ? internalData(partId, data)
        : data;
    } catch {
      return featureIdAttribute === 1 ? { _pid: partId, pid: partId } : null;
    }
  }

  return getPropertyDataFromMeshUserData(
    userData,
    partId,
    featureIdAttribute,
    internalData,
  );
}

function collectPartIdsFromSourceUserData(
  userData: Record<string, unknown>,
  featureIdAttribute: number,
): number[] {
  const idMap = getPartIdMapForFeatureAttribute(userData, featureIdAttribute);
  if (!idMap) return [];
  return Object.keys(idMap).map(Number);
}

/**
 * 内部数据钩子：在原始属性表数据基础上派生/注入额外字段（如层级 `_path`）。
 * 返回新对象；约定不修改入参。
 */
export type InternalData = (
  oid: number,
  data: Record<string, unknown>,
) => Record<string, unknown>;

/**
 * 单次遍历场景构建 OID → 属性表数据。
 * 批量样式/筛选时使用，避免对每个 OID 重复 traverse（O(n×场景节点)）。
 */
export function getPropertyDataMapFromTiles(
  tiles: TilesRenderer,
  internalData?: InternalData,
): Map<number, Record<string, unknown> | null> {
  const map = new Map<number, Record<string, unknown> | null>();

  forEachLoadedFeatureSource(tiles, (source) => {
    for (const oid of collectPartIdsFromSourceUserData(source.userData, 0)) {
      if (map.has(oid) && map.get(oid) != null) continue;
      const data = getPropertyDataFromUserData(
        source.userData,
        oid,
        0,
        internalData,
      );
      if (data != null) {
        map.set(oid, data);
      } else if (!map.has(oid)) {
        map.set(oid, null);
      }
    }
  });

  return map;
}

/**
 * 单次遍历场景构建 PID → 属性表数据
 */
export function getPropertyDataMapFromTilesByPid(
  tiles: TilesRenderer,
): Map<number, Record<string, unknown> | null> {
  const map = new Map<number, Record<string, unknown> | null>();

  forEachLoadedFeatureSource(tiles, (source) => {
    for (const pid of collectPartIdsFromSourceUserData(source.userData, 1)) {
      if (map.has(pid) && map.get(pid) != null) continue;
      const data = getPropertyDataFromUserData(source.userData, pid, 1);
      if (data != null) {
        map.set(pid, data);
      } else if (!map.has(pid)) {
        map.set(pid, null);
      }
    }
  });

  return map;
}

/** `_FEATURE_ID_N` 索引 → 内部 PartIdChannel（当前仅 0/1 有完整管线） */
export function featureIdAttributeToChannel(
  featureIdAttribute: number,
): PartIdChannel {
  return featureIdAttribute === 1 ? "pid" : "oid";
}

/** 读取 mesh / userData 上 OID 或 PID → featureId 映射表 */
export function getPartIdMapForFeatureAttribute(
  source: Mesh | Record<string, unknown>,
  featureIdAttribute: number,
): Record<number, number> | undefined {
  const userData =
    source instanceof Mesh
      ? source.userData
      : (source as Record<string, unknown>);
  const channel = featureIdAttributeToChannel(featureIdAttribute);
  return userData[PART_ID_CHANNEL_CONFIG[channel].mapKey] as
    | Record<number, number>
    | undefined;
}

/**
 * 从单个 mesh（或其 userData）读取零件属性，仅用本 mesh 的 idMap/pidMap + structuralMetadata。
 */
export function getPropertyDataFromMeshUserData(
  userData: Record<string, unknown>,
  partId: number,
  featureIdAttribute: number,
  internalData?: InternalData,
): Record<string, unknown> | null {
  const meshFeatures = userData.meshFeatures as
    | { geometry?: BufferGeometry }
    | undefined;
  const mesh = {
    userData,
    geometry: meshFeatures?.geometry,
  } as Mesh;
  return getPropertyDataOnMeshByPartId(
    mesh,
    partId,
    featureIdAttribute,
    internalData,
  );
}

function getPropertyDataOnMeshByPartId(
  mesh: Mesh,
  partId: number,
  featureIdAttribute: number,
  internalData?: InternalData,
): Record<string, unknown> | null {
  const channel = featureIdAttributeToChannel(featureIdAttribute);
  const idMap = getPartIdMap(mesh, channel);
  if (!idMap || idMap[partId] === undefined) return null;

  const fid = idMap[partId]!;
  const resolved = resolveFeatureChannelOnMesh(mesh, channel);
  if (!resolved) return null;

  const { structuralMetadata } = mesh.userData;
  const propertyTableIndex = resolved.featureIdConfig?.propertyTable;

  if (propertyTableIndex === undefined || !structuralMetadata) {
    if (channel === "pid") {
      return { _pid: partId, pid: partId };
    }
    return null;
  }

  try {
    const cacheKey = `${propertyTableIndex}-${partId}`;
    let data;
    let cache = mesh.userData["_propertyCache"] as Map<
      string,
      Record<string, unknown>
    >;
    if (!cache) {
      cache = new Map();
      mesh.userData["_propertyCache"] = cache;
    }

    if (cache.has(cacheKey)) {
      data = cache.get(cacheKey)!;
    } else {
      data = structuralMetadata.getPropertyTableData(
        propertyTableIndex,
        fid,
      ) as Record<string, unknown>;
      cache.set(cacheKey, data);
    }
    return channel === "oid" && internalData
      ? internalData(partId, data)
      : data;
  } catch {
    return channel === "pid" ? { _pid: partId, pid: partId } : null;
  }
}

export function getPropertyDataMapFromTilesByFeatureAttribute(
  tiles: TilesRenderer,
  featureIdAttribute: number,
  internalData?: InternalData,
): Map<number, Record<string, unknown> | null> {
  const channel = featureIdAttributeToChannel(featureIdAttribute);
  if (channel === "pid") return getPropertyDataMapFromTilesByPid(tiles);
  return getPropertyDataMapFromTiles(tiles, internalData);
}
