import { Mesh, type Object3D } from "three";
import {
  CHANNEL_CONFIG,
  featureIdAttributeToChannel,
  resolveFeatureChannelOnMesh,
  type PartIdChannel,
} from "./channel";
import {
  getOrLoadFeatureData,
  type FeatureDataCache,
} from "./feature-data-cache";

type PartIdField = "_oid" | "_pid";

/**
 * partId → featureId 的高性能映射：Int32Array 直接寻址
 * （`data[partId - offset]`，-1 表示缺失）。featureId 约定为非负整数。
 */
export interface PartIdMap {
  /** 映射覆盖的最小 partId，data 下标 = partId - offset */
  offset: number;
  data: Int32Array;
}

/**
 * 由收集好的 (partId, featureId) 对构建映射。
 * 按 partId 值域 [min, max] 分配 Int32Array，O(1) 直接寻址、无哈希开销。
 */
export function buildPartIdMapFromEntries(
  partIds: number[],
  featureIds: number[],
): PartIdMap | null {
  const count = partIds.length;
  if (count === 0) return null;

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < count; i++) {
    const partId = partIds[i]!;
    if (partId < min) min = partId;
    if (partId > max) max = partId;
  }

  const data = new Int32Array(max - min + 1).fill(-1);
  for (let i = 0; i < count; i++) {
    data[partIds[i]! - min] = featureIds[i]!;
  }
  return { offset: min, data };
}

/** partId → featureId，缺失返回 undefined（数组寻址，无哈希开销） */
export function lookupFeatureId(
  idMap: PartIdMap,
  partId: number,
): number | undefined {
  const index = partId - idMap.offset;
  if (index < 0 || index >= idMap.data.length) return undefined;
  const fid = idMap.data[index]!;
  return fid >= 0 ? fid : undefined;
}

/** 遍历全部 partId（按下标直接递增，无 key 数组分配） */
export function forEachPartId(
  idMap: PartIdMap,
  cb: (partId: number) => void,
): void {
  const { data, offset } = idMap;
  for (let i = 0; i < data.length; i++) {
    if (data[i]! >= 0) cb(offset + i);
  }
}

/** 收集全部 partId（供需要数组形式的调用方，结果由调用方缓存） */
export function getPartIdsFromPartIdMap(idMap: PartIdMap): number[] {
  const out: number[] = [];
  forEachPartId(idMap, (partId) => out.push(partId));
  return out;
}

/**
 * 为 mesh 上单个通道构建 partId → featureId 映射并挂到 `userData[mapKey]`。
 *
 * 有属性表时先用轻量请求（仅取 `_oid` / `_pid` 字段）解析 partId，
 * 命中 `featureDataCache`（partId → 整行数据，由 GLTFParserPlugin 持有）
 * 则直接复用，否则按整行解码一次并写入缓存。
 */
function buildChannelPartIdMap(
  meshObject: Object3D,
  channel: PartIdChannel,
  field: PartIdField,
  featureDataCache: FeatureDataCache,
): void {
  const resolved = resolveFeatureChannelOnMesh(meshObject as Mesh, channel);
  if (!resolved) return;

  const { featureIdAttr, featureIdConfig } = resolved;
  const { structuralMetadata } = meshObject.userData;
  const propertyTableIndex = featureIdConfig?.propertyTable;
  // 无属性表或无元数据时无法建立映射，直接跳过
  if (propertyTableIndex === undefined || !structuralMetadata) return;

  const processedFeatureIds = new Set<number>();
  const partIdEntries: number[] = [];
  const fidEntries: number[] = [];

  for (let vertexIndex = 0; vertexIndex < featureIdAttr.count; vertexIndex++) {
    const featureId = featureIdAttr.getX(vertexIndex);
    // 每个 feature id 只处理一次；属性表解码是确定性的，失败重试没有意义
    if (processedFeatureIds.has(featureId)) continue;
    processedFeatureIds.add(featureId);

    try {
      // 轻量请求：只解码 partId 字段，避免整行解码开销
      const table = structuralMetadata.tableAccessors[propertyTableIndex];
      const partId = table.getPropertyValue(field, featureId);

      // 命中缓存直接复用，否则整行解码一次并写入缓存
      getOrLoadFeatureData(
        featureDataCache,
        partId,
        () =>
          structuralMetadata.getPropertyTableData(
            propertyTableIndex,
            featureId,
          ) as Record<string, unknown>,
      );

      partIdEntries.push(partId);
      fidEntries.push(featureId);
    } catch {
      // 属性表读取失败或行数据为空时跳过该 feature id
    }
  }

  const idMap = buildPartIdMapFromEntries(partIdEntries, fidEntries);
  if (!idMap) return;
  meshObject.userData[CHANNEL_CONFIG[channel].mapKey] = idMap;
}

/**
 * 构建 partId（OID / PID）→ featureId 的映射：
 * OID → `_FEATURE_ID_0`（featureIds[0]），PID → `_FEATURE_ID_1`（featureIds[1]）
 * @param scene Scene object
 * @param featureDataCache partId → 整行属性数据缓存（由 GLTFParserPlugin 实例持有）
 */
export function buildPartIdToFeatureIdMap(
  scene: Object3D,
  featureDataCache: FeatureDataCache,
): void {
  scene.traverse((meshObject) => {
    buildChannelPartIdMap(meshObject, "oid", "_oid", featureDataCache);
    buildChannelPartIdMap(meshObject, "pid", "_pid", featureDataCache);
  });
}

/** 读取 mesh 上指定通道的 idMap（partId → featureId） */
export function getPartIdMap(
  mesh: Mesh,
  channel: PartIdChannel,
): PartIdMap | undefined {
  return mesh.userData?.[CHANNEL_CONFIG[channel].mapKey] as
    | PartIdMap
    | undefined;
}

/** 读取 mesh / userData 上 featureIdAttribute 通道的 idMap（partId → featureId） */
export function getPartIdMapForFeatureAttribute(
  source: Mesh | Record<string, unknown>,
  featureIdAttribute: number,
): PartIdMap | undefined {
  const userData =
    source instanceof Mesh
      ? source.userData
      : (source as Record<string, unknown>);
  const channel = featureIdAttributeToChannel(featureIdAttribute);
  return userData[CHANNEL_CONFIG[channel].mapKey] as PartIdMap | undefined;
}

export function getPartIdsForFeatureAttribute(
  source: Mesh | Record<string, unknown>,
  featureIdAttribute: number,
): number[] {
  const userData =
    source instanceof Mesh
      ? source.userData
      : (source as Record<string, unknown>);
  const channel = featureIdAttributeToChannel(featureIdAttribute);
  const key = CHANNEL_CONFIG[channel].partIdsKey;
  if (!userData[key]) {
    const idMap = getPartIdMapForFeatureAttribute(userData, featureIdAttribute);
    userData[key] = idMap ? getPartIdsFromPartIdMap(idMap) : [];
  }
  return userData[key] as number[];
}
