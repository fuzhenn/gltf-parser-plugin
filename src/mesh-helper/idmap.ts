import { Mesh, Object3D } from "three";
import { resolveFeatureChannelOnMesh, type PartIdChannel } from "./mesh";

type PartIdField = "_oid" | "_pid";
type IdMapKey = "_tile_oidMap" | "_tile_pidMap";

/**
 * 为 mesh 上单个通道构建 partId → featureId 映射并挂到 `userData[mapKey]`。
 *
 * 有属性表时 partId 取自行数据中的 `_oid` / `_pid` 字段，并预写 `_propertyCache`
 * 供 getFeatureDataByPartId 复用，避免重复整行解码。
 */
function buildChannelPartIdMap(
  meshObject: Object3D,
  channel: PartIdChannel,
  field: PartIdField,
  mapKey: IdMapKey,
): void {
  const resolved = resolveFeatureChannelOnMesh(meshObject as Mesh, channel);
  if (!resolved) return;

  const { featureIdAttr, featureIdConfig } = resolved;
  const { structuralMetadata } = meshObject.userData;
  const propertyTableIndex = featureIdConfig?.propertyTable;
  // 无属性表或无元数据时无法建立映射，直接跳过
  if (propertyTableIndex === undefined || !structuralMetadata) return;

  const processedFeatureIds = new Set<number>();
  const idMap: Record<number, number> = {};
  let propertyCache: Map<string, Record<string, unknown>> | undefined;

  for (let vertexIndex = 0; vertexIndex < featureIdAttr.count; vertexIndex++) {
    const featureId = featureIdAttr.getX(vertexIndex);
    // 每个 feature id 只处理一次；属性表解码是确定性的，失败重试没有意义
    if (processedFeatureIds.has(featureId)) continue;
    processedFeatureIds.add(featureId);

    try {
      const featureData = structuralMetadata.getPropertyTableData(
        propertyTableIndex,
        featureId,
      ) as Record<string, unknown>;
      const partId = featureData[field] as number;

      idMap[partId] = featureId;
      if (!propertyCache) propertyCache = new Map();
      propertyCache.set(`${propertyTableIndex}-${partId}`, featureData);
    } catch {
      // 属性表读取失败或行数据为空时跳过该 feature id
    }
  }

  if (!propertyCache) return;

  meshObject.userData[mapKey] = idMap;
  meshObject.userData["_propertyCache"] = propertyCache;
}

/**
 * 构建 partId（OID / PID）→ featureId 的映射：
 * OID → `_FEATURE_ID_0`（featureIds[0]），PID → `_FEATURE_ID_1`（featureIds[1]）
 * @param scene Scene object
 */
function buildPartIdToFeatureIdMap(scene: Object3D): void {
  scene.traverse((meshObject) => {
    buildChannelPartIdMap(meshObject, "oid", "_oid", "_tile_oidMap");
    buildChannelPartIdMap(meshObject, "pid", "_pid", "_tile_pidMap");
  });
}

export { buildPartIdToFeatureIdMap };
