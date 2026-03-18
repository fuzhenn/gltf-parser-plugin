import { BufferAttribute, BufferGeometry, Mesh, Object3D } from "three";

import { TilesRenderer } from "3d-tiles-renderer";

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

  const featureIdMap = buildFeatureIdIndexMap(featureIdAttr);

  const currentBatchMeshes: Mesh[] = [];

  for (const [fid] of featureIdMap) {
    try {
      let _oid = null;
      let propertyData = null;

      if (structuralMetadata) {
        try {
          propertyData = structuralMetadata.getPropertyTableData(
            featureId.propertyTable,
            fid
          );
          _oid = (propertyData as any)?._oid;

          if (_oid === oid) {
            const newGeometry = createGeometryForFeatureId(
              geometry,
              featureIdMap,
              fid
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
