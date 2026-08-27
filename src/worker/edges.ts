/**
 * 特征边夹角阈值（度）：越大边越稀疏，仅保留更明显的折痕/轮廓。
 * 75° 在 CAD 模型上可过滤细分曲面三角化边，同时保留孔洞与折痕。
 */
export const DEFAULT_FEATURE_EDGE_THRESHOLD_DEG = 75;

export type WorkerPrecomputedEdgePayload = {
  positions: Float32Array;
  triangleIndices: Uint32Array;
  thresholdAngleDeg: number;
};

type EdgeAccum = {
  v1: number;
  v2: number;
  nx: number;
  ny: number;
  nz: number;
  n2x?: number;
  n2y?: number;
  n2z?: number;
  tris: number[];
};

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function computeBoundingDiagonal(positions: Float32Array): number {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
}

/** 按坐标合并重复顶点，避免「每三角独立顶点」导致全部边被当作边界边 */
function weldIndicesByPosition(
  positions: Float32Array,
  indices: ArrayLike<number>,
  epsilon: number,
): { positions: Float32Array; indices: Uint32Array } {
  const scale = 1 / epsilon;
  const keyToIndex = new Map<string, number>();
  const outPositions: number[] = [];
  const outIndices: number[] = [];

  for (let i = 0; i < indices.length; i++) {
    const vi = indices[i]!;
    const x = positions[vi * 3]!;
    const y = positions[vi * 3 + 1]!;
    const z = positions[vi * 3 + 2]!;
    const key = `${Math.round(x * scale)}:${Math.round(y * scale)}:${Math.round(z * scale)}`;
    let ni = keyToIndex.get(key);
    if (ni === undefined) {
      ni = outPositions.length / 3;
      keyToIndex.set(key, ni);
      outPositions.push(x, y, z);
    }
    outIndices.push(ni);
  }

  return {
    positions: new Float32Array(outPositions),
    indices: new Uint32Array(outIndices),
  };
}

/**
 * 在 Worker 内预计算特征边（等价于 Three.js EdgesGeometry 的阈值逻辑，无 Three 依赖）。
 * 每条边附带一个源 mesh 三角形索引，供 split 时裁剪。
 */
export function buildFeatureEdgePositions(
  positions: Float32Array,
  indices: ArrayLike<number>,
  thresholdAngleDeg = DEFAULT_FEATURE_EDGE_THRESHOLD_DEG,
): WorkerPrecomputedEdgePayload {
  const weldEpsilon = Math.max(
    computeBoundingDiagonal(positions) * 1e-5,
    1e-6,
  );
  const welded = weldIndicesByPosition(positions, indices, weldEpsilon);
  positions = welded.positions;
  indices = welded.indices;

  const thresholdDot = Math.cos(thresholdAngleDeg * (Math.PI / 180));
  const edges = new Map<string, EdgeAccum>();

  const getX = (i: number) => positions[i * 3]!;
  const getY = (i: number) => positions[i * 3 + 1]!;
  const getZ = (i: number) => positions[i * 3 + 2]!;

  const triCount = Math.floor(indices.length / 3);
  for (let t = 0; t < triCount; t++) {
    const ia = indices[t * 3]!;
    const ib = indices[t * 3 + 1]!;
    const ic = indices[t * 3 + 2]!;

    const abx = getX(ib) - getX(ia);
    const aby = getY(ib) - getY(ia);
    const abz = getZ(ib) - getZ(ia);
    const acx = getX(ic) - getX(ia);
    const acy = getY(ic) - getY(ia);
    const acz = getZ(ic) - getZ(ia);

    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    }

    const pairs: [number, number][] = [
      [ia, ib],
      [ib, ic],
      [ic, ia],
    ];
    for (const [v1, v2] of pairs) {
      const key = edgeKey(v1, v2);
      let info = edges.get(key);
      if (!info) {
        info = { v1, v2, nx, ny, nz, tris: [t] };
        edges.set(key, info);
        continue;
      }
      info.tris.push(t);
      if (info.n2x === undefined) {
        info.n2x = nx;
        info.n2y = ny;
        info.n2z = nz;
      }
    }
  }

  const lineVerts: number[] = [];
  const triIndices: number[] = [];

  for (const info of edges.values()) {
    let draw = false;
    if (info.tris.length === 1 || info.n2x === undefined) {
      draw = true;
    } else {
      const dot =
        info.nx * info.n2x! +
        info.ny * info.n2y! +
        info.nz * info.n2z!;
      if (dot < thresholdDot) draw = true;
    }
    if (!draw || info.tris.length === 0) continue;

    lineVerts.push(
      getX(info.v1),
      getY(info.v1),
      getZ(info.v1),
      getX(info.v2),
      getY(info.v2),
      getZ(info.v2),
    );
    triIndices.push(info.tris[0]!);
  }

  return {
    positions: new Float32Array(lineVerts),
    triangleIndices: new Uint32Array(triIndices),
    thresholdAngleDeg,
  };
}
