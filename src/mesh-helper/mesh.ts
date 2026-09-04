import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  InstancedMesh,
  Material,
  Mesh,
  Object3D,
  Texture,
  Vector3,
} from "three";

import { TilesRenderer } from "3d-tiles-renderer";

import type { InstanceFeatures } from "../mesh/types";
import { measureInstanceSplitForTile } from "./instance-split";
import { disposeSplitInstancedMeshResources } from "./instance-split";

import {
  createIndexArray,
  type FeatureIdIndexData,
  type IndexRange,
} from "./feature-id-index";
import {
  cropPrecomputedEdgesForFids,
  getPrecomputedEdges,
  registerPrecomputedEdges,
} from "./edge-geometry";

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
  targetFids: Set<number>;
  sourceIndex: ArrayLike<number>;
  indexCache: FeatureIdIndexData;
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

  let totalIndexLength = 0;
  for (const fid of targetFids) {
    const entry = featureIdIndexMap[fid];
    if (entry) totalIndexLength += entry.length;
  }
  if (totalIndexLength === 0) return null;

  return {
    geometry,
    featureIdAttr,
    targetFids,
    sourceIndex,
    indexCache,
    totalIndexLength,
  };
}

function computeLocalBBoxForFeatureIdSubset(
  geometry: BufferGeometry,
  indexCache: FeatureIdIndexData,
  targetFids: Set<number>,
): Box3 | null {
  const posAttr = geometry.getAttribute("position");
  if (!posAttr) return null;

  const positions = posAttr.array as Float32Array;
  const itemSize = posAttr.itemSize || 3;
  const { featureIdIndexMap, buffer } = indexCache;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const fid of targetFids) {
    const entry = featureIdIndexMap[fid];
    if (!entry) continue;
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
    targetFids,
    sourceIndex,
    indexCache,
    totalIndexLength,
  } = context;
  const { featureIdIndexMap, buffer } = indexCache;

  const newGeometry = new BufferGeometry();
  const attributes = originalGeometry.attributes;
  for (const attributeName in attributes) {
    newGeometry.setAttribute(attributeName, attributes[attributeName]);
  }

  const newIndices = createIndexArray(sourceIndex, totalIndexLength);
  let writeOffset = 0;
  for (const fid of targetFids) {
    const entry = featureIdIndexMap[fid];
    if (!entry) continue;
    newIndices.set(
      buffer.subarray(entry.offset, entry.offset + entry.length),
      writeOffset,
    );
    writeOffset += entry.length;
  }
  newGeometry.setIndex(new BufferAttribute(newIndices, 1));

  const sourceEdges = getPrecomputedEdges(originalGeometry);
  if (sourceEdges) {
    if (sourceEdges.triangleIndices.length === 0) {
      registerPrecomputedEdges(newGeometry, sourceEdges);
    } else if (indexCache.triangleIndexMap && indexCache.triangleIndices) {
      const cropped = cropPrecomputedEdgesForFids(
        sourceEdges,
        indexCache.triangleIndexMap,
        indexCache.triangleIndices,
        targetFids,
      );
      if (cropped) {
        registerPrecomputedEdges(newGeometry, {
          positions: cropped,
          triangleIndices: new Uint32Array(0),
          thresholdAngleDeg: sourceEdges.thresholdAngleDeg,
        });
      }
    }
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

function splitBBoxVolume(box: Box3): number {
  const sx = Math.max(0, box.max.x - box.min.x);
  const sy = Math.max(0, box.max.y - box.min.y);
  const sz = Math.max(0, box.max.z - box.min.z);
  return sx * sy * sz;
}

function splitBBoxIoU(a: Box3, b: Box3): number {
  const intersection = new Box3().copy(a).intersect(b);
  if (intersection.isEmpty()) return 0;
  const iVol = splitBBoxVolume(intersection);
  const union = splitBBoxVolume(a) + splitBBoxVolume(b) - iVol;
  return union > 0 ? iVol / union : 0;
}

/** 两瓦片 split 几何在世界空间是否属于同一构件的 LOD 重叠（而非空间互补分片） */
function tilesShareLodOverlap(a: Box3, b: Box3): boolean {
  if (splitBBoxContains(a, b) || splitBBoxContains(b, a)) return true;
  return splitBBoxIoU(a, b) >= 0.45;
}

function splitBBoxContains(outer: Box3, inner: Box3, eps = 1e-4): boolean {
  return (
    outer.min.x <= inner.min.x + eps &&
    outer.min.y <= inner.min.y + eps &&
    outer.min.z <= inner.min.z + eps &&
    outer.max.x >= inner.max.x - eps &&
    outer.max.y >= inner.max.y - eps &&
    outer.max.z >= inner.max.z - eps
  );
}

function worldSplitBBox(tileMesh: Mesh, localBBox: Box3): Box3 {
  tileMesh.updateWorldMatrix(true, false);
  return localBBox.clone().applyMatrix4(tileMesh.matrixWorld);
}

function measureSplitGeometryForTile(
  tileMesh: Mesh,
  idSet: ReadonlySet<number>,
  channel: PartIdChannel,
): { triCount: number; bbox: Box3 } | null {
  const context = resolveMergedSplitContext(tileMesh, idSet, channel);
  if (!context) return null;

  const triCount = context.totalIndexLength / 3;
  if (triCount === 0) return null;

  const local = computeLocalBBoxForFeatureIdSubset(
    context.geometry,
    context.indexCache,
    context.targetFids,
  );
  if (!local) return null;

  return { triCount, bbox: worldSplitBBox(tileMesh, local) };
}

/**
 * 同一 OID 在父子 LOD 瓦片上常会同时存在。
 * - IoU 高 / bbox 包含 → 视为 LOD 重叠，只保留三角更多的瓦片（避免重复高亮与错位叠加）。
 * - IoU 低 → 视为互补分片（如各带一半轮胎），全部保留。
 */
function selectDominantTileMeshesForIdSet(
  candidateTiles: Iterable<Mesh>,
  idSet: ReadonlySet<number>,
  channel: PartIdChannel,
): Mesh[] {
  type TileEntry = {
    mesh: Mesh;
    triCount: number;
    ids: Set<number>;
    bbox: Box3;
  };
  const entries: TileEntry[] = [];

  for (const tileMesh of candidateTiles) {
    const idMap = getPartIdMap(tileMesh, channel);
    if (!idMap) continue;

    const idsOnMesh = new Set<number>();
    for (const partId of idSet) {
      if (idMap[partId] !== undefined) idsOnMesh.add(partId);
    }
    if (idsOnMesh.size === 0) continue;

    let measured: { size: number; bbox: Box3 } | null = null;
    if (tileMesh instanceof InstancedMesh && isTileInstancedMesh(tileMesh)) {
      const featureIdAttribute = channel === "pid" ? 1 : 0;
      const instanced = measureInstanceSplitForTile(
        tileMesh,
        idSet,
        featureIdAttribute,
      );
      if (instanced) {
        measured = {
          size: instanced.instanceCount,
          bbox: instanced.bbox,
        };
      }
    } else {
      const splitMeasured = measureSplitGeometryForTile(
        tileMesh,
        idSet,
        channel,
      );
      if (splitMeasured) {
        measured = {
          size: splitMeasured.triCount,
          bbox: splitMeasured.bbox,
        };
      }
    }
    if (!measured) continue;

    entries.push({
      mesh: tileMesh,
      triCount: measured.size,
      ids: idsOnMesh,
      bbox: measured.bbox,
    });
  }

  entries.sort((a, b) => b.triCount - a.triCount);

  const selected: TileEntry[] = [];
  for (const entry of entries) {
    let dominated = false;
    for (let i = selected.length - 1; i >= 0; i--) {
      const kept = selected[i]!;
      const sharesId = [...entry.ids].some((id) => kept.ids.has(id));
      if (!sharesId) continue;
      if (!tilesShareLodOverlap(kept.bbox, entry.bbox)) continue;

      if (entry.triCount > kept.triCount) {
        selected.splice(i, 1);
      } else {
        dominated = true;
      }
    }
    if (!dominated) selected.push(entry);
  }

  return selected.map((e) => e.mesh);
}

export function selectDominantTileMeshesForOidSet(
  candidateTiles: Iterable<Mesh>,
  oidSet: ReadonlySet<number>,
): Mesh[] {
  return selectDominantTileMeshesForIdSet(candidateTiles, oidSet, "oid");
}

export function selectDominantTileMeshesForPidSet(
  candidateTiles: Iterable<Mesh>,
  pidSet: ReadonlySet<number>,
): Mesh[] {
  return selectDominantTileMeshesForIdSet(candidateTiles, pidSet, "pid");
}

/**
 * 由已构建的 split 几何创建 Mesh（独立材质）；可选标记由全局几何缓存托管，dispose 时不释放几何缓冲。
 */
function createMergedSplitMeshFromGeometryByChannel(
  originalMesh: Mesh,
  newGeometry: BufferGeometry,
  idSet: ReadonlySet<number>,
  channel: PartIdChannel,
  options?: { splitGeometryManagedByCache?: boolean },
): Mesh | null {
  if (idSet.size === 0) return null;

  const cfg = PART_ID_CHANNEL_CONFIG[channel];
  const idMap = getPartIdMap(originalMesh, channel);
  if (!idMap) return null;

  const resolved = resolveFeatureChannelOnMesh(originalMesh, channel);
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

  const newMaterial = (originalMesh.material as Material).clone();
  const newMesh = new Mesh(newGeometry, newMaterial);
  originalMesh.updateWorldMatrix(true, false);
  newMesh.position.copy(originalMesh.position);
  newMesh.rotation.copy(originalMesh.rotation);
  newMesh.scale.copy(originalMesh.scale);

  const { structuralMetadata } = originalMesh.userData;
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
    ...originalMesh.userData,
    featureId: idMap[primaryId],
    [cfg.idKey]: primaryId,
    [cfg.collectorKey]: idsOnMesh,
    _originalMesh: originalMesh,
    propertyData,
    _isSplit: true,
    isMergedSplit: true,
    partIdChannel: channel,
  };
  if (options?.splitGeometryManagedByCache) {
    userData.splitGeometryManagedByCache = true;
  }
  newMesh.userData = userData;

  newMesh.name = `${cfg.namePrefix}_${idsOnMesh.length}_${primaryId}`;
  return newMesh;
}

