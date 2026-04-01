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

/**
 * 释放 {@link splitMeshByOidsMerged} 生成 mesh 的独占资源（clone 的材质、仅属于该几何的 index）。
 * 顶点 BufferAttribute 与瓦片几何共享，不得对整块 `geometry` 调用 `dispose()`，否则会误释放瓦片仍在使用的缓冲。
 */
export function disposeMergedSplitMeshResources(mesh: Mesh): void {
  // 如果material里面map被引用，不能dispose
  const mats = mesh.material;
  const list = Array.isArray(mats) ? mats : [mats];
  for (const mat of list) {
    mat?.dispose();
  }

  // TODO 需要比较splitMesh和tileMesh上的资源引用
  const geom = mesh.geometry;
  if (!geom) return;

  const idx = geom.index;
  if (idx) {
    // Three.js 运行时有 dispose；@types/three 的 BufferAttribute 类型未包含该方法
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
