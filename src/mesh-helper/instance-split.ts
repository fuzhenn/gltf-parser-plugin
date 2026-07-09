import {
  Box3,
  InstancedMesh,
  Matrix4,
  Material,
  Mesh,
} from "three";
import type { InstanceFeatures } from "../mesh/types";
import {
  featureIdAttributeToChannel,
  getPartIdMapForFeatureAttribute,
} from "./mesh";

/** 挂在源 InstancedMesh.userData：按 feature id 集缓存命中的 instance 下标 */
export const TILE_INSTANCE_SUBSET_CACHE_KEY =
  "_gltfParserMergedSplitInstanceIndicesCache";

const CHANNEL_META = {
  oid: {
    idKey: "oid",
    collectorKey: "collectorOids",
    namePrefix: "merged_features",
  },
  pid: {
    idKey: "pid",
    collectorKey: "collectorPids",
    namePrefix: "merged_pids",
  },
} as const;

const tmpInstanceMatrix = new Matrix4();

export function getTileInstanceSubsetCache(
  source: InstancedMesh,
): Map<string, number[]> {
  const existing = source.userData[TILE_INSTANCE_SUBSET_CACHE_KEY] as
    | Map<string, number[]>
    | undefined;
  if (existing) return existing;
  const map = new Map<string, number[]>();
  source.userData[TILE_INSTANCE_SUBSET_CACHE_KEY] = map;
  return map;
}

export function disposeTileMeshInstanceSubsetCache(source: InstancedMesh): void {
  const map = source.userData[TILE_INSTANCE_SUBSET_CACHE_KEY] as
    | Map<string, number[]>
    | undefined;
  if (!map) return;
  map.clear();
  delete source.userData[TILE_INSTANCE_SUBSET_CACHE_KEY];
}

export function getMatchingInstanceIndices(
  source: InstancedMesh,
  idSet: ReadonlySet<number>,
  featureIdAttribute: number,
): number[] {
  const instanceFeatures = source.userData.instanceFeatures as
    | InstanceFeatures
    | undefined;
  const idMap = getPartIdMapForFeatureAttribute(source.userData, featureIdAttribute);
  if (!instanceFeatures || !idMap) return [];

  const targetFids = new Set<number>();
  for (const partId of idSet) {
    const fid = idMap[partId];
    if (fid !== undefined) targetFids.add(fid);
  }
  if (targetFids.size === 0) return [];

  const needsPidChannel =
    featureIdAttribute === 1 && instanceFeatures.featureIds.length > 1;
  const featureIndex = needsPidChannel ? 1 : 0;
  if (featureIdAttribute === 1 && !needsPidChannel) return [];

  const indices: number[] = [];
  for (let i = 0; i < source.count; i++) {
    const fid = instanceFeatures.getFeatureId(featureIndex, i);
    if (targetFids.has(fid)) indices.push(i);
  }
  return indices;
}

export function measureInstanceSubsetForTile(
  source: InstancedMesh,
  idSet: ReadonlySet<number>,
  featureIdAttribute: number,
): { instanceCount: number; bbox: Box3 } | null {
  const indices = getMatchingInstanceIndices(source, idSet, featureIdAttribute);
  if (indices.length === 0) return null;

  const geometry = source.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const localBox = geometry.boundingBox?.clone() ?? new Box3();

  const bbox = new Box3();
  source.updateWorldMatrix(true, false);
  for (const index of indices) {
    source.getMatrixAt(index, tmpInstanceMatrix);
    const instanceBox = localBox.clone().applyMatrix4(tmpInstanceMatrix);
    instanceBox.applyMatrix4(source.matrixWorld);
    bbox.union(instanceBox);
  }

  return { instanceCount: indices.length, bbox };
}

