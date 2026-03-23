import { BufferAttribute, BufferGeometry, Mesh, Object3D } from "three";

import { TilesRenderer } from "3d-tiles-renderer";

/** geometry.userData 上缓存 featureId→顶点索引，避免同一几何重复 split 时重复扫描顶点 */
const FEATURE_ID_VERTEX_MAP_KEY = "_gltfParser_featureIdVertexMap";

type CachedFeatureIdVertexMap = {
  vertexCount: number;
  map: Map<number, Set<number>>;
};

function getOrBuildFeatureIdIndexMap(
  geometry: BufferGeometry,
  attributeIndex: number,
  featureIdAttr: BufferAttribute,
): Map<number, Set<number>> {
  const ud = geometry.userData as Record<string, CachedFeatureIdVertexMap | undefined>;
  const cacheKey = `${FEATURE_ID_VERTEX_MAP_KEY}_${attributeIndex}`;
  let cached = ud[cacheKey];
  const count = featureIdAttr.count;
  if (!cached || cached.vertexCount !== count) {
    cached = {
      vertexCount: count,
      map: buildFeatureIdIndexMap(featureIdAttr),
    };
    ud[cacheKey] = cached;
  }
  return cached.map;
}

/**
 * 预建featureId到顶点索引的映射表，提高查询性能
 */
function buildFeatureIdIndexMap(
  featureIdAttr: BufferAttribute
): Map<number, Set<number>> {
  const featureIdMap = new Map<number, Set<number>>();

  for (let i = 0; i < featureIdAttr.count; i++) {
    const featureId = featureIdAttr.getX(i);

    if (!featureIdMap.has(featureId)) {
      featureIdMap.set(featureId, new Set<number>());
    }
    featureIdMap.get(featureId)!.add(i);
  }

  return featureIdMap;
}

/**
 * Create a geometry for a specified feature ID
 */
function createGeometryForFeatureId(
  originalGeometry: BufferGeometry,
  featureIdMap: Map<number, Set<number>>,
  targetFeatureId: number
): BufferGeometry | null {
  const newGeometry = new BufferGeometry();

  const targetVertexIndices = featureIdMap.get(targetFeatureId);

  if (!targetVertexIndices || targetVertexIndices.size === 0) {
    return null;
  }

  const attributes = originalGeometry.attributes;
  for (const attributeName in attributes) {
    newGeometry.setAttribute(attributeName, attributes[attributeName]);
  }

  if (originalGeometry.index) {
    const originalIndex = originalGeometry.index.array;
    const newIndices: number[] = [];

    for (let i = 0; i < originalIndex.length; i += 3) {
      const a = originalIndex[i];
      const b = originalIndex[i + 1];
      const c = originalIndex[i + 2];

      if (
        targetVertexIndices.has(a) &&
        targetVertexIndices.has(b) &&
        targetVertexIndices.has(c)
      ) {
        newIndices.push(a, b, c);
      }
    }

    if (newIndices.length > 0) {
      newGeometry.setIndex(newIndices);
    }
  }

  return newGeometry;
}

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

  const newMaterial = (originalMesh.material as any).clone();
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
 * Function to split mesh by feature ID
 */
