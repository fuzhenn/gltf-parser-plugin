import { Mesh, type Object3D } from "three";
import {
  CHANNEL_CONFIG,
  featureIdAttributeToChannel,
  resolveFeatureChannelOnMesh,
  type PartIdChannel,
} from "./channel";

type PartIdField = "_oid" | "_pid";

/**
 * 为 mesh 上单个通道构建 partId → featureId 映射并挂到 `userData[mapKey]`。
 *
 * 有属性表时 partId 取自行数据中的 `_oid` / `_pid` 字段，并预写 `_propertyCache`
 * 供属性查询复用，避免重复整行解码。
 */
function buildChannelPartIdMap(
  meshObject: Object3D,
  channel: PartIdChannel,
  field: PartIdField,
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

  meshObject.userData[CHANNEL_CONFIG[channel].mapKey] = idMap;
  meshObject.userData["_propertyCache"] = propertyCache;
}

/**
 * 构建 partId（OID / PID）→ featureId 的映射：
 * OID → `_FEATURE_ID_0`（featureIds[0]），PID → `_FEATURE_ID_1`（featureIds[1]）
 * @param scene Scene object
 */
export function buildPartIdToFeatureIdMap(scene: Object3D): void {
  scene.traverse((meshObject) => {
    buildChannelPartIdMap(meshObject, "oid", "_oid");
    buildChannelPartIdMap(meshObject, "pid", "_pid");
  });
}

/** 读取 mesh 上指定通道的 idMap（partId → featureId） */
export function getPartIdMap(
  mesh: Mesh,
  channel: PartIdChannel,
): Record<number, number> | undefined {
  return mesh.userData?.[CHANNEL_CONFIG[channel].mapKey] as
    | Record<number, number>
    | undefined;
}

/** 读取 mesh / userData 上 featureIdAttribute 通道的 idMap（partId → featureId） */
export function getPartIdMapForFeatureAttribute(
  source: Mesh | Record<string, unknown>,
  featureIdAttribute: number,
): Record<number, number> | undefined {
  const userData =
    source instanceof Mesh
      ? source.userData
      : (source as Record<string, unknown>);
  const channel = featureIdAttributeToChannel(featureIdAttribute);
  return userData[CHANNEL_CONFIG[channel].mapKey] as
    | Record<number, number>
    | undefined;
}
