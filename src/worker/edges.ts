/**
 * 特征边夹角阈值（度）：两面法线夹角超过该阈值的边视为特征边。
 * 阈值越大边越稀疏，仅保留更明显的折痕/轮廓；默认 30° 适配 CAD 模型。
 */
export const DEFAULT_FEATURE_EDGE_THRESHOLD_DEG = 30;

export type FeatureEdgePayload = {
  positions: Float32Array;
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
  triCount: number;
};

/** 嵌套 Map 查找/插入：外层存较小顶点索引，内层存较大顶点索引 */
function getOrCreateEdge(
  edges: Map<number, Map<number, EdgeAccum>>,
  v1: number,
  v2: number,
  nx: number,
  ny: number,
  nz: number,
): EdgeAccum {
  const lo = v1 < v2 ? v1 : v2;
  const hi = v1 < v2 ? v2 : v1;
  let inner = edges.get(lo);
  if (!inner) {
    inner = new Map<number, EdgeAccum>();
    edges.set(lo, inner);
  }
  let edge = inner.get(hi);
  if (!edge) {
    edge = { v1, v2, nx, ny, nz, triCount: 1 };
    inner.set(hi, edge);
    return edge;
  }
  edge.triCount++;
  if (edge.n2x === undefined) {
    edge.n2x = nx;
    edge.n2y = ny;
    edge.n2z = nz;
  }
  return edge;
}

/** 边界边（仅 1 个三角共享）或两面法线夹角超阈值 → 特征边 */
function isFeatureEdge(edge: EdgeAccum, thresholdDot: number): boolean {
  // n2x/n2y/n2z 总是同时赋值，此处仅满足 TS 收窄
  if (
    edge.triCount === 1 ||
    edge.n2x === undefined ||
    edge.n2y === undefined ||
    edge.n2z === undefined
  ) {
    return true;
  }
  const dot = edge.nx * edge.n2x + edge.ny * edge.n2y + edge.nz * edge.n2z;
  return dot < thresholdDot;
}

function computeBoundingDiagonal(positions: Float32Array): number {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return Math.sqrt(
    (maxX - minX) * (maxX - minX) +
      (maxY - minY) * (maxY - minY) +
      (maxZ - minZ) * (maxZ - minZ),
  );
}

/** 按坐标合并重复顶点，避免「每三角独立顶点」导致全部边被当作边界边 */
function weldVerticesByPosition(
  positions: Float32Array,
  indices: ArrayLike<number>,
  epsilon: number,
): { positions: Float32Array; indices: Uint32Array } {
  const invEpsilon = 1 / epsilon;
  const grid = new Map<number, Map<number, Map<number, number>>>();
  // 预分配上界：焊接后顶点数 ≤ 原顶点数，索引长度与输入一致，避免动态数组装箱与扩容
  const weldedPositions = new Float32Array(positions.length);
  const weldedIndices = new Uint32Array(indices.length);
  let vertexCount = 0;

  for (let i = 0; i < indices.length; i++) {
    const vi = indices[i];
    const x = positions[vi * 3];
    const y = positions[vi * 3 + 1];
    const z = positions[vi * 3 + 2];
    const gx = Math.round(x * invEpsilon);
    const gy = Math.round(y * invEpsilon);
    const gz = Math.round(z * invEpsilon);

    let weldedIndex: number | undefined;
    let xCell = grid.get(gx);
    if (xCell) {
      const yCell = xCell.get(gy);
      if (yCell) weldedIndex = yCell.get(gz);
    }
    if (weldedIndex === undefined) {
      weldedIndex = vertexCount;
      if (!xCell) {
        xCell = new Map<number, Map<number, number>>();
        grid.set(gx, xCell);
      }
      let yCell = xCell.get(gy);
      if (!yCell) {
        yCell = new Map<number, number>();
        xCell.set(gy, yCell);
      }
      yCell.set(gz, vertexCount);
      weldedPositions[vertexCount * 3] = x;
      weldedPositions[vertexCount * 3 + 1] = y;
      weldedPositions[vertexCount * 3 + 2] = z;
      vertexCount++;
    }
    weldedIndices[i] = weldedIndex;
  }

  return {
    // subarray 零拷贝截断；焊接结果仅函数内临时使用，尾部冗余无需回收
    positions: weldedPositions.subarray(0, vertexCount * 3),
    indices: weldedIndices,
  };
}

/**
 * 在 Worker 内预计算特征边（等价于 Three.js EdgesGeometry 的阈值逻辑，无 Three 依赖）。
 *
 * 优化：嵌套 Map 替代字符串键、消除动态数组、内联访问器、两遍扫描法输出。
 */
export function buildFeatureEdgePositions(
  rawPositions: Float32Array,
  rawIndices: ArrayLike<number>,
  thresholdAngleDeg = DEFAULT_FEATURE_EDGE_THRESHOLD_DEG,
): FeatureEdgePayload {
  const weldEpsilon = Math.max(
    computeBoundingDiagonal(rawPositions) * 1e-5,
    1e-6,
  );
  const welded = weldVerticesByPosition(rawPositions, rawIndices, weldEpsilon);
  const positions = welded.positions;
  const indices = welded.indices;

  const thresholdDot = Math.cos(thresholdAngleDeg * (Math.PI / 180));
  const edges = new Map<number, Map<number, EdgeAccum>>();

  const triCount = Math.floor(indices.length / 3);
  for (let t = 0; t < triCount; t++) {
    const ia = indices[t * 3];
    const ib = indices[t * 3 + 1];
    const ic = indices[t * 3 + 2];

    const ax = positions[ia * 3];
    const ay = positions[ia * 3 + 1];
    const az = positions[ia * 3 + 2];
    const bx = positions[ib * 3];
    const by = positions[ib * 3 + 1];
    const bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3];
    const cy = positions[ic * 3 + 1];
    const cz = positions[ic * 3 + 2];

    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;

    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    }

    getOrCreateEdge(edges, ia, ib, nx, ny, nz);
    getOrCreateEdge(edges, ib, ic, nx, ny, nz);
    getOrCreateEdge(edges, ic, ia, nx, ny, nz);
  }

  // 两遍扫描：先计数精确分配，再写入
  let edgeCount = 0;
  for (const inner of edges.values()) {
    for (const edge of inner.values()) {
      if (isFeatureEdge(edge, thresholdDot)) edgeCount++;
    }
  }

  const linePositions = new Float32Array(edgeCount * 6);
  let writePtr = 0;
  for (const inner of edges.values()) {
    for (const edge of inner.values()) {
      if (!isFeatureEdge(edge, thresholdDot)) continue;

      const v1x = positions[edge.v1 * 3];
      const v1y = positions[edge.v1 * 3 + 1];
      const v1z = positions[edge.v1 * 3 + 2];
      const v2x = positions[edge.v2 * 3];
      const v2y = positions[edge.v2 * 3 + 1];
      const v2z = positions[edge.v2 * 3 + 2];
      linePositions[writePtr] = v1x;
      linePositions[writePtr + 1] = v1y;
      linePositions[writePtr + 2] = v1z;
      linePositions[writePtr + 3] = v2x;
      linePositions[writePtr + 4] = v2y;
      linePositions[writePtr + 5] = v2z;
      writePtr += 6;
    }
  }

  return {
    positions: linePositions,
    thresholdAngleDeg,
  };
}
