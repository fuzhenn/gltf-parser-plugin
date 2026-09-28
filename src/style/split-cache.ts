import { BufferAttribute } from "three";
import type { BufferGeometry, Mesh } from "three";

type SplitMeshCache = Map<string, Mesh>;
type MatchedFeatureIdsCache = Map<string, Set<number>>;

/** 挂在 tileMesh.userData 上，按 condition key 缓存 split mesh */
const SPLIT_MESHES_CACHE_KEY = "_splitMeshesCache";
/** 挂在 tileMesh.userData 上，按 condition key 缓存命中的 partId 集合 */
const MATCHED_FEATURE_IDS_CACHE_KEY = "_matchedFeatureIdsCache";

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

export function getSplitMeshesCache(tileMesh: Mesh): SplitMeshCache {
  return getCacheMap(tileMesh, SPLIT_MESHES_CACHE_KEY);
}

export function getMatchedFeatureIdsCache(
  tileMesh: Mesh,
): MatchedFeatureIdsCache {
  return getCacheMap(tileMesh, MATCHED_FEATURE_IDS_CACHE_KEY);
}

export function getCachedSplitMeshFromTileMesh(
  tileMesh: Mesh,
  cacheKey: string,
): Mesh | null {
  return getSplitMeshesCache(tileMesh).get(cacheKey) ?? null;
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

export function removeSplitMeshCache(tileMesh: Mesh, cacheKey: string): void {
  removeCacheEntry(tileMesh, cacheKey, SPLIT_MESHES_CACHE_KEY);
}

export function removeMatchedFeatureIdsCache(
  tileMesh: Mesh,
  cacheKey: string,
): void {
  removeCacheEntry(tileMesh, cacheKey, MATCHED_FEATURE_IDS_CACHE_KEY);
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

export function releaseConditionCache(
  tileMesh: Mesh,
  matchKey: string,
  splitKey: string,
): void {
  const splitMesh = getCachedSplitMeshFromTileMesh(tileMesh, splitKey);
  if (splitMesh) {
    splitMesh.removeFromParent();
    disposeSplitGeometry(splitMesh);
  }
  removeSplitMeshCache(tileMesh, splitKey);
  removeMatchedFeatureIdsCache(tileMesh, matchKey);
}

/** 清扫 tile mesh 上所有以 prefix 开头的冻结 split 缓存（摘 mesh + 释放几何），用于冻结条件数组整体替换 */
export function releaseFrozenSplitCaches(
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
