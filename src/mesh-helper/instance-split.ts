import {
  Box3,
  InstancedBufferAttribute,
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
const tmpInstanceBox = new Box3();

/** split 不得继承源瓦片的运行时状态键（过滤快照只属于源） */
const EXCLUDED_SPLIT_USER_DATA_KEYS = new Set<string>([
  "_originalIndex",
  "_styleFilteredIndex",
  "_originalInstanceMatrix",
  "_originalInstanceCount",
  "_originalInstanceColor",
  "_originalInstanceMatrices",
]);

function buildSplitUserData(source: InstancedMesh): Record<string, unknown> {
  const userData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source.userData)) {
    if (!EXCLUDED_SPLIT_USER_DATA_KEYS.has(key)) userData[key] = value;
  }
  return userData;
}

/**
 * split 必须从「按 feature 隐藏前」的完整实例数据构建：显隐系统可能已压缩
 * instanceMatrix 并下调 count（样式系统），或原地零缩放矩阵（显隐规则系统）。
 * 优先读引用快照（带原始 count），其次读零缩放方案的原始矩阵拷贝，最后退回当前状态。
 */
function resolveOriginalInstanceSource(
  source: InstancedMesh,
): { matrices: Float32Array; count: number } {
  const attr = source.userData._originalInstanceMatrix;
  if (attr instanceof InstancedBufferAttribute) {
    const count = source.userData._originalInstanceCount;
    return {
      matrices: attr.array as Float32Array,
      count: typeof count === "number" ? count : source.count,
    };
  }
  const raw = source.userData._originalInstanceMatrices;
  if (raw instanceof Float32Array) {
    // 零缩放方案不下调 count，当前 count 即原始数量
    return { matrices: raw, count: source.count };
  }
  return {
    matrices: source.instanceMatrix.array as Float32Array,
    count: source.count,
  };
}

function getMatchingInstanceIndices(
  source: InstancedMesh,
  idSet: ReadonlySet<number>,
  featureIdAttribute: number,
): number[] {
  const instanceFeatures = source.userData.instanceFeatures as
    | InstanceFeatures
    | undefined;
  const idMap = getPartIdMapForFeatureAttribute(
    source.userData,
    featureIdAttribute,
  );
  if (!instanceFeatures || !idMap) return [];

  const targetFids = new Set<number>();
  for (const partId of idSet) {
    const fid = idMap[partId];
    if (fid !== undefined) targetFids.add(fid);
  }
  if (targetFids.size === 0) return [];

  // pid 通道需要第二个 featureIds 数组支撑
  if (featureIdAttribute === 1 && instanceFeatures.featureIds.length < 2) {
    return [];
  }
  const featureIndex = featureIdAttribute === 1 ? 1 : 0;

  // fid 数组按原始实例下标存储，必须遍历原始数量；压缩后 source.count 已变小
  const { count } = resolveOriginalInstanceSource(source);
  const indices: number[] = [];
  for (let i = 0; i < count; i++) {
    const fid = instanceFeatures.getFeatureId(featureIndex, i);
    if (targetFids.has(fid)) indices.push(i);
  }
  return indices;
}

export function measureInstanceSplitForTile(
  source: InstancedMesh,
  idSet: ReadonlySet<number>,
  featureIdAttribute: number,
): { instanceCount: number; bbox: Box3 } | null {
  const indices = getMatchingInstanceIndices(source, idSet, featureIdAttribute);
  if (indices.length === 0) return null;

  const geometry = source.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const localBox = geometry.boundingBox;
  if (!localBox) return null;

  const { matrices } = resolveOriginalInstanceSource(source);
  const bbox = new Box3();
  source.updateWorldMatrix(true, false);
  for (const index of indices) {
    tmpInstanceMatrix.fromArray(matrices, index * 16);
    const instanceBox = tmpInstanceBox
      .copy(localBox)
      .applyMatrix4(tmpInstanceMatrix);
    instanceBox.applyMatrix4(source.matrixWorld);
    bbox.union(instanceBox);
  }

  return { instanceCount: indices.length, bbox };
}

function createSplitInstancedMesh(
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
  const sourceMaterials = Array.isArray(originalMesh.material)
    ? originalMesh.material
    : [originalMesh.material];
  const newMaterial =
    sourceMaterials.length === 1
      ? sourceMaterials[0]!.clone()
      : sourceMaterials.map((mat) => mat.clone());
  const newMesh = new InstancedMesh(
    originalMesh.geometry,
    newMaterial,
    instanceIndices.length,
  );

  originalMesh.updateWorldMatrix(true, false);
  newMesh.position.copy(originalMesh.position);
  newMesh.rotation.copy(originalMesh.rotation);
  newMesh.scale.copy(originalMesh.scale);

  // 从原始矩阵读：压缩隐藏后 originalMesh.getMatrixAt 读到的是错位的压缩数组
  const { matrices } = resolveOriginalInstanceSource(originalMesh);
  for (let j = 0; j < instanceIndices.length; j++) {
    tmpInstanceMatrix.fromArray(matrices, instanceIndices[j]! * 16);
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
    ...buildSplitUserData(originalMesh),
    featureId: idMap[primaryId],
    [cfg.idKey]: primaryId,
    [cfg.collectorKey]: idsOnMesh,
    _originalMesh: originalMesh,
    propertyData,
    _isSplit: true,
    isMergedSplit: true,
    isInstancedSplit: true,
    partIdChannel: channel,
    splitInstanceIndices: [...instanceIndices],
  };
  newMesh.name = `${cfg.namePrefix}_inst_${idsOnMesh.length}_${primaryId}`;
  return newMesh;
}

export function buildSplitInstancedMeshForTileMesh(
  source: InstancedMesh,
  idSet: ReadonlySet<number>,
  featureIdAttribute: number,
): InstancedMesh | null {
  if (idSet.size === 0) return null;

  const indices = getMatchingInstanceIndices(source, idSet, featureIdAttribute);
  if (indices.length === 0) return null;

  return createSplitInstancedMesh(source, indices, idSet, featureIdAttribute);
}

/** 挂在 split mesh.userData：样式外观系统构建的派生 mesh */
const STYLE_APPEARANCE_BUILT_KEY = "_gltfParserStyleAppearanceBuilt";

/** 释放 instanced split 的独占资源（几何与源共享，仅释放 clone 材质） */
export function disposeSplitInstancedMeshResources(mesh: Mesh): void {
  const built = mesh.userData?.[STYLE_APPEARANCE_BUILT_KEY] as
    | Mesh
    | undefined;
  if (built) {
    built.removeFromParent();
    delete mesh.userData[STYLE_APPEARANCE_BUILT_KEY];
  }
  mesh.removeFromParent();

  const tileMesh = mesh.userData?._originalMesh as InstancedMesh | undefined;
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

const SPLIT_TEXTURE_KEYS = [
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

function disposeSplitMaterialVsTileInstance(
  mat: Material,
  tileMat: Material | undefined,
): void {
  const matProps = mat as unknown as Record<string, unknown>;
  const tileProps = (tileMat ?? null) as unknown as
    | Record<string, unknown>
    | null;
  for (const key of SPLIT_TEXTURE_KEYS) {
    const texture = matProps[key];
    if (texture == null) continue;
    const tileTexture = tileProps?.[key];
    if (tileTexture != null && texture === tileTexture) {
      // 与源瓦片共享的纹理不能 dispose，仅解除引用
      matProps[key] = null;
    } else {
      (texture as { dispose(): void }).dispose();
    }
  }
  mat.dispose();
}
