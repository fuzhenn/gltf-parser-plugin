import { Box3, Vector2 } from "three";
import type { Vector3 } from "three";
import type { StructureNode } from "../plugin-types";

/**
 * 射线法判断点是否在多边形内
 */
export function pointInPolygon(
  px: number,
  py: number,
  polygon: Vector2[],
): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x,
      yi = polygon[i].y;
    const xj = polygon[j].x,
      yj = polygon[j].y;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 判断两线段是否相交
 */
export function segmentsIntersect(
  ax1: number,
  ay1: number,
  ax2: number,
  ay2: number,
  bx1: number,
  by1: number,
  bx2: number,
  by2: number,
): boolean {
  const cross = (
    ox: number,
    oy: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ) => (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);

  const d1 = cross(bx1, by1, bx2, by2, ax1, ay1);
  const d2 = cross(bx1, by1, bx2, by2, ax2, ay2);
  const d3 = cross(ax1, ay1, ax2, ay2, bx1, by1);
  const d4 = cross(ax1, ay1, ax2, ay2, bx2, by2);

  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return true;
  }

  const onSeg = (
    px: number,
    py: number,
    qx: number,
    qy: number,
    rx: number,
    ry: number,
  ) =>
    Math.min(px, qx) <= rx &&
    rx <= Math.max(px, qx) &&
    Math.min(py, qy) <= ry &&
    ry <= Math.max(py, qy);

  if (d1 === 0 && onSeg(bx1, by1, bx2, by2, ax1, ay1)) return true;
  if (d2 === 0 && onSeg(bx1, by1, bx2, by2, ax2, ay2)) return true;
  if (d3 === 0 && onSeg(ax1, ay1, ax2, ay2, bx1, by1)) return true;
  if (d4 === 0 && onSeg(ax1, ay1, ax2, ay2, bx2, by2)) return true;

  return false;
}

/**
 * 判断多边形与矩形是否相交或包含
 */
export function polygonIntersectsRect(
  polygon: Vector2[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  const n = polygon.length;

  for (let i = 0; i < n; i++) {
    const p = polygon[i];
    if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
      return true;
    }
  }

  if (
    pointInPolygon(minX, minY, polygon) ||
    pointInPolygon(maxX, minY, polygon) ||
    pointInPolygon(maxX, maxY, polygon) ||
    pointInPolygon(minX, maxY, polygon)
  ) {
    return true;
  }

  const rx = [minX, maxX, maxX, minX];
  const ry = [minY, minY, maxY, maxY];

  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    for (let j = 0; j < 4; j++) {
      const k = (j + 1) % 4;
      if (segmentsIntersect(a.x, a.y, b.x, b.y, rx[j], ry[j], rx[k], ry[k])) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 将 structure 中的 bbox 数组转为 Box3。
 * 约定与 `selectByBox` 一致：`[minX, minY, minZ, maxX, maxY, maxZ]`，至少 6 个数。
 */
export function bboxArrayToBox3(bbox: number[] | undefined): Box3 | null {
  if (!bbox || bbox.length < 6) return null;
  const box = new Box3();
  box.min.set(bbox[0], bbox[1], bbox[2]);
  box.max.set(bbox[3], bbox[4], bbox[5]);
  return box;
}

/**
 * 从 OID 节点映射中按 Box3 范围筛选构件
 */
export function selectByBoxFromOidMap(
  oidNodeMap: Map<number, StructureNode>,
  box: Box3,
): number[] {
  const result: number[] = [];

  for (const [oid, node] of oidNodeMap) {
    const nodeBox = bboxArrayToBox3(node.bbox);
    if (!nodeBox) continue;
    if (box.intersectsBox(nodeBox)) {
      result.push(oid);
    }
  }

  return result;
}

/**
 * 从 OID 节点映射中按多边形（平面投影）范围筛选构件
 */
export function selectByPolygonFromOidMap(
  oidNodeMap: Map<number, StructureNode>,
  polygon: Vector3[],
  axis: "xy" | "xz" | "yz" = "xz",
): number[] {
  const result: number[] = [];
  const polygon2D: Vector2[] = polygon.map((p) => {
    switch (axis) {
      case "xy":
        return new Vector2(p.x, p.y);
      case "yz":
        return new Vector2(p.y, p.z);
      case "xz":
      default:
        return new Vector2(p.x, p.z);
    }
  });

  for (const [oid, node] of oidNodeMap) {
    if (!node.bbox || node.bbox.length < 6) continue;

    let minU: number, minV: number, maxU: number, maxV: number;
    switch (axis) {
      case "xy":
        minU = node.bbox[0];
        minV = node.bbox[1];
        maxU = node.bbox[3];
        maxV = node.bbox[4];
        break;
      case "xz":
        minU = node.bbox[0];
        minV = node.bbox[2];
        maxU = node.bbox[3];
        maxV = node.bbox[5];
        break;
      case "yz":
        minU = node.bbox[1];
        minV = node.bbox[2];
        maxU = node.bbox[4];
        maxV = node.bbox[5];
        break;
    }

    if (polygonIntersectsRect(polygon2D, minU, minV, maxU, maxV)) {
      result.push(oid);
    }
  }

  return result;
}
