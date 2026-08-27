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
  /** fid → 源 mesh 三角形索引（offset/length 指向 triangleIndices 缓冲） */
  triangleIndexMap?: Record<number, FeatureIdIndexEntry>;
  triangleIndices?: Uint32Array;
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
 * 采用两遍扫描法：第一遍仅计数，第二遍直接写入预分配 TypedArray，
 * 消除 number[] 动态数组 + push + set(number[]) 的二次拷贝开销。
 */
export function buildFeatureIdIndexMap(
  sourceIndex: ArrayLike<number>,
  featureIdAttr: BufferAttribute,
): FeatureIdIndexData {
  const fidCounts = new Map<number, { indexCount: number; triCount: number }>();

  for (let i = 0; i < sourceIndex.length; i += 3) {
    const a = sourceIndex[i]!;
    const fid = featureIdAttr.getX(a);
    let counts = fidCounts.get(fid);
    if (!counts) {
      counts = { indexCount: 0, triCount: 0 };
      fidCounts.set(fid, counts);
    }
    counts.indexCount += 3;
    counts.triCount++;
  }

  const featureIdIndexMap: Record<number, FeatureIdIndexEntry> = {};
  const triangleIndexMap: Record<number, FeatureIdIndexEntry> = {};
  let totalLength = 0;
  let triTotal = 0;
  let offset = 0;
  let triOffset = 0;
  for (const [fid, counts] of fidCounts) {
    featureIdIndexMap[fid] = { offset, length: counts.indexCount };
    triangleIndexMap[fid] = { offset: triOffset, length: counts.triCount };
    offset += counts.indexCount;
    triOffset += counts.triCount;
    totalLength += counts.indexCount;
    triTotal += counts.triCount;
  }

  const buffer = createMatchingIndexArray(sourceIndex, totalLength);
  const triangleIndices = new Uint32Array(triTotal);

  const writePositions = new Map<number, { idx: number; tri: number }>();
  let triIndex = 0;
  for (let i = 0; i < sourceIndex.length; i += 3) {
    const a = sourceIndex[i]!;
    const b = sourceIndex[i + 1]!;
    const c = sourceIndex[i + 2]!;
    const fid = featureIdAttr.getX(a);

    let wp = writePositions.get(fid);
    if (!wp) {
      wp = { idx: 0, tri: 0 };
      writePositions.set(fid, wp);
    }

    const fidEntry = featureIdIndexMap[fid]!;
    const triEntry = triangleIndexMap[fid]!;

    buffer[fidEntry.offset + wp.idx] = a;
    buffer[fidEntry.offset + wp.idx + 1] = b;
    buffer[fidEntry.offset + wp.idx + 2] = c;
    wp.idx += 3;

    triangleIndices[triEntry.offset + wp.tri] = triIndex;
    wp.tri++;
    triIndex++;
  }

  return { featureIdIndexMap, buffer, triangleIndexMap, triangleIndices };
}

/** 按 targetFids 合并预构建的源 mesh 三角形索引（O(目标 fid 三角数)，不扫全 mesh） */
export function collectTriangleIndicesForFids(
  indexData: FeatureIdIndexData,
  targetFids: Set<number>,
): Set<number> {
  const { triangleIndexMap, triangleIndices } = indexData;
  const triangles = new Set<number>();
  if (!triangleIndexMap || !triangleIndices) return triangles;

  for (const fid of targetFids) {
    const entry = triangleIndexMap[fid];
    if (!entry) continue;
    const end = entry.offset + entry.length;
    for (let i = entry.offset; i < end; i++) {
      triangles.add(triangleIndices[i]!);
    }
  }
  return triangles;
}
