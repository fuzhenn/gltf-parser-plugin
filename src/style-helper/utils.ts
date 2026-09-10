import {
  BufferGeometry,
  Euler,
  Material,
  Mesh,
  Object3D,
  Vector3,
} from "three";
import {
  resolveStyleConditionContent,
  resolveStyleConditionFeatureIdAttribute,
  type StyleCondition,
  type StyleAppearance,
  type StyleConditionInput,
} from "../appearance";
import {
  applyEuler,
  applyVec3,
  buildPivotStyleMatrix,
  resolveStyleMaterial,
} from "../plugin/style-appearance-shared";
import type { MaterialBuilder } from "../types";
import { defaultMaterialBuilder } from "../utils/build-materials";
import {
  disposeMergedSplitGeometryCacheEntry,
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

/**
 * 把完整的 {@link StyleAppearance} 应用到 split mesh（由 MeshCollector 在创建
 * split mesh 后一次性调用；split mesh 走缓存复用，不存在重复叠加变换的问题）。
 *
 * - material / color / opacity：经 {@link resolveStyleMaterial} 解析终态材质，
 *   与 highlight 等系统共享底层材质缓存；
 * - mesh 工厂：按 {@link StyleMeshFactory} 约定把返回 Mesh 的 geometry / material
 *   写回当前 split mesh（uuid 不变），被替换的原 split geometry 随之释放；
 * - translation / scale / rotation / origin：split mesh 创建后 TRS 为初始态，
 *   按 origin 做"绕枢轴的 S/R"后 decompose 回 TRS，translation 直接覆盖 position。
 */
export function applyStyleAppearanceToSplitMesh(
  mesh: Mesh,
  appearance: StyleAppearance,
  materialBuilder?: MaterialBuilder,
): void {
  const resolvedMaterial = resolveStyleMaterial(
    appearance,
    mesh.material as Material,
    materialBuilder ?? defaultMaterialBuilder,
  );

  if (appearance.mesh) {
    const built = appearance.mesh(mesh.geometry, resolvedMaterial);
    if (built) {
      if (built.geometry !== mesh.geometry) {
        const oldGeometry = mesh.geometry;
        mesh.geometry = built.geometry;
        disposeReplacedSplitGeometry(mesh, oldGeometry);
      }
      mesh.material = built.material;
    } else {
      mesh.material = resolvedMaterial;
    }
  } else {
    mesh.material = resolvedMaterial;
  }

  const needTransform =
    appearance.translation !== undefined ||
    appearance.scale !== undefined ||
    appearance.rotation !== undefined;
  if (!needTransform) return;

  const hasScaleOrRotation =
    appearance.scale !== undefined || appearance.rotation !== undefined;

  if (hasScaleOrRotation) {
    const pivot = new Vector3();
    if (appearance.origin !== undefined) {
      applyVec3(pivot, appearance.origin);
    }

    let sx = 1;
    let sy = 1;
    let sz = 1;
    if (appearance.scale !== undefined) {
      if (Array.isArray(appearance.scale)) {
        sx = appearance.scale[0] ?? 1;
        sy = appearance.scale[1] ?? 1;
        sz = appearance.scale[2] ?? 1;
      } else {
        const sc = appearance.scale as Vector3;
        sx = sc.x;
        sy = sc.y;
        sz = sc.z;
      }
    }

    const euler = new Euler();
    if (appearance.rotation !== undefined) {
      applyEuler(euler, appearance.rotation);
    } else {
      euler.set(0, 0, 0);
    }

    const styleM = buildPivotStyleMatrix(pivot, sx, sy, sz, euler);
    mesh.updateMatrix();
    mesh.matrix.multiply(styleM);
    mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
  }

  if (appearance.translation !== undefined) {
    applyVec3(mesh.position, appearance.translation);
  }
}

/**
 * 释放被 mesh 工厂替换下来的 split geometry：
 * - instanced split 与源瓦片共享同一 geometry，绝不能 dispose；
 * - 合并 split 与瓦片共享顶点属性，需先摘除共享引用再释放（见 disposeMergedSplitGeometryCacheEntry）。
 */
function disposeReplacedSplitGeometry(
  mesh: Mesh,
  oldGeometry: BufferGeometry,
): void {
  const originalMesh = mesh.userData._originalMesh as Mesh | undefined;
  if (!originalMesh) {
    oldGeometry.dispose();
    return;
  }
  if (oldGeometry === originalMesh.geometry) return;
  disposeMergedSplitGeometryCacheEntry(oldGeometry, originalMesh);
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