export function createMergedSplitMeshFromGeometry(
  originalMesh: Mesh,
  newGeometry: BufferGeometry,
  oidSet: ReadonlySet<number>,
  options?: { splitGeometryManagedByCache?: boolean },
): Mesh | null {
  return createMergedSplitMeshFromGeometryByChannel(
    originalMesh,
    newGeometry,
    oidSet,
    "oid",
    options,
  );
}

export function createMergedSplitMeshFromGeometryByPids(
  originalMesh: Mesh,
  newGeometry: BufferGeometry,
  pidSet: ReadonlySet<number>,
  options?: { splitGeometryManagedByCache?: boolean },
): Mesh | null {
  return createMergedSplitMeshFromGeometryByChannel(
    originalMesh,
    newGeometry,
    pidSet,
    "pid",
    options,
  );
}

/**
 * 将同一瓦片 mesh 内、属于给定 OID 集合的所有 feature 合并为 **单个** Mesh（每瓦片最多一个）
 */
export function splitMeshByOidsMerged(
  originalMesh: Mesh,
  oidSet: ReadonlySet<number>,
): Mesh | null {
  const geom = buildMergedSplitGeometryForTileMesh(originalMesh, oidSet);
  if (!geom) return null;
  return createMergedSplitMeshFromGeometry(originalMesh, geom, oidSet);
}

