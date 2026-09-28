import type { BufferGeometry, Mesh } from "three";
import type { TilesRenderer } from "3d-tiles-renderer";
import type { InstanceFeatures } from "./types";
import {
  featureIdAttributeToChannel,
  resolveFeatureChannelOnMesh,
} from "./channel";
import { getPartIdMap, getPartIdMapForFeatureAttribute } from "./id-map";
import { forEachLoadedFeatureSource } from "./source";

/**
 * 内部数据钩子：在原始属性表数据基础上派生/注入额外字段（如层级 `_path`）。
 * 返回新对象；约定不修改入参。
 */
export type InternalData = (
  oid: number,
  data: Record<string, unknown>,
) => Record<string, unknown>;

/**
 * 从 userData 读取零件属性（自动区分 meshFeatures / instanceFeatures）。
 */
export function getPropertyDataFromUserData(
  userData: Record<string, unknown>,
  partId: number,
  featureIdAttribute: number,
  internalData?: InternalData,
): Record<string, unknown> | null {
  const instanceFeatures = userData.instanceFeatures as
    | InstanceFeatures
    | undefined;
  if (instanceFeatures) {
    const structuralMetadata = userData.structuralMetadata as
      | {
          getPropertyTableData(
            tableIndex: number,
            id: number,
          ): Record<string, unknown>;
        }
      | undefined;
    const idMap = getPartIdMapForFeatureAttribute(userData, featureIdAttribute);
    if (!structuralMetadata || !idMap) return null;

    const fid = idMap[partId];
    if (fid === undefined) return null;

    const propertyTableIndex =
      instanceFeatures.featureIds[featureIdAttribute]?.propertyTable;
    if (propertyTableIndex === undefined) {
      return featureIdAttribute === 1 ? { _pid: partId, pid: partId } : null;
    }

    try {
      const data = structuralMetadata.getPropertyTableData(
        propertyTableIndex,
        fid,
      );
      return featureIdAttribute === 0 && internalData
        ? internalData(partId, data)
        : data;
    } catch {
      return featureIdAttribute === 1 ? { _pid: partId, pid: partId } : null;
    }
  }

  return getPropertyDataFromMeshUserData(
    userData,
    partId,
    featureIdAttribute,
    internalData,
  );
}

function collectPartIdsFromSourceUserData(
  userData: Record<string, unknown>,
  featureIdAttribute: number,
): number[] {
  const idMap = getPartIdMapForFeatureAttribute(userData, featureIdAttribute);
  if (!idMap) return [];
  return Object.keys(idMap).map(Number);
}

/**
 * 从单个 mesh（或其 userData）读取零件属性，仅用本 mesh 的 idMap/pidMap + structuralMetadata。
 */
function getPropertyDataFromMeshUserData(
  userData: Record<string, unknown>,
  partId: number,
  featureIdAttribute: number,
  internalData?: InternalData,
): Record<string, unknown> | null {
  const meshFeatures = userData.meshFeatures as
    | { geometry?: BufferGeometry }
    | undefined;
  const mesh = {
    userData,
    geometry: meshFeatures?.geometry,
  } as Mesh;
  return getPropertyDataOnMeshByPartId(
    mesh,
    partId,
    featureIdAttribute,
    internalData,
  );
}

function getPropertyDataOnMeshByPartId(
  mesh: Mesh,
  partId: number,
  featureIdAttribute: number,
  internalData?: InternalData,
): Record<string, unknown> | null {
  const channel = featureIdAttributeToChannel(featureIdAttribute);
  const idMap = getPartIdMap(mesh, channel);
  if (!idMap || idMap[partId] === undefined) return null;

  const fid = idMap[partId]!;
  const resolved = resolveFeatureChannelOnMesh(mesh, channel);
  if (!resolved) return null;

  const { structuralMetadata } = mesh.userData;
  const propertyTableIndex = resolved.featureIdConfig?.propertyTable;

  if (propertyTableIndex === undefined || !structuralMetadata) {
    if (channel === "pid") {
      return { _pid: partId, pid: partId };
    }
    return null;
  }

  try {
    const cacheKey = `${propertyTableIndex}-${partId}`;
    let data;
    let cache = mesh.userData["_propertyCache"] as Map<
      string,
      Record<string, unknown>
    >;
    if (!cache) {
      cache = new Map();
      mesh.userData["_propertyCache"] = cache;
    }

    if (cache.has(cacheKey)) {
      data = cache.get(cacheKey)!;
    } else {
      data = structuralMetadata.getPropertyTableData(
        propertyTableIndex,
        fid,
      ) as Record<string, unknown>;
      cache.set(cacheKey, data);
    }
    return channel === "oid" && internalData
      ? internalData(partId, data)
      : data;
  } catch {
    return channel === "pid" ? { _pid: partId, pid: partId } : null;
  }
}

/**
 * 单次遍历场景构建 partId → 属性表数据（featureIdAttribute=0 → OID，1 → PID）。
 * 批量样式/筛选时使用，避免对每个 OID 重复 traverse（O(n×场景节点)）。
 */
export function getPropertyDataMapFromTiles(
  tiles: TilesRenderer,
  featureIdAttribute = 0,
  internalData?: InternalData,
): Map<number, Record<string, unknown> | null> {
  const map = new Map<number, Record<string, unknown> | null>();

  forEachLoadedFeatureSource(tiles, (source) => {
    for (const partId of collectPartIdsFromSourceUserData(
      source.userData,
      featureIdAttribute,
    )) {
      if (map.has(partId) && map.get(partId) != null) continue;
      const data = getPropertyDataFromUserData(
        source.userData,
        partId,
        featureIdAttribute,
        internalData,
      );
      if (data != null) {
        map.set(partId, data);
      } else if (!map.has(partId)) {
        map.set(partId, null);
      }
    }
  });

  return map;
}