function createSubsetInstancedMesh(
  originalMesh: InstancedMesh,
  instanceIndices: readonly number[],
  idSet: ReadonlySet<number>,
  featureIdAttribute: number,
): InstancedMesh | null {
  if (instanceIndices.length === 0) return null;

  const channel = featureIdAttributeToChannel(featureIdAttribute);
  const cfg = CHANNEL_META[channel];
  const idMap = getPartIdMapForFeatureAttribute(
    originalMesh.userData,
    featureIdAttribute,
  );
  if (!idMap) return null;

  const idsOnMesh: number[] = [];
  for (const partId of idSet) {
    if (idMap[partId] !== undefined) idsOnMesh.push(partId);
  }
  idsOnMesh.sort((a, b) => a - b);
  if (idsOnMesh.length === 0) return null;

  const primaryId = idsOnMesh[0]!;
  const newMaterial = (originalMesh.material as Material).clone();
  const newMesh = new InstancedMesh(
    originalMesh.geometry,
    newMaterial,
    instanceIndices.length,
  );

  originalMesh.updateWorldMatrix(true, false);
  newMesh.position.copy(originalMesh.position);
  newMesh.rotation.copy(originalMesh.rotation);
  newMesh.scale.copy(originalMesh.scale);

  for (let j = 0; j < instanceIndices.length; j++) {
    originalMesh.getMatrixAt(instanceIndices[j]!, tmpInstanceMatrix);
    newMesh.setMatrixAt(j, tmpInstanceMatrix);
  }
  newMesh.instanceMatrix.needsUpdate = true;

  const { structuralMetadata, instanceFeatures } = originalMesh.userData;
  const featureConfig = (instanceFeatures as InstanceFeatures | undefined)
    ?.featureIds?.[featureIdAttribute];
  let propertyData: unknown = null;
  if (
    structuralMetadata &&
    featureConfig?.propertyTable !== undefined &&
    idMap[primaryId] !== undefined
  ) {
    try {
      propertyData = structuralMetadata.getPropertyTableData(
        featureConfig.propertyTable,
        idMap[primaryId]!,
      );
    } catch {
      // ignore
    }
  }

  newMesh.userData = {
    ...originalMesh.userData,
    featureId: idMap[primaryId],
    [cfg.idKey]: primaryId,
    [cfg.collectorKey]: idsOnMesh,
    originalMesh: originalMesh,
    propertyData,
    isSplit: true,
    isMergedSplit: true,
    isInstancedSplit: true,
    partIdChannel: channel,
    subsetInstanceIndices: [...instanceIndices],
    splitGeometryManagedByCache: true,
  };
  newMesh.name = `${cfg.namePrefix}_inst_${idsOnMesh.length}_${primaryId}`;
  return newMesh;
}

export function buildSubsetInstancedMeshForTileMesh(
  source: InstancedMesh,
  idSet: ReadonlySet<number>,
  featureIdAttribute: number,
  cacheKey?: string,
): InstancedMesh | null {
  if (idSet.size === 0) return null;

  let indices: number[] | undefined;
  if (cacheKey) {
    const cache = getTileInstanceSubsetCache(source);
    indices = cache.get(cacheKey);
    if (!indices) {
      indices = getMatchingInstanceIndices(source, idSet, featureIdAttribute);
      if (indices.length === 0) return null;
      cache.set(cacheKey, indices);
    }
  } else {
    indices = getMatchingInstanceIndices(source, idSet, featureIdAttribute);
    if (indices.length === 0) return null;
  }

  return createSubsetInstancedMesh(source, indices, idSet, featureIdAttribute);
}

/** 释放 subset InstancedMesh 的独占资源（几何与源共享，仅释放 clone 材质） */
export function disposeSubsetInstancedMeshResources(mesh: Mesh): void {
  const builtKey = "_gltfParserStyleAppearanceBuilt";
  const built = mesh.userData?.[builtKey] as Mesh | undefined;
  if (built) {
    built.removeFromParent();
    delete mesh.userData[builtKey];
  }
  mesh.removeFromParent();

  const tileMesh = mesh.userData?.originalMesh as InstancedMesh | undefined;
  const tileMats = tileMesh?.material;
  const tileMat = Array.isArray(tileMats) ? tileMats[0] : tileMats;

  const mats = mesh.material;
  const list = Array.isArray(mats) ? mats : [mats];
  for (let i = 0; i < list.length; i++) {
    const mat = list[i];
    if (!mat) continue;
    disposeSplitMaterialVsTileInstance(mat, tileMat as Material | undefined);
  }

  (mesh as unknown as { geometry: null }).geometry = null;
}

function disposeSplitMaterialVsTileInstance(
  mat: Material,
  tileMat: Material | undefined,
): void {
  const TEXTURE_KEYS = [
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
    "metalnessMap",
    "roughnessMap",
  ] as const;

  const ra = mat as unknown as Record<string, unknown>;
  const rb = (tileMat ?? null) as unknown as Record<string, unknown> | null;
  for (const key of TEXTURE_KEYS) {
    const va = ra[key];
    if (va == null) continue;
    const vb = rb?.[key];
    if (vb != null && va === vb) {
      ra[key] = null;
    } else {
      (va as { dispose(): void }).dispose();
    }
  }
  mat.dispose();
}