/** 将同一瓦片 mesh 内、属于给定 PID 集合的所有 feature 合并为单个 Mesh */
export function splitMeshByPidsMerged(
  originalMesh: Mesh,
  pidSet: ReadonlySet<number>,
): Mesh | null {
  const geom = buildMergedSplitGeometryForTileMeshByPids(originalMesh, pidSet);
  if (!geom) return null;
  return createMergedSplitMeshFromGeometryByPids(originalMesh, geom, pidSet);
}

/** 与贴图/环境等相关的材质字段（与瓦片共用同一引用时不能 dispose 材质） */
const TEXTURE_LIKE_MATERIAL_KEYS: readonly string[] = [
  "map",
  "lightMap",
  "bumpMap",
  "normalMap",
  "specularMap",
  "envMap",
  "alphaMap",
  "aoMap",
  "displacementMap",
  "emissiveMap",
  "gradientMap",
  "metalnessMap",
  "roughnessMap",
  "clearcoatNormalMap",
  "transmissionMap",
  "thicknessMap",
  "sheenColorMap",
  "specularIntensityMap",
  "anisotropyMap",
  "iridescenceMap",
  "iridescenceThicknessMap",
];

function getMeshMaterials(mesh: Mesh | undefined): Material[] {
  if (!mesh?.material) return [];
  const m = mesh.material;
  return Array.isArray(m) ? m : [m];
}

/**
 * 释放 clone 材质：与瓦片同引用的贴图只 detach，不 dispose；否则 dispose 贴图。
 * 最后 `material.dispose()` 释放着色器程序等；共享贴图已置空，避免误伤瓦片。
 */
