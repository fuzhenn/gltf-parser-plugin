import { StructuralMetadata } from "3d-tiles-renderer/plugins";
import type { Texture } from "three";
import type { GLTFNodeData, GLTFWorkerData } from "../../types";
import type {
  InstanceData,
  InstanceFeatureId,
  InstanceFeatures,
  MetadataTypedArray,
} from "../types";

const EXT_INSTANCE_FEATURES = "EXT_instance_features";
const EXT_STRUCTURAL_METADATA = "EXT_structural_metadata";

function getInstanceFeatureAttributeName(attribute: number): string {
  return `_FEATURE_ID_${attribute}`;
}

/**
 * 按 EXT_instance_features 读取单个实例的 feature id。
 * 未声明 attribute 时，feature id 即为 instanceIndex（规范 implicit by index）。
 */
export function getInstanceFeatureId(
  instanceData: InstanceData,
  featureConfig: InstanceFeatureId,
  instanceIndex: number,
): number {
  const attrName = getInstanceFeatureAttributeName(featureConfig.attribute!);
  const array = instanceData[attrName] as MetadataTypedArray;
  return array[instanceIndex];
}

/** 构建与 meshFeatures 类似的实例 feature 访问器 */
export function buildInstanceFeatures(
  nodeData: GLTFNodeData,
): InstanceFeatures | null {
  const ext = nodeData.extensions?.[EXT_INSTANCE_FEATURES]!;
  const instanceData = nodeData.instanceData!;
  const featureIds = ext.featureIds.map((info) => ({ ...info }));

  return {
    featureIds,
    getFeatureId(featureIndex: number, instanceIndex: number) {
      const config = featureIds[featureIndex];
      if (!config) return instanceIndex;
      return getInstanceFeatureId(instanceData, config, instanceIndex);
    },
  };
}

/**
 * 由 Worker 预加载的根级 EXT_structural_metadata 构建 StructuralMetadata。
 */
export function buildInstanceStructuralMetadata(
  data: GLTFWorkerData,
  textures: (Texture | null)[],
): StructuralMetadata | null {
  const loaded = data.structuralMetadata;
  if (!loaded?.schema) return null;

  const rootExtension = data.json?.extensions?.[EXT_STRUCTURAL_METADATA];

  return new StructuralMetadata(
    {
      schema: loaded.schema,
      propertyTables: loaded.propertyTables || [],
      propertyTextures: rootExtension?.propertyTextures || [],
      propertyAttributes: rootExtension?.propertyAttributes || [],
    },
    textures,
    loaded.buffers || [],
  );
}

/**
 * 借助 EXT_instance_features 构建 OID → featureId（property table 行号）映射。
 * 与普通 mesh 的 `_tile_oidMap` 语义一致，而非 instanceIndex。
 */
export function buildInstanceOidMap(
  nodeData: GLTFNodeData,
  structuralMetadata: StructuralMetadata,
  featureIndex = 0,
): Record<number, number> | null {
  const ext = nodeData.extensions?.[EXT_INSTANCE_FEATURES]!;
  const instanceData = nodeData.instanceData!;

  const featureConfig = ext.featureIds[featureIndex];
  const propertyTableIndex = featureConfig.propertyTable as number;

  const readRow = structuralMetadata as unknown as {
    getPropertyTableData(
      tableIndex: number,
      id: number,
    ): Record<string, unknown>;
  };

  const idMap: Record<number, number> = {};
  const processedFeatureIds = new Set<number>();

  for (
    let instanceIndex = 0;
    instanceIndex < instanceData.count;
    instanceIndex++
  ) {
    const featureId = getInstanceFeatureId(
      instanceData,
      featureConfig,
      instanceIndex,
    );

    if (processedFeatureIds.has(featureId)) continue;
    processedFeatureIds.add(featureId);

    try {
      const row = readRow.getPropertyTableData(propertyTableIndex, featureId);
      const oid = row._oid as number;
      if (oid === undefined) continue;
      idMap[oid] = featureId;
    } catch {
      continue;
    }
  }

  return Object.keys(idMap).length > 0 ? idMap : null;
}
