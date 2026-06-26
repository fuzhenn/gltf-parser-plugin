import { BufferAttribute, Mesh, Object3D } from "three";
import type { TilesRenderer } from "3d-tiles-renderer";
import {
  buildVisibleIndexExcludingHiddenFids,
  forEachLoadedFeatureMesh,
  resolveFeatureChannelOnMesh,
  type PartIdChannel,
} from "./mesh";

/** 与 split / 高亮一致：仅改 meshFeatures.geometry（若无则用 mesh.geometry） */
function getVisibilityGeometry(mesh: Mesh): import("three").BufferGeometry | null {
  const { meshFeatures } = mesh.userData;
  const g =
    (meshFeatures?.geometry as import("three").BufferGeometry | undefined) ??
    (mesh.geometry as import("three").BufferGeometry | undefined);
  return g ?? null;
}

function getHiddenFeatureIdsForChannel(
  mesh: Mesh,
  hiddenIds: Set<number>,
  channel: PartIdChannel,
): Set<number> {
  const mapKey = channel === "oid" ? "idMap" : "pidMap";
  const idMap = mesh.userData?.[mapKey] as Record<number, number> | undefined;
  if (!idMap) return new Set();

  const hidden = new Set<number>();
  for (const partId of hiddenIds) {
    const fid = idMap[partId];
    if (fid !== undefined) hidden.add(fid);
  }
  return hidden;
}

function isTileFeatureSourceMesh(mesh: Mesh): boolean {
  return Boolean(
    mesh.userData?.meshFeatures &&
      mesh.userData?.structuralMetadata &&
      !mesh.userData?.isSplit,
  );
}

function setGeometryIndexFromArray(
  geometry: import("three").BufferGeometry,
  indexArray: Uint16Array | Uint32Array,
): void {
  geometry.setIndex(new BufferAttribute(indexArray, 1));
  geometry.index!.needsUpdate = true;
}

/** OID + PID 同时隐藏时，同一 oid fid 块内可能含不同 pid fid，需逐三角过滤 */
function buildVisibleIndexExcludingMultiChannelHiddenFids(
  sourceIndex: Uint16Array | Uint32Array,
  checks: Array<{
    featureIdAttr: { getX(index: number): number };
    hiddenFids: Set<number>;
  }>,
): Uint16Array | Uint32Array {
  const filtered =
    sourceIndex instanceof Uint32Array
      ? new Uint32Array(sourceIndex.length)
      : new Uint16Array(sourceIndex.length);

  let writeOffset = 0;
  for (let i = 0; i < sourceIndex.length; i += 3) {
    const vertexIndex = sourceIndex[i]!;
    let hide = false;
    for (const { featureIdAttr, hiddenFids } of checks) {
      if (hiddenFids.has(featureIdAttr.getX(vertexIndex))) {
        hide = true;
        break;
      }
    }
    if (hide) continue;

    filtered.set(sourceIndex.subarray(i, i + 3), writeOffset);
    writeOffset += 3;
  }

  return filtered.subarray(0, writeOffset);
}

/**
 * 对当前已加载的所有瓦片 feature mesh 应用显隐（按 mesh.uuid 去重）。
 * 同时遍历 tiles.group 与各 tile.engineData.scene。
 */
export function applyVisibilityToAllLoadedMeshes(
  tiles: TilesRenderer,
  hiddenOids: Set<number>,
  hiddenPids: Set<number> = new Set(),
): void {
  if (hiddenOids.size === 0 && hiddenPids.size === 0) {
    forEachLoadedFeatureMesh(tiles, (mesh) => restoreMeshIndex(mesh));
    return;
  }

  forEachLoadedFeatureMesh(tiles, (mesh) => {
    if (isTileFeatureSourceMesh(mesh)) {
      applyVisibilityToMesh(mesh, hiddenOids, hiddenPids);
    }
  });
}

