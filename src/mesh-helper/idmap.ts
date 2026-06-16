import { Mesh, Object3D } from "three";
import { resolveFeatureChannelOnMesh } from "./mesh";

const OID_FEATURE_INDEX = 0;

type IdMapUserDataKey = "idMap" | "pidMap";
type PropertyIdField = "_oid" | "_pid";

function extractPartIdFromPropertyData(
  data: Record<string, unknown>,
  propertyIdField: PropertyIdField,
): number | undefined {
  const candidates =
    propertyIdField === "_pid"
      ? [data._pid, data.pid, data.PID]
      : [data._oid, data.oid, data.OID];

  for (const value of candidates) {
    if (value === undefined || value === null) continue;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

function buildIdToFeatureIdMapForChannel(
  meshObject: Object3D,
  featureIndex: number,
  propertyIdField: PropertyIdField,
  userDataKey: IdMapUserDataKey,
): void {
  const { meshFeatures, structuralMetadata } = meshObject.userData;

  if (!meshFeatures || !structuralMetadata) return;

  const { geometry, featureIds } = meshFeatures;
  const featureIdConfig = featureIds[featureIndex];
  if (!featureIdConfig) return;

  const propertyTableIndex = featureIdConfig.propertyTable;
  if (propertyTableIndex === undefined) return;

  const featureAttribute = geometry.getAttribute(
    `_feature_id_${featureIdConfig.attribute}`,
  );
  if (!featureAttribute) return;

  const processedFeatureIds = new Set<number>();
  const idToFeatureIdMap: Record<number, number> = {};

  for (
    let vertexIndex = 0;
    vertexIndex < featureAttribute.count;
    vertexIndex++
  ) {
    const currentFeatureId = featureAttribute.getX(vertexIndex);

    if (processedFeatureIds.has(currentFeatureId)) {
      continue;
    }

    try {
      const featureData = structuralMetadata.getPropertyTableData(
        propertyTableIndex,
        currentFeatureId,
      ) as Record<string, unknown> | null | undefined;

      if (!featureData) continue;

      const partId = extractPartIdFromPropertyData(featureData, propertyIdField);
      if (partId === undefined) continue;

      idToFeatureIdMap[partId] = currentFeatureId;
      processedFeatureIds.add(currentFeatureId);
    } catch {
      continue;
    }
  }

  processedFeatureIds.clear();
  if (Object.keys(idToFeatureIdMap).length === 0) return;

  meshObject.userData[userDataKey] = idToFeatureIdMap;
}

/**
 * 构建 pidMap：PID → featureId（`_FEATURE_ID_1` 通道）
 *
 * 1. 有 propertyTable 时从属性表读 `_pid` / `pid`
 * 2. 无 propertyTable 或读失败时，以顶点 `_feature_id_1` 的值本身作为 PID
 */
function buildPidMap(meshObject: Object3D): void {
  const mesh = meshObject as Mesh;
  const { structuralMetadata } = mesh.userData;
  const resolved = resolveFeatureChannelOnMesh(mesh, "pid");
  if (!resolved) return;

  const { featureIdAttr, featureIdConfig } = resolved;
  const propertyTableIndex = featureIdConfig?.propertyTable;
  const processedFeatureIds = new Set<number>();
  const pidMap: Record<number, number> = {};

  for (let vertexIndex = 0; vertexIndex < featureIdAttr.count; vertexIndex++) {
    const currentFeatureId = featureIdAttr.getX(vertexIndex);
    if (processedFeatureIds.has(currentFeatureId)) continue;
    processedFeatureIds.add(currentFeatureId);

    let pid: number = currentFeatureId;

    if (structuralMetadata && propertyTableIndex !== undefined) {
      try {
        const featureData = structuralMetadata.getPropertyTableData(
          propertyTableIndex,
          currentFeatureId,
        ) as Record<string, unknown> | null | undefined;
        if (featureData) {
          const fromMeta = extractPartIdFromPropertyData(featureData, "_pid");
          if (fromMeta !== undefined) pid = fromMeta;
        }
      } catch {
        // 无属性表数据时回退为 feature id 即 pid
      }
    }

    pidMap[pid] = currentFeatureId;
  }

  if (Object.keys(pidMap).length === 0) return;
  meshObject.userData.pidMap = pidMap;
}

/**
 * Build mapping relationship from OID / PID to FeatureId
 * OID → `_FEATURE_ID_0`（featureIds[0]），PID → `_FEATURE_ID_1`（featureIds[1]）
 * @param scene Scene object
 */
function buildOidToFeatureIdMap(scene: Object3D): void {
  scene.traverse((meshObject: Object3D) => {
    buildIdToFeatureIdMapForChannel(
      meshObject,
      OID_FEATURE_INDEX,
      "_oid",
      "idMap",
    );
    buildPidMap(meshObject);
  });
}

export { buildOidToFeatureIdMap };
