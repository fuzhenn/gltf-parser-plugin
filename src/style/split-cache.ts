import { BufferAttribute } from "three";
import type { BufferGeometry, Mesh } from "three";

type SplitMeshCache = Map<string, Mesh>;
type MatchedFeatureIdsCache = Map<string, Set<number>>;

/** 挂在 tileMesh.userData 上，按 condition key 缓存 split mesh */
const SPLIT_MESHES_CACHE_KEY = "_splitMeshesCache";
/** 挂在 tileMesh.userData 上，按 condition key 缓存命中的 partId 集合 */
const MATCHED_FEATURE_IDS_CACHE_KEY = "_matchedFeatureIdsCache";

type SplitMeshGroupCache = Map<string, Mesh[]>;
/** 挂在 tileMesh.userData 上，按组 key 缓存 split mesh 数组（组内按条件位置下标存放） */
const SPLIT_MESH_GROUPS_CACHE_KEY = "_splitMeshGroupsCache";

type SplitGroupGeometryCache = Map<string, BufferGeometry>;
/** 挂在 tileMesh.userData 上，按组 key 缓存组内共享的 split 合并几何 */
const SPLIT_GROUP_GEOMETRIES_CACHE_KEY = "_splitGroupGeometriesCache";

/** 冻结幽灵体在 split 缓存中的保留 key 前缀，按条件区分（buildSplitCacheKey 输出恒以 f+数字开头，不会撞） */
export const FROZEN_SPLIT_KEY_PREFIX = "_frozen";

/** 懒初始化地取挂载在 mesh.userData 上的缓存 Map */
function getCacheMap<K, V>(mesh: Mesh, mapKey: string): Map<K, V> {
  let map = mesh.userData[mapKey] as Map<K, V> | undefined;
  if (!map) {
    map = new Map();
    mesh.userData[mapKey] = map;
  }
  return map;
}

/** 懒初始化地取挂载在 mesh.userData 上的缓存 Map（仅冻结写入路径使用） */
function getSplitMeshesCache(tileMesh: Mesh): SplitMeshCache {
  return getCacheMap(tileMesh, SPLIT_MESHES_CACHE_KEY);
}

export function getMatchedFeatureIdsCache(
  tileMesh: Mesh,
): MatchedFeatureIdsCache {
  return getCacheMap(tileMesh, MATCHED_FEATURE_IDS_CACHE_KEY);
}

export function setCachedSplitMeshOnTileMesh(
  tileMesh: Mesh,
  cacheKey: string,
  splitMesh: Mesh,
): void {
  getSplitMeshesCache(tileMesh).set(cacheKey, splitMesh);
}

export function getCachedMatchedFeatureIds(
  tileMesh: Mesh,
  cacheKey: string,
): Set<number> | null {
  return getMatchedFeatureIdsCache(tileMesh).get(cacheKey) ?? null;
}

export function setCachedMatchedFeatureIds(
  tileMesh: Mesh,
  cacheKey: string,
  featureIds: Set<number>,
): void {
  getMatchedFeatureIdsCache(tileMesh).set(cacheKey, new Set(featureIds));
}

/** 删除缓存条目；Map 清空后顺手从 userData 摘除 */
function removeCacheEntry(
  tileMesh: Mesh,
  cacheKey: string,
  mapKey: string,
): void {
  const map = tileMesh.userData[mapKey] as Map<string, unknown> | undefined;
  if (!map) return;
  map.delete(cacheKey);
  if (map.size === 0) {
    delete tileMesh.userData[mapKey];
  }
}

export function removeMatchedFeatureIdsCache(
  tileMesh: Mesh,
  cacheKey: string,
): void {
  removeCacheEntry(tileMesh, cacheKey, MATCHED_FEATURE_IDS_CACHE_KEY);
}

/** 读取某组的 split mesh 数组（只读，不存在返回 undefined） */
export function getSplitMeshGroup(
  tileMesh: Mesh,
  groupKey: string,
): Mesh[] | undefined {
  const map = tileMesh.userData[SPLIT_MESH_GROUPS_CACHE_KEY] as
    | SplitMeshGroupCache
    | undefined;
  return map?.get(groupKey);
}

/** 取（懒创建）某组的 split mesh 数组，组内按条件位置下标存放 */
export function getOrCreateSplitMeshGroup(
  tileMesh: Mesh,
  groupKey: string,
): Mesh[] {
  let map = tileMesh.userData[SPLIT_MESH_GROUPS_CACHE_KEY] as
    | SplitMeshGroupCache
    | undefined;
  if (!map) {
    map = new Map();
    tileMesh.userData[SPLIT_MESH_GROUPS_CACHE_KEY] = map;
  }
  let group = map.get(groupKey);
  if (!group) {
    group = [];
    map.set(groupKey, group);
  }
  return group;
}