function disposeSplitMaterialVsTile(
  mat: Material,
  tileMat: Material | undefined,
): void {
  const ra = mat as unknown as Record<string, unknown>;
  const rb = (tileMat ?? null) as unknown as Record<string, unknown> | null;

  for (const key of TEXTURE_LIKE_MATERIAL_KEYS) {
    const va = ra[key];
    if (va == null) continue;
    const vb = rb?.[key];
    const shared = vb != null && va === vb;
    if (shared) {
      ra[key] = null;
    } else {
      (va as Texture).dispose();
      ra[key] = null;
    }
  }
  mat.dispose();
}

/**
 * 释放 tileMesh.userData 上缓存的合并 split BufferGeometry。
 * 合并几何与瓦片共享顶点属性引用；直接 `dispose()` 会从 WebGL 移除共享 BufferAttribute，瓦片会发瘪/缺面。
 * 需先从合并几何上 deleteAttribute 摘掉共享引用，再 dispose（仅清独立 index 与 dispose 事件）。
 */
export function disposeMergedSplitGeometryCacheEntry(
  mergedGeom: BufferGeometry,
  tileMesh: Mesh,
): void {
  const tileGeom = tileMesh.geometry;
  if (!tileGeom) {
    mergedGeom.dispose();
    return;
  }
  for (const name of Object.keys(mergedGeom.attributes)) {
    if (mergedGeom.getAttribute(name) === tileGeom.getAttribute(name)) {
      mergedGeom.deleteAttribute(name);
    }
  }
  if (mergedGeom.index && mergedGeom.index === tileGeom.index) {
    mergedGeom.setIndex(null);
  }
  mergedGeom.dispose();
}

/**
 * 仅释放不与瓦片 `geometry` 共享的 index / attributes。
 */
export function disposeSplitGeometry(mesh: Mesh): void {
  const geom = mesh.geometry;
  if (!geom) return;

  const tileGeom = mesh.userData?._originalMesh?.geometry as
    | BufferGeometry
    | undefined;
  const idx = geom.index;
  if (idx && idx !== tileGeom?.index) {
    idx.dispose();
    geom.setIndex(null);
  }

  if (!tileGeom) return;
  for (const name of Object.keys(geom.attributes)) {
    const attr = geom.attributes[name];
    if (!attr || attr === tileGeom.getAttribute(name)) continue;
    geom.deleteAttribute(name);
    if (attr instanceof BufferAttribute) attr.dispose();
  }
}

/**
 * 释放 {@link splitMeshByOidsMerged} 生成 mesh 的独占资源。
 * - 材质：clone 与瓦片逐贴图比对引用；非共享贴图 dispose，共享贴图先 detach 再 `material.dispose()`，避免误伤瓦片。
 * - 几何：见 {@link disposeSplitGeometry}。
 * - **不要**对 `THREE.Mesh` 调用 `dispose()`：核心库中 `Mesh` 无此方法。
 */
export function disposeMergedSplitMeshResources(mesh: Mesh): void {
  const builtKey = "_gltfParserStyleAppearanceBuilt";
  const built = mesh.userData?.[builtKey] as Object3D | undefined;
  if (built) {
    built.removeFromParent();
    delete mesh.userData[builtKey];
  }
  mesh.removeFromParent();

  const tileMesh = mesh.userData?._originalMesh as Mesh | undefined;
  const tileMats = getMeshMaterials(tileMesh);

  const mats = mesh.material;
  const list = Array.isArray(mats) ? mats : [mats];

  for (let i = 0; i < list.length; i++) {
    const mat = list[i];
    if (!mat) continue;
    const tileMat = tileMats[i] ?? tileMats[0];
    disposeSplitMaterialVsTile(mat, tileMat);
  }

  disposeSplitGeometry(mesh);
}

