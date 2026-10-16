import type { Mesh } from "three";
import {
  CHANNEL_CONFIG,
  resolveFeatureChannelOnMesh,
  type PartIdChannel,
} from "../features/channel";
import { getPartIdMap } from "../features/id-map";
import {
  getOrLoadFeatureData,
  type FeatureDataCache,
} from "../features/feature-data-cache";

export function addMeshUserData(
  tileMesh: Mesh,
  splitMesh: Mesh,
  idSet: ReadonlySet<number>,
  channel: PartIdChannel,
  options?: { splitGeometryManagedByCache?: boolean },
  featureDataCache?: FeatureDataCache,
) {
  if (idSet.size === 0) return null;

  const cfg = CHANNEL_CONFIG[channel];
  const idMap = getPartIdMap(tileMesh, channel);
  if (!idMap) return null;

  const resolved = resolveFeatureChannelOnMesh(tileMesh, channel);
  if (!resolved) return null;

  const idsOnMesh: number[] = [];
  for (const partId of idSet) {
    if (idMap[partId] !== undefined) {
      idsOnMesh.push(partId);
    }
  }
  idsOnMesh.sort((a, b) => a - b);
  if (idsOnMesh.length === 0) return null;
  const primaryId = idsOnMesh[0]!;

  const { structuralMetadata } = tileMesh.userData;
  const propertyTableIndex = resolved.featureIdConfig?.propertyTable;

  let propertyData: unknown = null;
  if (
    structuralMetadata &&
    propertyTableIndex !== undefined &&
    idMap[primaryId] !== undefined
  ) {
    try {
      // 优先命中插件级缓存，未命中再整行解码并回写
      propertyData = getOrLoadFeatureData(featureDataCache, primaryId, () =>
        structuralMetadata.getPropertyTableData(
          propertyTableIndex,
          idMap[primaryId]!,
        ) as Record<string, unknown>,
      );
    } catch {
      // ignore
    }
  }

  const userData: Record<string, unknown> = {
    ...tileMesh.userData,
    featureId: idMap[primaryId],
    [cfg.idKey]: primaryId,
    [cfg.collectorKey]: idsOnMesh,
    _originalMesh: tileMesh,
    propertyData,
    _isSplit: true,
    isMergedSplit: true,
    partIdChannel: channel,
  };
  if (options?.splitGeometryManagedByCache) {
    userData.splitGeometryManagedByCache = true;
  }
  splitMesh.userData = userData;

  splitMesh.name = `${cfg.namePrefix}_${idsOnMesh.length}_${primaryId}`;
}
