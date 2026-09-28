import { Box3, BufferAttribute, BufferGeometry, Sphere, Vector3 } from "three";
import type { Mesh } from "three";
import type { FeatureIdIndexData, IndexRange } from "../types";
import {
  featureIdAttributeName,
  resolveFeatureChannelOnMesh,
  type PartIdChannel,
} from "../features/channel";
import { getPartIdMap } from "../features/id-map";
import { createSplitIndexArray } from "./index-arrays";
import { getFeatureIdIndexCache, getFeatureSplitSourceIndex } from "./index-visibility";

type MergedSplitContext = {
  geometry: BufferGeometry;
  featureIdAttr: BufferAttribute;
  sourceIndex: ArrayLike<number>;
  indexCache: FeatureIdIndexData;
  /** 按 targetFids 顺序收集的 index 段（无 entry 的 fid 已剔除），与 totalIndexLength 严格一致 */
  entries: IndexRange[];
  totalIndexLength: number;
};

function resolveMergedSplitContext(
  originalMesh: Mesh,
  idSet: ReadonlySet<number>,
  channel: PartIdChannel,
): MergedSplitContext | null {
  const idMap = getPartIdMap(originalMesh, channel);
  if (!idMap) return null;

  const resolved = resolveFeatureChannelOnMesh(originalMesh, channel);
  if (!resolved) return null;

  const { geometry, featureIdAttr, featureIdConfig } = resolved;
  const attrName = featureIdAttributeName(
    featureIdConfig?.attribute ?? (channel === "pid" ? 1 : 0),
  );

  const targetFids = new Set<number>();
  for (const partId of idSet) {
    const fid = idMap[partId];
    if (fid !== undefined) {
      targetFids.add(fid);
    }
  }
  if (targetFids.size === 0) return null;

  const sourceIndex = getFeatureSplitSourceIndex(originalMesh, geometry);
  if (!sourceIndex || sourceIndex.length === 0) return null;

  const indexCache = getFeatureIdIndexCache(originalMesh, attrName);
  if (!indexCache) return null;
  const { featureIdIndexMap } = indexCache;

  const entries: IndexRange[] = [];
  let totalIndexLength = 0;
  for (const fid of targetFids) {
    const entry = featureIdIndexMap[fid];
    if (!entry) continue;
    entries.push(entry);
    totalIndexLength += entry.length;
  }
  if (totalIndexLength === 0) return null;

  return {
    geometry,
    featureIdAttr,
    sourceIndex,
    indexCache,
    entries,
    totalIndexLength,
  };
}

function computeLocalBBoxForIndexRanges(
  geometry: BufferGeometry,
  buffer: Uint16Array | Uint32Array,
  entries: IndexRange[],
): Box3 | null {
  const posAttr = geometry.getAttribute("position");
  if (!posAttr) return null;

  const positions = posAttr.array as Float32Array;
  const itemSize = posAttr.itemSize || 3;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const entry of entries) {
    const end = entry.offset + entry.length;
    for (let i = entry.offset; i < end; i++) {
      const base = buffer[i]! * itemSize;
      const x = positions[base]!;
      const y = positions[base + 1]!;
      const z = positions[base + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }

  if (minX === Infinity) return null;
  return new Box3(new Vector3(minX, minY, minZ), new Vector3(maxX, maxY, maxZ));
}

/** 合并多个 feature 的三角形为单一 BufferGeometry（共享顶点属性，index 为并集） */
function createGeometryForFeatureIdSet(
  context: MergedSplitContext,
): BufferGeometry | null {
  const {
    geometry: originalGeometry,
    indexCache,
    entries,
    totalIndexLength,
  } = context;
  const { buffer } = indexCache;

  const newGeometry = new BufferGeometry();
  const attributes = originalGeometry.attributes;
  for (const attributeName in attributes) {
    newGeometry.setAttribute(attributeName, attributes[attributeName]);
  }

  const newIndices = createSplitIndexArray(originalGeometry, totalIndexLength);
  let writeOffset = 0;
  for (const entry of entries) {
    newIndices.set(
      buffer.subarray(entry.offset, entry.offset + entry.length),
      writeOffset,
    );
    writeOffset += entry.length;
  }
  newGeometry.setIndex(new BufferAttribute(newIndices, 1));

  // 顶点属性与瓦片共享（全量顶点），不预设紧致包围盒会让 three 首帧对全量顶点
  // 懒计算 boundingSphere，且包围球会膨胀到整瓦片，导致 split mesh 视锥剔除失效
  const localBBox = computeLocalBBoxForIndexRanges(
    originalGeometry,
    buffer,
    entries,
  );
  if (localBBox) {
    newGeometry.boundingBox = localBBox;
    newGeometry.boundingSphere = localBBox.getBoundingSphere(new Sphere());
  }

  const sourceEdges = originalGeometry.userData.featureEdges as
    | import("../types").FeatureEdgeData
    | undefined;
  if (sourceEdges) {
    newGeometry.userData.featureEdges = sourceEdges;
  }

  return newGeometry;
}

/**
 * 按 partId 集合从瓦片 mesh 构建合并 split 几何（与瓦片共享顶点属性 + 独立 index），
 * channel 决定使用的 feature id 通道（oid → `_FEATURE_ID_0`，pid → `_FEATURE_ID_1`）。
 */
export function buildMergedSplitGeometryForTileMesh(
  originalMesh: Mesh,
  idSet: ReadonlySet<number>,
  channel: PartIdChannel,
): BufferGeometry | null {
  const context = resolveMergedSplitContext(originalMesh, idSet, channel);
  if (!context) return null;

  const newGeometry = createGeometryForFeatureIdSet(context);
  if (!newGeometry || newGeometry.attributes.position.count === 0) {
    return null;
  }

  return newGeometry;
}
