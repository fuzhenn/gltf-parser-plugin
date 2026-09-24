import {
  BufferAttribute,
  BufferGeometry,
  Euler,
  InstancedBufferAttribute,
  InstancedMesh,
  Material,
  Mesh,
  Object3D,
  Vector3,
} from "three";
import {
  buildStyleConditionEvaluatorMap,
  evaluateStyleCondition,
  resolveShowContent,
  resolveShowFeatureIdAttribute,
  resolveStyleConditionContent,
  resolveStyleConditionFeatureIdAttribute,
  type StyleCondition,
  type StyleAppearance,
  type StyleConditionInput,
  type StyleShowInput,
} from "../appearance";
import {
  applyEuler,
  applyVec3,
  buildPivotStyleMatrix,
  resolveStyleMaterial,
} from "../plugin/style-appearance-shared";
import type { MaterialBuilder } from "../types";
import { defaultMaterialBuilder } from "../loader";
import {
  addMeshUserData,
  buildMergedSplitGeometryForTileMesh,
  buildMergedSplitGeometryForTileMeshByPids,
  buildVisibleIndex,
  featureIdAttributeToChannel,
  getPartIdMapForFeatureAttribute,
  getPropertyDataFromUserData,
  isTileInstancedMesh,
  isTileMesh,
  snapshotOriginalIndex,
} from "../mesh-helper";
import type { InstanceFeatures } from "../mesh/types";
import { buildSplitInstancedMeshForTileMesh } from "../mesh-helper/instance-split";

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
  geometry: BufferGeometry,
  material: Material,
  appearance: StyleAppearance,
  materialBuilder?: MaterialBuilder,
): Mesh | null {
  const resolvedMaterial = resolveStyleMaterial(
    appearance,
    material,
    materialBuilder ?? defaultMaterialBuilder,
  );

  const mesh = appearance.mesh
    ? appearance.mesh(geometry, resolvedMaterial)
    : new Mesh(geometry, resolvedMaterial);

  const needTransform =
    appearance.translation !== undefined ||
    appearance.scale !== undefined ||
    appearance.rotation !== undefined;
  if (!needTransform) return mesh;

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

  return mesh;
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

function collectPartIdsFromTileMesh(
  tileMesh: Mesh,
  featureIdAttribute: number,
): number[] {
  const idMap = getPartIdMapForFeatureAttribute(tileMesh, featureIdAttribute);
  if (!idMap) return [];
  return Object.keys(idMap).map((k) => Number(k));
}

/**
 * 解析某条件在 tile mesh 上命中的 partId 集合（按 cacheKey 缓存）。
 * featureIdAttribute 由调用方传入（MeshCollector 构造时已解析），避免重复计算。
 */
export function resolveMatchedPartIdsOnTileMesh(
  tileMesh: Mesh,
  condition: StyleCondition,
  cacheKey: string,
  featureIdAttribute: number,
): Set<number> {
  const cached = getCachedMatchedFeatureIds(tileMesh, cacheKey);
  if (cached) return cached;

  const [condInput] = condition;
  const idMap = getPartIdMapForFeatureAttribute(tileMesh, featureIdAttribute);
  const matchedPartIds = new Set<number>();
  if (!idMap) {
    setCachedMatchedFeatureIds(tileMesh, cacheKey, matchedPartIds);
    return matchedPartIds;
  }

  const evaluators = buildStyleConditionEvaluatorMap({
    conditions: [condition],
  });

  for (const partId of collectPartIdsFromTileMesh(
    tileMesh,
    featureIdAttribute,
  )) {
    const propertyData = getPropertyDataFromUserData(
      tileMesh.userData,
      partId,
      featureIdAttribute,
    );
    if (propertyData == null) continue;
    if (!evaluateStyleCondition(condInput, propertyData, evaluators)) {
      continue;
    }
    if (idMap[partId] === undefined) continue;
    matchedPartIds.add(partId);
  }

  setCachedMatchedFeatureIds(tileMesh, cacheKey, matchedPartIds);
  return matchedPartIds;
}

/** show 隐藏集的缓存 key（与条件命中缓存同池，"f" 前缀外的独立命名空间隔离极性） */
export function buildShowHiddenCacheKey(show: StyleShowInput): string {
  return `${resolveShowFeatureIdAttribute(show)}:${resolveShowContent(show)!
    .trim()}#showHidden`;
}

/**
 * 解析该 mesh 上被 show 隐藏的 partId（keep-set 补集语义：不满足 show 表达式即隐藏，
 * 无属性数据的 partId 保持可见），与 index-visibility 的参考实现语义一致。
 * 结果按 showHiddenKey 缓存（key 携带 show 内容，show 变更自然换 key，无失效问题）。
 */
export function resolveShowHiddenPartIdsOnTileMesh(
  tileMesh: Mesh,
  show: StyleShowInput,
  showHiddenKey: string,
  featureIdAttribute: number,
): Set<number> {
  const cached = getCachedMatchedFeatureIds(tileMesh, showHiddenKey);
  if (cached) return cached;

  const idMap = getPartIdMapForFeatureAttribute(tileMesh, featureIdAttribute);
  const hiddenPartIds = new Set<number>();
  if (!idMap) {
    setCachedMatchedFeatureIds(tileMesh, showHiddenKey, hiddenPartIds);
    return hiddenPartIds;
  }

  const evaluators = buildStyleConditionEvaluatorMap({ show });
  const showExpr = resolveShowContent(show)!;

  for (const partId of collectPartIdsFromTileMesh(
    tileMesh,
    featureIdAttribute,
  )) {
    const propertyData = getPropertyDataFromUserData(
      tileMesh.userData,
      partId,
      featureIdAttribute,
    );
    if (propertyData == null) continue;
    if (idMap[partId] === undefined) continue;
    if (!evaluateStyleCondition(showExpr, propertyData, evaluators)) {
      hiddenPartIds.add(partId);
    }
  }

  setCachedMatchedFeatureIds(tileMesh, showHiddenKey, hiddenPartIds);
  return hiddenPartIds;
}

/**
 * 按 matchedPartIds 从 tile mesh 构建拆分 mesh（普通网格走合并几何，实例网格走实例拆分），
 * 并应用 appearance；未命中或构建失败返回 null。
 */
export function buildSplitMeshForTileMesh(
  tileMesh: Mesh,
  matchedPartIds: Set<number>,
  featureIdAttribute: number,
  appearance: StyleAppearance,
  materialBuilder?: MaterialBuilder,
): Mesh | null {
  if (matchedPartIds.size === 0) return null;

  if (tileMesh instanceof InstancedMesh && isTileInstancedMesh(tileMesh)) {
    const instanced = buildSplitInstancedMeshForTileMesh(
      tileMesh,
      matchedPartIds,
      featureIdAttribute,
    );
    return instanced ? instanced : null;
  }

  if (!isTileMesh(tileMesh)) return null;

  const channel = featureIdAttributeToChannel(featureIdAttribute);
  const geometry =
    channel === "pid"
      ? buildMergedSplitGeometryForTileMeshByPids(tileMesh, matchedPartIds)
      : buildMergedSplitGeometryForTileMesh(tileMesh, matchedPartIds);
  if (!geometry) return null;

  const splitMesh = applyStyleAppearanceToSplitMesh(
    geometry,
    tileMesh.material as Material,
    appearance,
    materialBuilder,
  );
  if (!splitMesh) return null;
  addMeshUserData(tileMesh, splitMesh!, matchedPartIds, channel, {
    splitGeometryManagedByCache: true,
  });
  return splitMesh ? splitMesh : null;
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

// ---------- 按 feature 隐藏（普通 mesh 走 index 过滤） ----------

export function hideMatchedFeaturesOnTileMesh(
  mesh: Mesh,
  featureIdAttribute: number | undefined,
  hiddenFids: Set<number>,
): void {
  const geometry = mesh.geometry;
  const index = geometry?.index;
  if (!index) return;

  if (featureIdAttribute === undefined || hiddenFids.size === 0) {
    restoreOriginalIndex(mesh, geometry);
    return;
  }

  const original = snapshotOriginalIndex(mesh, geometry);
  if (!original) return;

  const filtered = buildVisibleIndex(
    mesh,
    original.array,
    `_feature_id_${featureIdAttribute}`,
    hiddenFids,
  );
  setFilteredIndex(mesh, geometry, original, filtered);
}

function disposeStyleFilteredIndex(
  mesh: Mesh,
  original: BufferAttribute,
): void {
  const filtered = mesh.userData._styleFilteredIndex as
    | BufferAttribute
    | undefined;
  if (filtered && filtered !== original) {
    filtered.dispose();
  }
  mesh.userData._styleFilteredIndex = undefined;
}

function setFilteredIndex(
  mesh: Mesh,
  geometry: BufferGeometry,
  original: BufferAttribute,
  filteredArray: Uint16Array | Uint32Array,
): void {
  disposeStyleFilteredIndex(mesh, original);
  const attr = new BufferAttribute(filteredArray, 1);
  mesh.userData._styleFilteredIndex = attr;
  geometry.setIndex(attr);
}

function restoreOriginalIndex(mesh: Mesh, geometry: BufferGeometry): void {
  const original = mesh.userData._originalIndex;
  if (!(original instanceof BufferAttribute)) return;
  disposeStyleFilteredIndex(mesh, original);
  geometry.setIndex(original);
}

// ---------- 按 feature 隐藏（InstancedMesh 走实例压缩） ----------

let scratchKeptInstanceIndices: Int32Array | undefined;

/** instanced 显隐的实例化 feature 通道；pid(1) 需声明第二个 featureIds 通道才可解析 */
function resolveInstanceFeatureIndex(
  instanceFeatures: InstanceFeatures,
  featureIdAttribute: number,
): number | null {
  if (featureIdAttribute === 0) return 0;
  return instanceFeatures.featureIds.length > 1 ? 1 : null;
}

/** 引用快照：过滤只通过替换 instanceMatrix / instanceColor 属性对象进行，不改写原数组 */
function snapshotInstancedVisibility(mesh: InstancedMesh): void {
  if (
    mesh.userData._originalInstanceMatrix instanceof InstancedBufferAttribute
  ) {
    return;
  }
  mesh.userData._originalInstanceMatrix = mesh.instanceMatrix;
  mesh.userData._originalInstanceCount = mesh.count;
  if (mesh.instanceColor) {
    mesh.userData._originalInstanceColor = mesh.instanceColor;
  }
}

function restoreInstancedVisibility(mesh: InstancedMesh): void {
  const original = mesh.userData._originalInstanceMatrix;
  if (!(original instanceof InstancedBufferAttribute)) return;
  if (mesh.instanceMatrix === original) return;
  mesh.instanceMatrix = original;
  mesh.count = mesh.userData._originalInstanceCount as number;
  const originalColor = mesh.userData._originalInstanceColor;
  if (
    originalColor instanceof InstancedBufferAttribute &&
    mesh.instanceColor !== originalColor
  ) {
    mesh.instanceColor = originalColor;
  }
}

/**
 * InstancedMesh 的按 feature 隐藏：把可见 instance 的矩阵（及 instanceColor）压缩进
 * 新属性对象并下调 count，被隐藏的 instance 不再参与绘制。
 * 始终从原始快照出发重建，重复调用与恢复语义幂等。
 */
export function hideMatchedFeaturesOnInstancedMesh(
  mesh: InstancedMesh,
  featureIdAttribute: number | undefined,
  hiddenFids: Set<number>,
): void {
  snapshotInstancedVisibility(mesh);

  const instanceFeatures = mesh.userData.instanceFeatures as
    | InstanceFeatures
    | undefined;
  if (!instanceFeatures || featureIdAttribute === undefined) {
    restoreInstancedVisibility(mesh);
    return;
  }
  const featureIndex = resolveInstanceFeatureIndex(
    instanceFeatures,
    featureIdAttribute,
  );

  if (featureIndex === null || hiddenFids.size === 0) {
    restoreInstancedVisibility(mesh);
    return;
  }

  const originalMatrix = mesh.userData
    ._originalInstanceMatrix as InstancedBufferAttribute;
  const originalCount = mesh.userData._originalInstanceCount as number;
  const source = originalMatrix.array as Float32Array;

  if (
    !scratchKeptInstanceIndices ||
    scratchKeptInstanceIndices.length < originalCount
  ) {
    scratchKeptInstanceIndices = new Int32Array(originalCount);
  }
  const kept = scratchKeptInstanceIndices;
  let visibleCount = 0;
  for (let i = 0; i < originalCount; i++) {
    if (!hiddenFids.has(instanceFeatures.getFeatureId(featureIndex, i))) {
      kept[visibleCount++] = i;
    }
  }

  if (visibleCount === originalCount) {
    restoreInstancedVisibility(mesh);
    return;
  }

  const matrixAttr = new InstancedBufferAttribute(
    new Float32Array(visibleCount * 16),
    16,
  );
  const dst = matrixAttr.array as Float32Array;
  for (let j = 0; j < visibleCount; j++) {
    const srcOffset = kept[j]! * 16;
    dst.set(source.subarray(srcOffset, srcOffset + 16), j * 16);
  }

  // instanceColor 语义是「instance 下标 → 颜色」，必须与矩阵同步压缩，否则颜色错位
  const originalColor = mesh.userData._originalInstanceColor;
  if (originalColor instanceof InstancedBufferAttribute) {
    const itemSize = originalColor.itemSize;
    const srcColor = originalColor.array as Float32Array;
    const colorAttr = new InstancedBufferAttribute(
      new Float32Array(visibleCount * itemSize),
      itemSize,
    );
    const dstColor = colorAttr.array as Float32Array;
    for (let j = 0; j < visibleCount; j++) {
      const srcOffset = kept[j]! * itemSize;
      dstColor.set(
        srcColor.subarray(srcOffset, srcOffset + itemSize),
        j * itemSize,
      );
    }
    mesh.instanceColor = colorAttr;
  }

  mesh.instanceMatrix = matrixAttr;
  mesh.count = visibleCount;
}