function splitMeshByOid(originalMesh: Mesh, oid: number): Mesh[] {
  const { meshFeatures, structuralMetadata } = originalMesh.userData;
  const { geometry, featureIds } = meshFeatures;

  const featureId = featureIds[0];
  const featureIdAttr = geometry.getAttribute(
    `_feature_id_${featureId.attribute}`
  );

  if (!featureIdAttr) {
    console.warn("No feature ID attribute found");
    return [];
  }

  const featureIdMap = getOrBuildFeatureIdIndexMap(
    geometry,
    featureId.attribute,
    featureIdAttr,
  );

  const currentBatchMeshes: Mesh[] = [];

  /** 与 getPropertyDataMapFromTiles 同源：idMap 已建立 oid→featureId，一次定位，避免对每个 fid getPropertyTableData */
  const oidToFid = originalMesh.userData?.idMap as
    | Record<number, number>
    | undefined;
  const fidFromMap = oidToFid?.[oid];

  if (
    fidFromMap !== undefined &&
    structuralMetadata &&
    featureIdMap.has(fidFromMap)
  ) {
    try {
      const propertyData = structuralMetadata.getPropertyTableData(
        featureId.propertyTable,
        fidFromMap,
      );
      const _oid = (propertyData as any)?._oid;
      if (_oid === oid) {
        const newGeometry = createGeometryForFeatureId(
          geometry,
          featureIdMap,
          fidFromMap,
        );

        if (newGeometry && newGeometry.attributes.position.count > 0) {
          const newMaterial = (originalMesh.material as any).clone();

          const newMesh = new Mesh(newGeometry, newMaterial);
          newMesh.parent = originalMesh.parent;
          newMesh.position.copy(originalMesh.position);
          newMesh.rotation.copy(originalMesh.rotation);
          newMesh.scale.copy(originalMesh.scale);
          newMesh.matrixWorld.copy(originalMesh.matrixWorld);

          newMesh.userData = {
            ...originalMesh.userData,
            featureId: fidFromMap,
            oid: oid,
            originalMesh: originalMesh,
            propertyData: propertyData,
            isSplit: true,
          };

          newMesh.name = `feature_${fidFromMap}_${oid || ""}`;
          currentBatchMeshes.push(newMesh);
          return currentBatchMeshes;
        }
      }
    } catch (e) {
      console.warn(
        `Failed to get property data for feature ${fidFromMap}:`,
        e,
      );
    }
  }

  // 无 idMap 或未命中时回退：逐 fid 扫描（兼容尚未 buildOidToFeatureIdMap 的场景）
  for (const [fid] of featureIdMap) {
    try {
      let _oid = null;
      let propertyData = null;

      if (structuralMetadata) {
        try {
          propertyData = structuralMetadata.getPropertyTableData(
            featureId.propertyTable,
            fid,
          );
          _oid = (propertyData as any)?._oid;

          if (_oid === oid) {
            const newGeometry = createGeometryForFeatureId(
              geometry,
              featureIdMap,
              fid,
            );

            if (newGeometry && newGeometry.attributes.position.count > 0) {
              const newMaterial = (originalMesh.material as any).clone();

              const newMesh = new Mesh(newGeometry, newMaterial);
              newMesh.parent = originalMesh.parent;
              newMesh.position.copy(originalMesh.position);
              newMesh.rotation.copy(originalMesh.rotation);
              newMesh.scale.copy(originalMesh.scale);
              newMesh.matrixWorld.copy(originalMesh.matrixWorld);

              newMesh.userData = {
                ...originalMesh.userData,
                featureId: fid,
                oid: oid,
                originalMesh: originalMesh,
                propertyData: propertyData,
                isSplit: true,
              };

              newMesh.name = `feature_${fid}_${oid || ""}`;
              currentBatchMeshes.push(newMesh);
            }
          }
        } catch (e) {
          console.warn(`Failed to get property data for feature ${fid}:`, e);
        }
      }
    } catch (error) {
      console.warn(`Error creating mesh for feature ${fid}:`, error);
    }
  }

  return currentBatchMeshes;
}

/**
 * 从瓦片中获取所有 OID
 */
export function getAllOidsFromTiles(tiles: TilesRenderer): number[] {
  const oidSet = new Set<number>();

  tiles.group.traverse((child: Object3D) => {
    const mesh = child as Mesh;
    const idMap = mesh.userData?.idMap as Record<number, number> | undefined;

    if (
      mesh.userData?.meshFeatures &&
      mesh.userData?.structuralMetadata &&
      !mesh.userData?.isSplit &&
      idMap
    ) {
      for (const oid of Object.keys(idMap).map(Number)) {
        oidSet.add(oid);
      }
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
    const idMap = mesh.userData?.idMap as Record<number, number> | undefined;

    if (
      !mesh.userData?.meshFeatures ||
      !mesh.userData?.structuralMetadata ||
      mesh.userData?.isSplit ||
      !idMap ||
      idMap[oid] === undefined
    ) {
      return;
    }

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
    const idMap = mesh.userData?.idMap as Record<number, number> | undefined;

    if (
      !mesh.userData?.meshFeatures ||
      !mesh.userData?.structuralMetadata ||
      mesh.userData?.isSplit ||
      !idMap
    ) {
      return;
    }

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

    if (
      mesh.userData.meshFeatures &&
      mesh.userData.structuralMetadata &&
      !mesh.userData.isSplit
    ) {
      if (checkMeshContainsOid(mesh, oid)) {
        tileMeshes.push(mesh);
      }
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

/**
 * 获取分割后的mesh
 */
export function getSplitMeshesFromTile(tileMesh: Mesh, oid: number): Mesh[] {
  let meshes: Mesh[] = [];

  try {
    const splitMeshes = splitMeshByOid(tileMesh, oid);
    meshes = [...meshes, ...splitMeshes];
  } catch (error) {
    console.warn(`拆分mesh失败:`, error);
  }

  return meshes;
}
