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

  let maxTri = 0;
  for (const tri of visibleTriangleIndices) {
    if (tri > maxTri) maxTri = tri;
  }
  const flags = new Uint8Array(maxTri + 1);
  for (const tri of visibleTriangleIndices) {
    flags[tri] = 1;
  }

  const segmentCount = data.triangleIndices.length;
  const out: number[] = [];
  const triIndices = data.triangleIndices;
  const positions = data.positions;
  for (let i = 0; i < segmentCount; i++) {
    if (!flags[triIndices[i]!]) continue;
    const base = i * 6;
    out.push(
      positions[base]!,
      positions[base + 1]!,
      positions[base + 2]!,
      positions[base + 3]!,
      positions[base + 4]!,
      positions[base + 5]!,
    );
  }
  return out.length > 0 ? new Float32Array(out) : null;
}

/** 按 targetFids 裁剪预计算边线（位图标记，避免构建 Set） */
export function cropPrecomputedEdgesForFids(
  data: PrecomputedEdgeData,
  triangleIndexMap: Record<number, { offset: number; length: number }>,
  triangleIndices: Uint32Array,
  targetFids: Set<number>,
): Float32Array | null {
  if (data.triangleIndices.length === 0) {
    return data.positions.length > 0 ? data.positions : null;
  }

  let maxTri = 0;
  for (const fid of targetFids) {
    const entry = triangleIndexMap[fid];
    if (!entry) continue;
    const end = entry.offset + entry.length;
    for (let i = entry.offset; i < end; i++) {
      const tri = triangleIndices[i]!;
      if (tri > maxTri) maxTri = tri;
    }
  }
  const flags = new Uint8Array(maxTri + 1);
  for (const fid of targetFids) {
    const entry = triangleIndexMap[fid];
    if (!entry) continue;
    const end = entry.offset + entry.length;
    for (let i = entry.offset; i < end; i++) {
      flags[triangleIndices[i]!] = 1;
    }
  }

  const segmentCount = data.triangleIndices.length;
  const out: number[] = [];
  const edgeTriIndices = data.triangleIndices;
  const positions = data.positions;
  for (let i = 0; i < segmentCount; i++) {
    if (!flags[edgeTriIndices[i]!]) continue;
    const base = i * 6;
    out.push(
      positions[base]!,
      positions[base + 1]!,
      positions[base + 2]!,
      positions[base + 3]!,
      positions[base + 4]!,
      positions[base + 5]!,
    );
  }
  return out.length > 0 ? new Float32Array(out) : null;
}
