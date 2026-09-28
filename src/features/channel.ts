import type { BufferAttribute, BufferGeometry, Mesh } from "three";

/** OID 对应 `_FEATURE_ID_0`，PID 对应 `_FEATURE_ID_1` */
export type PartIdChannel = "oid" | "pid";

/**
 * oid/pid 双通道的统一元数据：
 * - featureIndex：meshFeatures.featureIds 中的下标
 * - mapKey：idMap 挂在 mesh.userData 上的键
 * - idKey / collectorKey / namePrefix：split mesh userData 字段与命名
 */
export const CHANNEL_CONFIG = {
  oid: {
    featureIndex: 0,
    mapKey: "_tile_oidMap",
    idKey: "oid",
    collectorKey: "collectorOids",
    namePrefix: "merged_features",
  },
  pid: {
    featureIndex: 1,
    mapKey: "_tile_pidMap",
    idKey: "pid",
    collectorKey: "collectorPids",
    namePrefix: "merged_pids",
  },
} as const;

export interface ResolvedFeatureChannel {
  geometry: BufferGeometry;
  featureIdAttr: BufferAttribute;
  featureIdConfig: {
    attribute?: number;
    propertyTable?: number;
  } | null;
}

/** feature id 顶点属性名（小写，与 loader 写入 geometry 的键一致） */
export function featureIdAttributeName(attribute: number): string {
  return `_feature_id_${attribute}`;
}

/**
 * 解析 OID/PID 通道对应的 feature id 顶点属性。
 * PID 在 meshFeatures.featureIds[1] 未声明时，回退读取 geometry 上的 `_feature_id_1`。
 */
export function resolveFeatureChannelOnMesh(
  mesh: Mesh,
  channel: PartIdChannel,
): ResolvedFeatureChannel | null {
  const { meshFeatures } = mesh.userData;
  if (!meshFeatures) return null;

  const geometry = meshFeatures.geometry ?? mesh.geometry;
  if (!geometry) return null;

  const cfg = CHANNEL_CONFIG[channel];
  const featureIds = meshFeatures.featureIds ?? [];
  const featureIdConfig = featureIds[cfg.featureIndex];

  if (featureIdConfig != null) {
    // 与原实现一致：attribute 未声明时查 `_feature_id_undefined`（必然 miss），
    // 由下方 pid 回退逻辑兜底，不在此处补默认值
    const attr = geometry.getAttribute(
      featureIdAttributeName(featureIdConfig.attribute as number),
    );
    if (attr) {
      return { geometry, featureIdAttr: attr, featureIdConfig };
    }
  }

  if (channel === "pid") {
    const attr = geometry.getAttribute(featureIdAttributeName(1));
    if (attr) {
      return {
        geometry,
        featureIdAttr: attr,
        featureIdConfig: featureIds[1] ?? null,
      };
    }
  }

  return null;
}

/** `_FEATURE_ID_N` 索引 → 内部 PartIdChannel（当前仅 0/1 有完整管线） */
export function featureIdAttributeToChannel(
  featureIdAttribute: number,
): PartIdChannel {
  return featureIdAttribute === 1 ? "pid" : "oid";
}
