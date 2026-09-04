import { Material, Mesh, Object3D } from "three";
import {
  resolveStyleConditionContent,
  resolveStyleConditionFeatureIdAttribute,
  type StyleCondition,
  type StyleAppearance,
  type StyleConditionInput,
} from "../appearance";
import {
  disposeSplitGeometry,
  isTileInstancedMesh,
  isTileMesh,
} from "../mesh-helper";

type SplitMeshCache = Map<string, Mesh>;
type MatchedFeatureIdsCache = Map<string, Set<number>>;

/** 挂在 tileMesh.userData 上，按 condition key 缓存 split mesh */
const SPLIT_MESHES_CACHE_KEY = "_splitMeshesCache";
/** 挂在 tileMesh.userData 上，按 condition key 缓存命中的 partId 集合 */
const MATCHED_FEATURE_IDS_CACHE_KEY = "_matchedFeatureIdsCache";

export function buildMatchCacheKey(input: StyleConditionInput): string {
  const featureIdAttribute = resolveStyleConditionFeatureIdAttribute(input);
  const content = resolveStyleConditionContent(input);
  const condPart =
    typeof content === "string" ? content.trim() : String(content);
  return `f${featureIdAttribute}:${condPart}`;
}

export function buildAppearanceCacheKey(appearance?: StyleAppearance): string {
  if (!appearance) return "";
  const { material, color, opacity } = appearance;
  const matKey =
    material instanceof Material
      ? material.uuid
      : typeof material === "function"
        ? "fn"
        : "";
  return `m${matKey}:c${color ?? ""}:o${opacity ?? ""}`;
}

export function buildSplitCacheKey(condition: StyleCondition): string {
  const [input, appearance] = condition;
  return `${buildMatchCacheKey(input)}|${buildAppearanceCacheKey(appearance)}`;
}

export function getSplitMeshesCache(tileMesh: Mesh): SplitMeshCache {
  const userData = tileMesh.userData;
  let map = userData[SPLIT_MESHES_CACHE_KEY];
  if (!map) {
    map = new Map();
    userData[SPLIT_MESHES_CACHE_KEY] = map;
  }
  return map;
}

export function getMatchedFeatureIdsCache(
  tileMesh: Mesh,
): MatchedFeatureIdsCache {
  const userData = tileMesh.userData;
  let map = userData[MATCHED_FEATURE_IDS_CACHE_KEY];
  if (!map) {
    map = new Map();
    userData[MATCHED_FEATURE_IDS_CACHE_KEY] = map;
  }
  return map;
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
  const cache = getMatchedFeatureIdsCache(tileMesh);
  if (!cache.has(cacheKey)) return null;
  return cache.get(cacheKey)!;
}

export function setCachedMatchedFeatureIds(
  tileMesh: Mesh,
  cacheKey: string,
  featureIds: Set<number>,
): void {
  getMatchedFeatureIdsCache(tileMesh).set(cacheKey, new Set(featureIds));
}

export function removeSplitMeshCache(tileMesh: Mesh, cacheKey: string): void {
  const map = tileMesh.userData[SPLIT_MESHES_CACHE_KEY] as
    | SplitMeshCache
    | undefined;
  if (!map) return;
  map.delete(cacheKey);
  if (map.size === 0) {
    delete tileMesh.userData[SPLIT_MESHES_CACHE_KEY];
  }
}

export function removeMatchedFeatureIdsCache(
  tileMesh: Mesh,
  cacheKey: string,
): void {
  const map = tileMesh.userData[MATCHED_FEATURE_IDS_CACHE_KEY];
  if (!map) return;
  map.delete(cacheKey);
  if (map.size === 0) {
    delete tileMesh.userData[MATCHED_FEATURE_IDS_CACHE_KEY];
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

export function collectTileMeshesFromScene(scene: Object3D): Mesh[] {
  const tileMeshes: Mesh[] = [];
  scene.traverse((child) => {
    if (isTileMesh(child) || isTileInstancedMesh(child)) {
      tileMeshes.push(child as Mesh);
    }
  });
  return tileMeshes;
}
