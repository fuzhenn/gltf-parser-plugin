import { BufferAttribute, Mesh, Object3D } from "three";
import type { TilesRenderer } from "3d-tiles-renderer";

/** 与 split / 高亮一致：仅改 meshFeatures.geometry（若无则用 mesh.geometry） */
function getVisibilityGeometry(mesh: Mesh): import("three").BufferGeometry | null {
  const { meshFeatures } = mesh.userData;
  const g =
    (meshFeatures?.geometry as import("three").BufferGeometry | undefined) ??
    (mesh.geometry as import("three").BufferGeometry | undefined);
  return g ?? null;
}

/** 从 mesh 的 idMap 和 hiddenOids 构建需要隐藏的 feature ID 集合 */
function getHiddenFeatureIds(
  mesh: Mesh,
  hiddenOids: Set<number>,
): Set<number> {
  const idMap = mesh.userData?.idMap as Record<number, number> | undefined;
  if (!idMap) return new Set();

  const hidden = new Set<number>();
  for (const oid of hiddenOids) {
    const fid = idMap[oid];
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

function collectFeatureMeshesUnder(
  root: Object3D,
  out: Map<string, Mesh>,
): void {
  root.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.userData?.meshFeatures || mesh.userData?.isSplit) return;
    if (!out.has(mesh.uuid)) out.set(mesh.uuid, mesh);
  });
}

/**
 * 对当前已加载的所有瓦片 feature mesh 应用显隐（按 mesh.uuid 去重）。
 * 同时遍历 tiles.group 与各 tile.engineData.scene。
 */
export function applyVisibilityToAllLoadedMeshes(
  tiles: TilesRenderer,
  hiddenOids: Set<number>,
): void {
  const meshes = new Map<string, Mesh>();
  collectFeatureMeshesUnder(tiles.group, meshes);
  tiles.traverse((tile: unknown) => {
    const scene = (tile as { engineData?: { scene?: Object3D } }).engineData
      ?.scene;
    if (scene) collectFeatureMeshesUnder(scene, meshes);
    return true;
  }, null);

  if (hiddenOids.size === 0) {
    for (const mesh of meshes.values()) restoreMeshIndex(mesh);
    return;
  }

  for (const mesh of meshes.values()) {
    if (isTileFeatureSourceMesh(mesh)) {
      applyVisibilityToMesh(mesh, hiddenOids);
    }
  }
}

/** 对单个 mesh 应用可见性过滤（通过修改 index 排除隐藏的三角形） */
export function applyVisibilityToMesh(
  mesh: Mesh,
  hiddenOids: Set<number>,
): void {
  const { meshFeatures } = mesh.userData;
  if (!meshFeatures?.featureIds?.length) return;

  const geometry = getVisibilityGeometry(mesh);
  if (!geometry) return;

  const featureId = meshFeatures.featureIds[0];
  const featureIdAttr = geometry.getAttribute(
    `_feature_id_${featureId.attribute}`,
  );
  const index = geometry.index;

  if (!index || !featureIdAttr) return;

  const hiddenFeatureIds = getHiddenFeatureIds(mesh, hiddenOids);

  // 全局仍有隐藏 OID，但本 mesh 无对应 feature：不要 restore，避免冲掉其它 mesh 的过滤
  if (hiddenFeatureIds.size === 0) {
    if (hiddenOids.size === 0) restoreMeshIndex(mesh);
    return;
  }

  if (!(mesh.userData as any)._originalIndex) {
    const src = index.array;
    (mesh.userData as any)._originalIndex =
      src instanceof Uint32Array
        ? new Uint32Array(src)
        : src instanceof Uint16Array
          ? new Uint16Array(src)
          : new Uint32Array(Array.from(src));
  }
  const originalArray = (mesh.userData as any)._originalIndex as
    | Uint16Array
    | Uint32Array;

  const isUint32 = originalArray instanceof Uint32Array;
  const filtered = isUint32
    ? new Uint32Array(originalArray.length)
    : new Uint16Array(originalArray.length);

  let writeOffset = 0;
  for (let i = 0; i < originalArray.length; i += 3) {
    const a = originalArray[i]!;
    const fid = featureIdAttr.getX(a);
    if (hiddenFeatureIds.has(fid)) continue;

    filtered[writeOffset++] = originalArray[i];
    filtered[writeOffset++] = originalArray[i + 1];
    filtered[writeOffset++] = originalArray[i + 2];
  }

  const filteredArray = filtered.subarray(0, writeOffset);
  setGeometryIndexFromArray(geometry, filteredArray);
}

/** 恢复 mesh 的原始 index */
export function restoreMeshIndex(mesh: Mesh): void {
  const original = (mesh.userData as any)?._originalIndex;
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
): void {
  if (hiddenOids.size === 0) {
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
      applyVisibilityToMesh(mesh, hiddenOids);
    }
  });
}
