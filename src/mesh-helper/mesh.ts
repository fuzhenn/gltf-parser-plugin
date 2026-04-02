import {
  BufferAttribute,
  BufferGeometry,
  Material,
  Mesh,
  Object3D,
} from "three";

import { TilesRenderer } from "3d-tiles-renderer";

/**
 * 合并多个 feature 的三角形为单一 BufferGeometry（共享顶点属性，index 为并集）
 */
function createGeometryForFeatureIdSet(
  originalGeometry: BufferGeometry,
  featureIdAttr: BufferAttribute,
  targetFids: Set<number>,
): BufferGeometry | null {
  if (targetFids.size === 0 || !originalGeometry.index) {
    return null;
  }

  const newGeometry = new BufferGeometry();
  const attributes = originalGeometry.attributes;
  for (const attributeName in attributes) {
    newGeometry.setAttribute(attributeName, attributes[attributeName]);
  }

  const originalIndex = originalGeometry.index.array;
  const newIndices: number[] = [];

  for (let i = 0; i < originalIndex.length; i += 3) {
    const a = originalIndex[i];
    const b = originalIndex[i + 1];
    const c = originalIndex[i + 2];
    const fa = featureIdAttr.getX(a);
    if (
      fa === featureIdAttr.getX(b) &&
      fa === featureIdAttr.getX(c) &&
      targetFids.has(fa)
    ) {
      newIndices.push(a, b, c);
    }
  }

  if (newIndices.length === 0) {
    return null;
  }

  newGeometry.setIndex(newIndices);
  return newGeometry;
}

/**
 * 将同一瓦片 mesh 内、属于给定 OID 集合的所有 feature 合并为 **单个** Mesh（每瓦片最多一个）
 */