/** 对单个 mesh 应用可见性过滤（通过修改 index 排除隐藏的三角形） */
export function applyVisibilityToMesh(
  mesh: Mesh,
  hiddenOids: Set<number>,
  hiddenPids: Set<number> = new Set(),
): void {
  const { meshFeatures } = mesh.userData;
  if (!meshFeatures?.featureIds?.length) return;

  const geometry = getVisibilityGeometry(mesh);
  if (!geometry) return;

  const oidResolved =
    hiddenOids.size > 0 ? resolveFeatureChannelOnMesh(mesh, "oid") : null;
  const pidResolved =
    hiddenPids.size > 0 ? resolveFeatureChannelOnMesh(mesh, "pid") : null;

  const oidFeatureAttr = oidResolved?.featureIdAttr ?? null;
  const pidFeatureAttr = pidResolved?.featureIdAttr ?? null;

  const index = geometry.index;

  if (!index) return;
  if (hiddenOids.size > 0 && !oidFeatureAttr) return;
  if (hiddenPids.size > 0 && !pidFeatureAttr) return;

  const hiddenOidFids = getHiddenFeatureIdsForChannel(mesh, hiddenOids, "oid");
  const hiddenPidFids = getHiddenFeatureIdsForChannel(mesh, hiddenPids, "pid");

  const needsOidHide =
    hiddenOids.size > 0 && hiddenOidFids.size > 0 && oidFeatureAttr;
  const needsPidHide =
    hiddenPids.size > 0 && hiddenPidFids.size > 0 && pidFeatureAttr;

  if (!needsOidHide && !needsPidHide) {
    restoreMeshIndex(mesh);
    return;
  }

  if (!(mesh.userData as { _originalIndex?: ArrayLike<number> })._originalIndex) {
    const src = index.array;
    (mesh.userData as { _originalIndex?: ArrayLike<number> })._originalIndex =
      src instanceof Uint32Array
        ? new Uint32Array(src)
        : src instanceof Uint16Array
          ? new Uint16Array(src)
          : new Uint32Array(Array.from(src));
  }
  const originalArray = (mesh.userData as { _originalIndex: Uint16Array | Uint32Array })
    ._originalIndex;

  let filteredArray: Uint16Array | Uint32Array;
  if (needsOidHide && needsPidHide) {
    filteredArray = buildVisibleIndexExcludingMultiChannelHiddenFids(
      originalArray,
      [
        { featureIdAttr: oidFeatureAttr!, hiddenFids: hiddenOidFids },
        { featureIdAttr: pidFeatureAttr!, hiddenFids: hiddenPidFids },
      ],
    );
  } else if (needsOidHide) {
    filteredArray = buildVisibleIndexExcludingHiddenFids(
      mesh,
      originalArray,
      oidFeatureAttr!,
      hiddenOidFids,
    );
  } else {
    filteredArray = buildVisibleIndexExcludingHiddenFids(
      mesh,
      originalArray,
      pidFeatureAttr!,
      hiddenPidFids,
    );
  }

  setGeometryIndexFromArray(geometry, filteredArray);
}

/** 恢复 mesh 的原始 index */
export function restoreMeshIndex(mesh: Mesh): void {
  const original = (mesh.userData as { _originalIndex?: Uint16Array | Uint32Array })
    ?._originalIndex;
  if (!original) return;

  const geometry = getVisibilityGeometry(mesh);
  if (!geometry) return;

  setGeometryIndexFromArray(geometry, original);
  delete (mesh.userData as { _originalIndex?: unknown })._originalIndex;
}

/** 遍历 scene 子树中所有 tile mesh，应用可见性过滤 */
export function applyVisibilityToScene(
  scene: Object3D,
  hiddenOids: Set<number>,
  hiddenPids: Set<number> = new Set(),
): void {
  if (hiddenOids.size === 0 && hiddenPids.size === 0) {
    scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.userData?.meshFeatures && !mesh.userData?.isSplit) {
        restoreMeshIndex(mesh);
      }
    });
    return;
  }

  scene.traverse((obj) => {
    const mesh = obj as Mesh;
    if (isTileFeatureSourceMesh(mesh)) {
      applyVisibilityToMesh(mesh, hiddenOids, hiddenPids);
    }
  });
}
