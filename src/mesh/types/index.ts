export interface InstanceData {
  count: number;
  TRANSLATION?: Float32Array;
  ROTATION?: Float32Array;
  SCALE?: Float32Array;
  /** EXT_mesh_gpu_instancing 上的其它实例属性（如 _oid、_FEATURE_ID_0） */
  [attribute: string]:
    | number
    | Float32Array
    | Float64Array
    | Int8Array
    | Int16Array
    | Int32Array
    | Uint8Array
    | Uint16Array
    | Uint32Array
    | undefined;
}

export type MetadataTypedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array;