export function splitMeshByOidsMerged(
  originalMesh: Mesh,
  oidSet: ReadonlySet<number>,
): Mesh | null {
  if (oidSet.size === 0) return null;

  const idMap = originalMesh.userData?.idMap as
    | Record<number, number>
    | undefined;
  if (!idMap) return null;

  const { meshFeatures, structuralMetadata } = originalMesh.userData;
  const { geometry, featureIds } = meshFeatures;
  const featureId = featureIds[0];
  const featureIdAttr = geometry.getAttribute(
    `_feature_id_${featureId.attribute}`,
  );

  if (!featureIdAttr) {
    console.warn("No feature ID attribute found");
    return null;
  }

  const targetFids = new Set<number>();
  const oidsOnMesh: number[] = [];
  for (const oid of oidSet) {
    const fid = idMap[oid];
    if (fid !== undefined) {
      targetFids.add(fid);
      oidsOnMesh.push(oid);
    }
  }

  if (targetFids.size === 0) return null;

  const newGeometry = createGeometryForFeatureIdSet(
    geometry,
    featureIdAttr,
    targetFids,
  );

  if (!newGeometry || newGeometry.attributes.position.count === 0) {
    return null;
  }

  const newMaterial = (originalMesh.material as Material).clone();
  const newMesh = new Mesh(newGeometry, newMaterial);
  newMesh.parent = originalMesh.parent;
  newMesh.position.copy(originalMesh.position);
  newMesh.rotation.copy(originalMesh.rotation);
  newMesh.scale.copy(originalMesh.scale);
  newMesh.matrixWorld.copy(originalMesh.matrixWorld);

  oidsOnMesh.sort((a, b) => a - b);
  const primaryOid = oidsOnMesh[0]!;

  let propertyData: unknown = null;
  if (structuralMetadata && idMap[primaryOid] !== undefined) {
    try {
      propertyData = structuralMetadata.getPropertyTableData(
        featureId.propertyTable,
        idMap[primaryOid]!,
      );
    } catch {
      // ignore
    }
  }

  newMesh.userData = {
    ...originalMesh.userData,
    featureId: idMap[primaryOid],
    oid: primaryOid,
    collectorOids: oidsOnMesh,
    originalMesh: originalMesh,
    propertyData,
    isSplit: true,
    isMergedSplit: true,
  };

  newMesh.name = `merged_features_${oidsOnMesh.length}_${primaryOid}`;
  return newMesh;
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

/** 两材质是否共享任一贴图类资源（同引用则对其中一方 material.dispose 会波及另一方） */
function materialSharesAnyTextureLikeWith(a: Material, b: Material): boolean {
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  for (const key of TEXTURE_LIKE_MATERIAL_KEYS) {
    const va = ra[key];
    const vb = rb[key];
    if (va != null && va === vb) {
      return true;
    }
  }
  return false;
}

function splitIndexIsSharedWithTileGeometry(
  splitGeom: BufferGeometry,
  tileGeom: BufferGeometry | undefined,
): boolean {
  if (!tileGeom?.index || !splitGeom.index) return false;
  return splitGeom.index === tileGeom.index;
}

/**
 * 释放 {@link splitMeshByOidsMerged} 生成 mesh 的独占资源。
 * - 材质：`clone()` 与瓦片材质通常共享 map 等贴图引用，仅在与瓦片**无任何**贴图类字段同引用时才 `dispose`，否则只丢引用避免误伤瓦片。
 * - 几何：顶点属性与瓦片共享，不得对整块 geometry dispose；仅释放 split 自有的 index。
 * - **不要**对 `THREE.Mesh` 调用 `dispose()`：核心库中 `Mesh` 无此方法；且若自行对 `mesh.geometry.dispose()` 会连带释放与瓦片共用的顶点缓冲。
 */
export function disposeMergedSplitMeshResources(mesh: Mesh): void {
  const tileMesh = mesh.userData?.originalMesh as Mesh | undefined;
  const tileMats = getMeshMaterials(tileMesh);

  const mats = mesh.material;
  const list = Array.isArray(mats) ? mats : [mats];

  for (let i = 0; i < list.length; i++) {
    const mat = list[i];
    if (!mat) continue;
    const tileMat = tileMats[i] ?? tileMats[0];
    if (tileMat && materialSharesAnyTextureLikeWith(mat, tileMat)) {
      continue;
    }
    mat.dispose();
  }
// material和geo回收判断是针对map和attribute以及index
  const geom = mesh.geometry;
  if (!geom) return;

  const tileGeom = tileMesh?.geometry as BufferGeometry | undefined;
  if (splitIndexIsSharedWithTileGeometry(geom, tileGeom)) {
    return;
  }

  const idx = geom.index;
  if (idx) {
    (idx as unknown as { dispose(): void }).dispose();
    geom.setIndex(null);
  }
}

/** 瓦片内原始 feature mesh（非 split 子网格） */
function isFeatureSourceMesh(mesh: Mesh): boolean {
  const u = mesh.userData;
  return Boolean(u?.meshFeatures && u?.structuralMetadata && !u?.isSplit);
}

/**
 * 从瓦片中获取所有 OID
 */
export function getAllOidsFromTiles(tiles: TilesRenderer): number[] {
  const oidSet = new Set<number>();

  tiles.group.traverse((child: Object3D) => {
    const mesh = child as Mesh;
    if (!isFeatureSourceMesh(mesh)) return;
    const idMap = mesh.userData.idMap as Record<number, number> | undefined;
    if (!idMap) return;
    for (const oid of Object.keys(idMap).map(Number)) {
      oidSet.add(oid);
    }
  });

  return Array.from(oidSet);
}

/**
 * 根据 OID 获取属性数据（从瓦片 structuralMetadata）
 */
export function getPropertyDataByOid(
  tiles: TilesRenderer,
  oid: number
): Record<string, unknown> | null {
  let result: Record<string, unknown> | null = null;

  tiles.group.traverse((child: Object3D) => {
    if (result) return;

    const mesh = child as Mesh;
    if (!isFeatureSourceMesh(mesh)) return;
    const idMap = mesh.userData.idMap as Record<number, number> | undefined;
    if (!idMap || idMap[oid] === undefined) return;

    const { meshFeatures, structuralMetadata } = mesh.userData;
    const featureId = meshFeatures.featureIds[0];
    const fid = idMap[oid];

    try {
      const data = structuralMetadata.getPropertyTableData(
        featureId.propertyTable,
        fid
      );
      result = data as Record<string, unknown>;
    } catch {
      // ignore
    }
  });

  return result;
}

/**
 * 单次遍历场景构建 OID → 属性表数据。
 * 批量样式/筛选时使用，避免对每个 OID 重复 traverse（O(n×场景节点)）。
 */
export function getPropertyDataMapFromTiles(
  tiles: TilesRenderer,
): Map<number, Record<string, unknown> | null> {
  const map = new Map<number, Record<string, unknown> | null>();

  tiles.group.traverse((child: Object3D) => {
    const mesh = child as Mesh;
    if (!isFeatureSourceMesh(mesh)) return;
    const idMap = mesh.userData.idMap as Record<number, number> | undefined;
    if (!idMap) return;

    const { meshFeatures, structuralMetadata } = mesh.userData;
    const featureId = meshFeatures.featureIds[0];
    const propertyTable = featureId.propertyTable;

    for (const oid of Object.keys(idMap).map(Number)) {
      if (map.has(oid)) continue;

      const fid = idMap[oid];
      if (fid === undefined) continue;

      try {
        const data = structuralMetadata.getPropertyTableData(
          propertyTable,
          fid,
        );
        map.set(oid, data as Record<string, unknown>);
      } catch {
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

  tiles.group.traverse((child: Object3D) => {
    const mesh = child as Mesh;
    if (isFeatureSourceMesh(mesh) && checkMeshContainsOid(mesh, oid)) {
      tileMeshes.push(mesh);
    }
  });

  return tileMeshes;
}

function checkMeshContainsOid(mesh: Mesh, oid: number): boolean {
  const idMap = mesh.userData.idMap;

  if (!idMap) {
    return false;
  }

  return idMap[oid] !== undefined;
}
