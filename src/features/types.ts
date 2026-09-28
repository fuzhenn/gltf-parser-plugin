export type MetadataTypedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array;

/** EXT_instance_features.featureIds 单项 */
export interface InstanceFeatureId {
  featureCount: number;
  propertyTable?: number;
  nullFeatureId?: number;
  label?: string;
  /** 对应 EXT_mesh_gpu_instancing.attributes 中的 `_FEATURE_ID_<attribute>` */
  attribute?: number;
}

export interface InstanceFeatures {
  featureIds: InstanceFeatureId[];
  getFeatureId(featureIndex: number, instanceIndex: number): number;
}
