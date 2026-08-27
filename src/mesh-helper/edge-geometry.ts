import type { BufferGeometry } from "three";

export type PrecomputedEdgeData = {
  /** LineSegments position buffer，每 6 个 float 为一条边 */
  positions: Float32Array;
  /** 每条边关联的源三角形索引；空数组表示已是裁剪后的叶子数据 */
  triangleIndices: Uint32Array;
  thresholdAngleDeg: number;
};

const registry = new WeakMap<BufferGeometry, PrecomputedEdgeData>();

export function registerPrecomputedEdges(
  geometry: BufferGeometry,
  data: PrecomputedEdgeData,
): void {
  registry.set(geometry, data);
}

export function getPrecomputedEdges(
  geometry: BufferGeometry,
): PrecomputedEdgeData | undefined {
  return registry.get(geometry);
}

/** 按源 mesh 三角形索引集合裁剪预计算边线 */
export function cropPrecomputedEdges(
  data: PrecomputedEdgeData,
  visibleTriangleIndices: Set<number>,
): Float32Array | null {
  if (data.triangleIndices.length === 0) {
    return data.positions.length > 0 ? data.positions : null;
  }

  const segmentCount = data.triangleIndices.length;
  const triIndices = data.triangleIndices;
  const positions = data.positions;

  let matchCount = 0;
  for (let i = 0; i < segmentCount; i++) {
    if (visibleTriangleIndices.has(triIndices[i]!)) matchCount++;
  }
  if (matchCount === 0) return null;

  const result = new Float32Array(matchCount * 6);
  let writePtr = 0;
  for (let i = 0; i < segmentCount; i++) {
    if (!visibleTriangleIndices.has(triIndices[i]!)) continue;
    const base = i * 6;
    result[writePtr++] = positions[base]!;
    result[writePtr++] = positions[base + 1]!;
    result[writePtr++] = positions[base + 2]!;
    result[writePtr++] = positions[base + 3]!;
    result[writePtr++] = positions[base + 4]!;
    result[writePtr++] = positions[base + 5]!;
  }
  return result;
}

/** 按 targetFids 裁剪预计算边线（Set 标记，一次遍历构建） */
export function cropPrecomputedEdgesForFids(
  data: PrecomputedEdgeData,
  triangleIndexMap: Record<number, { offset: number; length: number }>,
  triangleIndices: Uint32Array,
  targetFids: Set<number>,
): Float32Array | null {
  if (data.triangleIndices.length === 0) {
    return data.positions.length > 0 ? data.positions : null;
  }

  const visibleTriangles = new Set<number>();
  for (const fid of targetFids) {
    const entry = triangleIndexMap[fid];
    if (!entry) continue;
    const end = entry.offset + entry.length;
    for (let i = entry.offset; i < end; i++) {
      visibleTriangles.add(triangleIndices[i]!);
    }
  }

  const segmentCount = data.triangleIndices.length;
  const edgeTriIndices = data.triangleIndices;
  const positions = data.positions;

  let matchCount = 0;
  for (let i = 0; i < segmentCount; i++) {
    if (visibleTriangles.has(edgeTriIndices[i]!)) matchCount++;
  }
  if (matchCount === 0) return null;

  const result = new Float32Array(matchCount * 6);
  let writePtr = 0;
  for (let i = 0; i < segmentCount; i++) {
    if (!visibleTriangles.has(edgeTriIndices[i]!)) continue;
    const base = i * 6;
    result[writePtr++] = positions[base]!;
    result[writePtr++] = positions[base + 1]!;
    result[writePtr++] = positions[base + 2]!;
    result[writePtr++] = positions[base + 3]!;
    result[writePtr++] = positions[base + 4]!;
    result[writePtr++] = positions[base + 5]!;
  }
  return result;
}