/** 删除某组的 split mesh 缓存条目（摘缓存记录 + 释放组共享几何；mesh 释放归调用方） */
export function removeSplitMeshGroup(
  tileMesh: Mesh,
  groupKey: string,
): void {
  releaseSharedSplitGeometry(tileMesh, groupKey);
  removeCacheEntry(tileMesh, groupKey, SPLIT_MESH_GROUPS_CACHE_KEY);
}

export function getSharedSplitGeometry(
  tileMesh: Mesh,
  groupKey: string,
): BufferGeometry | undefined {
  return (
    tileMesh.userData[SPLIT_GROUP_GEOMETRIES_CACHE_KEY] as
      | SplitGroupGeometryCache
      | undefined
  )?.get(groupKey);
}

export function setSharedSplitGeometry(
  tileMesh: Mesh,
  groupKey: string,
  geometry: BufferGeometry,
): void {
  let map = tileMesh.userData[SPLIT_GROUP_GEOMETRIES_CACHE_KEY] as
    | SplitGroupGeometryCache
    | undefined;
  if (!map) {
    map = new Map();
    tileMesh.userData[SPLIT_GROUP_GEOMETRIES_CACHE_KEY] = map;
  }
  map.set(groupKey, geometry);
}

/** 释放并摘除组共享几何（组销毁，或工厂替换几何导致共享退化时调用） */
export function releaseSharedSplitGeometry(
  tileMesh: Mesh,
  groupKey: string,
): void {
  const map = tileMesh.userData[SPLIT_GROUP_GEOMETRIES_CACHE_KEY] as
    | SplitGroupGeometryCache
    | undefined;
  if (!map) return;
  const geometry = map.get(groupKey);
  if (geometry) {
    disposeUnsharedGeometryResources(
      geometry,
      tileMesh.geometry as BufferGeometry | undefined,
    );
    map.delete(groupKey);
  }
  if (map.size === 0) {
    delete tileMesh.userData[SPLIT_GROUP_GEOMETRIES_CACHE_KEY];
  }
}

export function attachSplitMeshToTileMeshParent(
  tileMesh: Mesh,
  splitMesh: Mesh,
): void {
  splitMesh.frustumCulled = tileMesh.frustumCulled;
  splitMesh.layers.mask = tileMesh.layers.mask;
  tileMesh.parent?.add(splitMesh);
}

/**
 * 释放合并 split geometry 独有（非共享）的 GPU 资源：逐项对照瓦片几何，
 * 与瓦片共享的 index / attributes 不动，独有的才 dispose（顶点属性与瓦片
 * 全量共享，整块 geometry.dispose() 会连带释放瓦片属性的 GPU buffer，
 * 迫使瓦片重新上传）。
 */
export function disposeUnsharedGeometryResources(
  geometry: BufferGeometry,
  tileGeom?: BufferGeometry,
): void {
  const idx = geometry.index;
  if (idx && idx !== tileGeom?.index) {
    idx.dispose();
    geometry.setIndex(null);
  }

  if (!tileGeom) return;
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.attributes[name];
    if (!attr || attr === tileGeom.getAttribute(name)) continue;
    geometry.deleteAttribute(name);
    if (attr instanceof BufferAttribute) attr.dispose();
  }
}

export function disposeSplitGeometry(mesh: Mesh): void {
  const geom = mesh.geometry;
  if (!geom) return;

  const tileGeom = mesh.userData?._originalMesh?.geometry as
    | BufferGeometry
    | undefined;
  disposeUnsharedGeometryResources(geom, tileGeom);
}

/** 按前缀清扫 split 缓存条目（摘 mesh + 释放几何），供冻结整组替换与 collector 整组释放复用 */
export function releaseSplitMeshCachesByPrefix(
  tileMesh: Mesh,
  prefix: string,
): void {
  const map = tileMesh.userData[SPLIT_MESHES_CACHE_KEY] as
    | SplitMeshCache
    | undefined;
  if (!map) return;
  for (const key of [...map.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const splitMesh = map.get(key)!;
    splitMesh.removeFromParent();
    disposeSplitGeometry(splitMesh);
    map.delete(key);
  }
  if (map.size === 0) {
    delete tileMesh.userData[SPLIT_MESHES_CACHE_KEY];
  }
}

/** 清扫 tile mesh 上所有以 prefix 开头的冻结 split 缓存（摘 mesh + 释放几何），用于冻结条件数组整体替换 */
export function releaseFrozenSplitCaches(
  tileMesh: Mesh,
  prefix: string,
): void {
  releaseSplitMeshCachesByPrefix(tileMesh, prefix);
}
