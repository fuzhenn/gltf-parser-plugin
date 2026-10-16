import type { BufferGeometry, Mesh } from "three";
import type { TilesRenderer } from "3d-tiles-renderer";
import type { InstanceFeatures } from "./types";
import {
  featureIdAttributeToChannel,
  resolveFeatureChannelOnMesh,
} from "./channel";
import { getPartIdMap, getPartIdMapForFeatureAttribute } from "./id-map";
import {
  getOrLoadFeatureData,
  type FeatureDataCache,
} from "./feature-data-cache";
import { forEachLoadedFeatureSource } from "./source";

/**
 * oid → 层级路径表（值为首尾带分隔符的路径，如 `/1/`、`/1/2/`，
 * 供 `_path.startsWith('/1/')` 子树匹配）。
 * 由 StructureHelper 构建并经调用链下传（features 层不依赖 structure 层）。
 */
type OidPathMap = Map<number, string>;

/** 读取原始属性数据（instanceFeatures 与 meshFeatures 两个来源） */
function readPropertyData(
  userData: Record<string, unknown>,
  partId: number,
  featureIdAttribute: number,
  featureDataCache?: FeatureDataCache,
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
      // 优先命中插件级缓存，未命中再整行解码并回写
      return getOrLoadFeatureData(featureDataCache, partId, () =>
        structuralMetadata.getPropertyTableData(
          propertyTableIndex,
          fid,
        ) as Record<string, unknown>,
      );
    } catch {
      return featureIdAttribute === 1 ? { _pid: partId, pid: partId } : null;
    }
  }

  return getPropertyDataFromMeshUserData(
    userData,
    partId,
    featureIdAttribute,
    featureDataCache,
  );
}

/**
 * 从 userData 读取零件属性（自动区分 meshFeatures / instanceFeatures）。
 * 传入 `oidPathMap` 时在出口为 oid 通道幂等注入 `_path`（供条件表达式做子树匹配）。
 */
export function getPropertyDataFromUserData(
  userData: Record<string, unknown>,
  partId: number,
  featureIdAttribute: number,
  oidPathMap?: OidPathMap,
  featureDataCache?: FeatureDataCache,
): Record<string, unknown> | null {
  const data = readPropertyData(
    userData,
    partId,
    featureIdAttribute,
    featureDataCache,
  );
  if (data && oidPathMap && featureIdAttribute === 0) {
    data._path = oidPathMap.get(partId)!;
  }
  return data;
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
  featureDataCache?: FeatureDataCache,
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
    featureDataCache,
  );
}

function getPropertyDataOnMeshByPartId(
  mesh: Mesh,
  partId: number,
  featureIdAttribute: number,
  featureDataCache?: FeatureDataCache,
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
      // 优先命中插件级缓存，未命中再整行解码并回写
      data = getOrLoadFeatureData(featureDataCache, partId, () =>
        structuralMetadata.getPropertyTableData(
          propertyTableIndex,
          fid,
        ) as Record<string, unknown>,
      );
      cache.set(cacheKey, data);
    }
    return data;
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
  oidPathMap?: OidPathMap,
  featureDataCache?: FeatureDataCache,
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
        oidPathMap,
        featureDataCache,
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
