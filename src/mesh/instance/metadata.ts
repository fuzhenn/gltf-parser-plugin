import { StructuralMetadata } from "3d-tiles-renderer/plugins";
import type { InstanceData, MetadataTypedArray } from "../types";

const TRANSFORM_ATTRS = new Set(["TRANSLATION", "ROTATION", "SCALE"]);
const INSTANCE_CLASS_NAME = "InstanceMetadata";
const INSTANCE_TABLE_NAME = "instances";

function isMetadataTypedArray(value: unknown): value is MetadataTypedArray {
  return (
    value instanceof Float32Array ||
    value instanceof Float64Array ||
    value instanceof Int8Array ||
    value instanceof Int16Array ||
    value instanceof Int32Array ||
    value instanceof Uint8Array ||
    value instanceof Uint16Array ||
    value instanceof Uint32Array
  );
}

function getComponentType(array: MetadataTypedArray): string {
  if (array instanceof Float32Array) return "FLOAT32";
  if (array instanceof Float64Array) return "FLOAT64";
  if (array instanceof Int8Array) return "INT8";
  if (array instanceof Int16Array) return "INT16";
  if (array instanceof Int32Array) return "INT32";
  if (array instanceof Uint8Array) return "UINT8";
  if (array instanceof Uint16Array) return "UINT16";
  if (array instanceof Uint32Array) return "UINT32";
  return "FLOAT32";
}

function getMetadataType(itemSize: number): string {
  switch (itemSize) {
    case 1:
      return "SCALAR";
    case 2:
      return "VEC2";
    case 3:
      return "VEC3";
    case 4:
      return "VEC4";
    case 9:
      return "MAT3";
    case 16:
      return "MAT4";
    default:
      return "SCALAR";
  }
}

/**
 * 由 EXT_mesh_gpu_instancing 的实例属性数组构造 {@link StructuralMetadata}。
 *
 * 每个实例对应 property table 中的一行；实例索引即 feature id / row id。
 * TRANSLATION / ROTATION / SCALE 仅用于变换，不写入属性表。
 *
 * 构造方式与 3d-tiles-renderer 中 PropertyTableAccessor 读取逻辑一致：
 * schema.classes + propertyTables + buffers（values 为 buffers 下标）。
 */
export function buildStructuralMetadataFromInstanceData(
  instanceData: InstanceData,
): StructuralMetadata | null {
  const count = instanceData.count;
  if (!count || count <= 0) return null;

  const classProperties: Record<
    string,
    { type: string; componentType: string }
  > = {};
  const tableProperties: Record<string, { values: number }> = {};
  const buffers: ArrayBuffer[] = [];

  for (const key of Object.keys(instanceData)) {
    if (key === "count" || TRANSFORM_ATTRS.has(key)) continue;

    const array = instanceData[key];
    if (!isMetadataTypedArray(array)) continue;

    const itemSize = array.length / count;
    if (!Number.isInteger(itemSize) || itemSize < 1) continue;

    const type = getMetadataType(itemSize);
    const componentType = getComponentType(array);

    classProperties[key] = { type, componentType };
    tableProperties[key] = { values: buffers.length };

    // PropertyTableAccessor 按 ArrayBuffer 整段读取，需独立拷贝避免共享底层 buffer
    // TODO 为什么不支持 DataView
    buffers.push(
      array.buffer.slice(
        array.byteOffset,
        array.byteOffset + array.byteLength,
      ) as ArrayBuffer,
    );
    // buffers.push(
    //   new DataView(array.buffer, array.byteOffset, array.byteLength) as any
    // );
  }

  if (Object.keys(classProperties).length === 0) return null;

  const definition = {
    schema: {
      classes: {
        [INSTANCE_CLASS_NAME]: {
          properties: classProperties,
        },
      },
    },
    propertyTables: [
      {
        name: INSTANCE_TABLE_NAME,
        class: INSTANCE_CLASS_NAME,
        count,
        properties: tableProperties,
      },
    ],
    propertyTextures: [],
    propertyAttributes: [],
  };

  return new StructuralMetadata(definition, [], buffers);
}

/**
 * 从实例级 StructuralMetadata 构建 OID → 实例行号（feature id）映射。
 * 行号与 InstancedMesh 的 instanceId 一致。
 */
export function buildInstanceOidMap(
  structuralMetadata: StructuralMetadata,
  instanceCount: number,
  tableIndex = 0,
): Record<number, number> | null {
  const idMap: Record<number, number> = {};

  const readRow = structuralMetadata as unknown as {
    getPropertyTableData(
      tableIndex: number,
      id: number,
    ): Record<string, unknown>;
  };

  for (let instanceId = 0; instanceId < instanceCount; instanceId++) {
    try {
      const row = readRow.getPropertyTableData(tableIndex, instanceId);
      const oid = row._oid ?? row.oid ?? row.OID ?? row._OID ?? row._Oid;
      if (oid === undefined || oid === null) continue;
      const n = typeof oid === "number" ? oid : Number(oid);
      if (!Number.isNaN(n)) {
        idMap[n] = instanceId;
      }
    } catch {
      break;
    }
  }

  return Object.keys(idMap).length > 0 ? idMap : null;
}
