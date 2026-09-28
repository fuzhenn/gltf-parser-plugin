import { StructuralMetadata } from "3d-tiles-renderer/plugins";
import type { Texture } from "three";
import type {
  GLTFNodeData,
  GLTFWorkerData,
  InstanceData,
} from "../types";
import type {
  InstanceFeatureId,
  InstanceFeatures,
  MetadataTypedArray,
} from "./types";

const EXT_INSTANCE_FEATURES = "EXT_instance_features";
const EXT_STRUCTURAL_METADATA = "EXT_structural_metadata";

function getInstanceFeatureAttributeName(attribute: number): string {
  return `_FEATURE_ID_${attribute}`;
}

/** 解析 feature id 属性数组；未声明 attribute（规范 implicit by index）时返回 undefined */
function resolveFeatureIdArray(
  instanceData: InstanceData,
  featureConfig: InstanceFeatureId,
): MetadataTypedArray | undefined {
  if (featureConfig.attribute === undefined) {
    return undefined;
  }
  const attrName = getInstanceFeatureAttributeName(featureConfig.attribute);
  return instanceData[attrName] as MetadataTypedArray | undefined;
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
  const featureIdArray = resolveFeatureIdArray(instanceData, featureConfig);
  return featureIdArray?.[instanceIndex] ?? instanceIndex;
}

/** 构建与 meshFeatures 类似的实例 feature 访问器；无 EXT_instance_features 时返回 null */
export function buildInstanceFeatures(
  nodeData: GLTFNodeData,
): InstanceFeatures | null {
  const ext = nodeData.extensions?.[EXT_INSTANCE_FEATURES];
  const instanceData = nodeData.instanceData;
  if (!ext?.featureIds || !instanceData) {
    return null;
  }

  // 浅拷贝，避免外部修改共享的 worker 数据
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
  textures: Texture[],
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
  const ext = nodeData.extensions?.[EXT_INSTANCE_FEATURES];
  const instanceData = nodeData.instanceData;
  const featureConfig = ext?.featureIds?.[featureIndex];
  if (!instanceData || !featureConfig || featureConfig.propertyTable === undefined) {
    return null;
  }
  const propertyTableIndex = featureConfig.propertyTable;

  // 属性数组在循环外解析一次，避免逐实例做属性名拼接与查找
  const featureIdArray = resolveFeatureIdArray(instanceData, featureConfig);

  // 访问 StructuralMetadata 内部的行读取能力（公共 API 未暴露）
  const metadataReader = structuralMetadata as unknown as {
    getPropertyTableData(
      tableIndex: number,
      id: number,
    ): Record<string, unknown>;
  };

  const idMap: Record<number, number> = {};
  const processedFeatureIds = new Set<number>();

  for (let instanceIndex = 0; instanceIndex < instanceData.count; instanceIndex++) {
    const featureId = featureIdArray?.[instanceIndex] ?? instanceIndex;

    // 同一 featureId 只读一次行（getPropertyTableData 会解码整行）
    if (processedFeatureIds.has(featureId)) continue;
    processedFeatureIds.add(featureId);

    try {
      const row = metadataReader.getPropertyTableData(
        propertyTableIndex,
        featureId,
      );
      const oid = row._oid as number;
      if (oid === undefined) continue;
      idMap[oid] = featureId;
    } catch {
      continue;
    }
  }

  return Object.keys(idMap).length > 0 ? idMap : null;
}