/** 释放样式/高亮产生的 split mesh 或 instanced split */
export function disposeStyledMeshResources(mesh: Mesh): void {
  if (mesh.userData?.isInstancedSplit) {
    disposeSplitInstancedMeshResources(mesh);
    return;
  }
  disposeMergedSplitMeshResources(mesh);
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
 * 遍历当前已加载的瓦片 feature mesh（tiles.group + 各 tile.engineData.scene，按 uuid 去重）。
 * 新瓦片在挂到 group 前只存在于 tile scene，样式/高亮/显隐须走此入口。
 */
export function forEachLoadedFeatureMesh(
  tiles: TilesRenderer,
  fn: (mesh: Mesh) => void,
): void {
  forEachLoadedFeatureSource(tiles, (source) => {
    if (isTileMesh(source)) fn(source);
  });
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
 * 从瓦片中获取所有 OID
 */
export function getAllOidsFromTiles(tiles: TilesRenderer): number[] {
  const oidSet = new Set<number>();

  forEachLoadedFeatureSource(tiles, (source) => {
    for (const oid of collectPartIdsFromSourceUserData(source.userData, 0)) {
      oidSet.add(oid);
    }
  });

  return Array.from(oidSet);
}

/**
 * 从瓦片中获取所有 PID（featureIds[1]）
 */
export function getAllPidsFromTiles(tiles: TilesRenderer): number[] {
  const pidSet = new Set<number>();

  forEachLoadedFeatureSource(tiles, (source) => {
    for (const pid of collectPartIdsFromSourceUserData(source.userData, 1)) {
      pidSet.add(pid);
    }
  });

  return Array.from(pidSet);
}

/**
 * 根据 OID 获取属性数据（从瓦片 structuralMetadata）
 */
export function getPropertyDataByOid(
  tiles: TilesRenderer,
  oid: number,
  internalData?: InternalData,
): Record<string, unknown> | null {
  let result: Record<string, unknown> | null = null;

  forEachLoadedFeatureSource(tiles, (source) => {
    if (result) return;
    result = getPropertyDataFromUserData(source.userData, oid, 0, internalData);
  });

  return result;
}

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
 * 根据OID获取包含该OID的瓦片mesh
 */
export function getTileMeshesByOid(tiles: TilesRenderer, oid: number): Mesh[] {
  const tileMeshes: Mesh[] = [];

  forEachLoadedFeatureSource(tiles, (source) => {
    if (checkMeshContainsOid(source, oid)) {
      tileMeshes.push(source);
    }
  });

  return tileMeshes;
}

/**
 * 根据 PID 获取包含该 PID 的瓦片 mesh
 */
export function getTileMeshesByPid(tiles: TilesRenderer, pid: number): Mesh[] {
  const tileMeshes: Mesh[] = [];

  forEachLoadedFeatureSource(tiles, (source) => {
    if (checkMeshContainsPid(source, pid)) {
      tileMeshes.push(source);
    }
  });

  return tileMeshes;
}

/**
 * 根据 PID 获取属性数据（从瓦片 structuralMetadata，featureIds[1]）
 */
export function getPropertyDataByPid(
  tiles: TilesRenderer,
  pid: number,
): Record<string, unknown> | null {
  let result: Record<string, unknown> | null = null;

  forEachLoadedFeatureSource(tiles, (source) => {
    if (result) return;
    result = getPropertyDataFromUserData(source.userData, pid, 1);
  });

  return result;
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

function checkMeshContainsPartId(
  mesh: Mesh,
  partId: number,
  channel: PartIdChannel,
): boolean {
  const idMap = getPartIdMap(mesh, channel);
  if (!idMap) return false;
  return idMap[partId] !== undefined;
}

function checkMeshContainsOid(mesh: Mesh, oid: number): boolean {
  return checkMeshContainsPartId(mesh, oid, "oid");
}

function checkMeshContainsPid(mesh: Mesh, pid: number): boolean {
  return checkMeshContainsPartId(mesh, pid, "pid");
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
    const data = structuralMetadata.getPropertyTableData(
      propertyTableIndex,
      fid,
    ) as Record<string, unknown>;
    return channel === "oid" && internalData
      ? internalData(partId, data)
      : data;
  } catch {
    return channel === "pid" ? { _pid: partId, pid: partId } : null;
  }
}

export function getAllFeatureIdsFromTiles(
  tiles: TilesRenderer,
  featureIdAttribute: number,
): number[] {
  const channel = featureIdAttributeToChannel(featureIdAttribute);
  return channel === "pid"
    ? getAllPidsFromTiles(tiles)
    : getAllOidsFromTiles(tiles);
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

export function getPropertyDataByFeatureAttribute(
  tiles: TilesRenderer,
  featureId: number,
  featureIdAttribute: number,
  internalData?: InternalData,
): Record<string, unknown> | null {
  const channel = featureIdAttributeToChannel(featureIdAttribute);
  return channel === "pid"
    ? getPropertyDataByPid(tiles, featureId)
    : getPropertyDataByOid(tiles, featureId, internalData);
}

export function getTileMeshesByFeatureAttribute(
  tiles: TilesRenderer,
  featureId: number,
  featureIdAttribute: number,
): Mesh[] {
  const channel = featureIdAttributeToChannel(featureIdAttribute);
  return channel === "pid"
    ? getTileMeshesByPid(tiles, featureId)
    : getTileMeshesByOid(tiles, featureId);
}
