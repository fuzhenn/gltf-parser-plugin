import { BufferAttribute } from "three";
import type { BufferGeometry, Mesh } from "three";
import type { FeatureIdIndexData } from "../types";
import { featureIdAttributeName } from "../features/channel";

/** 取 worker 预构建并挂在 mesh.userData 上的按 fid 分组 index。 */
export function getFeatureIdIndexCache(
  mesh: Mesh,
  attrName: string,
): FeatureIdIndexData | undefined {
  return mesh.userData._featureIdIndexCaches?.[attrName];
}

/**
 * split 必须从「隐藏原片前」的完整 index 抽取三角形。
 * 显隐规则会改写 `geometry.index`；若用当前 index，被隐藏构件的三角已被删掉 → split 为空。
 */
/** 完整 index（优先 userData 备份），供 split / hide 使用 */
export function getFeatureSplitSourceIndex(
  tileMesh: Mesh,
  geometry: BufferGeometry,
): ArrayLike<number> | null {
  const stored = tileMesh.userData._originalIndex;
  if (stored instanceof BufferAttribute) {
    const arr = stored.array;
    if (arr && arr.length > 0) return arr;
  }
  return geometry.index?.array ?? null;
}

/**
 * 首次过滤前把 geometry.index 的属性对象引用备份到 userData._originalIndex，
 */
export function snapshotOriginalIndex(
  mesh: Mesh,
  geometry: BufferGeometry,
): BufferAttribute | null {
  const stored = mesh.userData._originalIndex;
  if (stored instanceof BufferAttribute) return stored;
  const current = geometry.index;
  if (!current) return null;
  mesh.userData._originalIndex = current;
  return current;
}

/** 排除 hiddenFids 后，按 fid 索引表拼接可见 index */
export function buildVisibleIndex(
  mesh: Mesh,
  sourceIndex: ArrayLike<number>,
  attrName: string,
  hiddenFids: Set<number>,
): Uint16Array | Uint32Array {
  const cache = getFeatureIdIndexCache(mesh, attrName);
  if (!cache) return new Uint32Array(0);

  const { featureIdIndexMap, buffer } = cache;

  let totalLength = 0;
  const indexRanges: { offset: number; length: number }[] = [];
  for (const [fidKey, entry] of Object.entries(featureIdIndexMap)) {
    if (!hiddenFids.has(Number(fidKey))) {
      totalLength += entry.length;
      indexRanges.push(entry);
    }
  }

  const result =
    sourceIndex instanceof Uint16Array
      ? new Uint16Array(totalLength)
      : new Uint32Array(totalLength);
  let writeOffset = 0;
  for (const range of indexRanges) {
    result.set(
      buffer.subarray(range.offset, range.offset + range.length),
      writeOffset,
    );
    writeOffset += range.length;
  }
  return result;
}

// ---------- 普通mesh 的按 feature 隐藏（走 index 过滤） ----------

export function hideMatchedFeaturesOnTileMesh(
  mesh: Mesh,
  featureIdAttribute: number | undefined,
  hiddenFids: Set<number>,
): void {
  const geometry = mesh.geometry;
  const index = geometry?.index;
  if (!index) return;

  if (featureIdAttribute === undefined || hiddenFids.size === 0) {
    restoreOriginalIndex(mesh, geometry);
    return;
  }

  const original = snapshotOriginalIndex(mesh, geometry);
  if (!original) return;

  const filtered = buildVisibleIndex(
    mesh,
    original.array,
    featureIdAttributeName(featureIdAttribute),
    hiddenFids,
  );
  setFilteredIndex(mesh, geometry, original, filtered);
}

function disposeStyleFilteredIndex(
  mesh: Mesh,
  original: BufferAttribute,
): void {
  const filtered = mesh.userData._styleFilteredIndex as
    | BufferAttribute
    | undefined;
  if (filtered && filtered !== original) {
    filtered.dispose();
  }
  mesh.userData._styleFilteredIndex = undefined;
}

function setFilteredIndex(
  mesh: Mesh,
  geometry: BufferGeometry,
  original: BufferAttribute,
  filteredArray: Uint16Array | Uint32Array,
): void {
  disposeStyleFilteredIndex(mesh, original);
  const attr = new BufferAttribute(filteredArray, 1);
  mesh.userData._styleFilteredIndex = attr;
  geometry.setIndex(attr);
}

function restoreOriginalIndex(mesh: Mesh, geometry: BufferGeometry): void {
  const original = mesh.userData._originalIndex;
  if (!(original instanceof BufferAttribute)) return;
  disposeStyleFilteredIndex(mesh, original);
  geometry.setIndex(original);
}
