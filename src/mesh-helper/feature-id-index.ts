import type { BufferAttribute } from "three";

export type FeatureIdIndexEntry = { offset: number; length: number };

/**
 * 按 featureId 分组后的 index 数据。
 * 正常路径由 worker 解析 tile 时预构建，主线程直接取用；
 * split / 显隐无需再遍历 sourceIndex 即可按 fid 拼接三角形。
 */
export type FeatureIdIndexData = {
  /** featureId → buffer 中的 {offset,length}（普通对象，省去 Map 的构造与遍历开销） */
  featureIdIndexMap: Record<number, FeatureIdIndexEntry>;
  /** 按 fid 连续排布的 index（与源 index 同类型） */
  buffer: Uint16Array | Uint32Array;
};

/**
 * 以 `_feature_id_n` 顶点属性的 BufferAttribute 为 key 的预构建分组 index 表。
 * 主线程从 worker 数据建几何时注册（见 build-mesh-primitives）。
 * 用 WeakMap：geometry 释放后对应条目自动回收。
 */
const registry = new WeakMap<BufferAttribute, FeatureIdIndexData>();

export function registerFeatureIdIndex(
  attr: BufferAttribute,
  data: FeatureIdIndexData,
): void {
  registry.set(attr, data);
}

export function getRegisteredFeatureIdIndex(
  attr: BufferAttribute,
): FeatureIdIndexData | undefined {
  return registry.get(attr);
}

export function createMatchingIndexArray(
  sourceIndex: ArrayLike<number>,
  length: number,
): Uint16Array | Uint32Array {
  if (sourceIndex instanceof Uint32Array) return new Uint32Array(length);
  if (sourceIndex instanceof Uint16Array) return new Uint16Array(length);
  return new Uint32Array(length);
}

/**
 * 按 fid 分组 index 的回退实现（主线程）。
 * 正常情况下 worker 已预构建并注册，仅当某 mesh 几何未携带预构建数据时才走这里。
 */
export function buildFeatureIdIndexMap(
  sourceIndex: ArrayLike<number>,
  featureIdAttr: BufferAttribute,
): FeatureIdIndexData {
  const fidChunks = new Map<number, number[]>();

  for (let i = 0; i < sourceIndex.length; i += 3) {
    const a = sourceIndex[i]!;
    const b = sourceIndex[i + 1]!;
    const c = sourceIndex[i + 2]!;
    const fid = featureIdAttr.getX(a);

    let chunk = fidChunks.get(fid);
    if (!chunk) {
      chunk = [];
      fidChunks.set(fid, chunk);
    }
    chunk.push(a, b, c);
  }

  let totalLength = 0;
  for (const chunk of fidChunks.values()) {
    totalLength += chunk.length;
  }

  const buffer = createMatchingIndexArray(sourceIndex, totalLength);
  const featureIdIndexMap: Record<number, FeatureIdIndexEntry> = {};
  let offset = 0;
  for (const [fid, chunk] of fidChunks) {
    buffer.set(chunk, offset);
    featureIdIndexMap[fid] = { offset, length: chunk.length };
    offset += chunk.length;
  }

  return { featureIdIndexMap, buffer };
}
