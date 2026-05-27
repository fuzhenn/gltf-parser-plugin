import { BufferAttribute, Mesh, Object3D } from "three";

/** 从 mesh 的 idMap 和 hiddenOids 构建需要隐藏的 feature ID 集合 */
function getHiddenFeatureIds(
  mesh: Mesh,
  hiddenOids: Set<number>
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

/** 对单个 mesh 应用可见性过滤（通过修改 index 排除隐藏的三角形） */
export function applyVisibilityToMesh(
  mesh: Mesh,
  hiddenOids: Set<number>
): void {
  const { meshFeatures } = mesh.userData;
  if (!meshFeatures?.featureIds?.length) return;

  const geometry = (meshFeatures.geometry ?? mesh.geometry) as import("three").BufferGeometry;
  const featureId = meshFeatures.featureIds[0];
  const featureIdAttr = geometry.getAttribute(
    `_feature_id_${featureId.attribute}`,
  );
  const index = geometry.index;

  if (!index || !featureIdAttr) return;

  const hiddenFeatureIds = getHiddenFeatureIds(mesh, hiddenOids);
  if (hiddenFeatureIds.size === 0) {
    restoreMeshIndex(mesh);
    return;
  }

  if (!(mesh.userData as any)._originalIndex) {
    (mesh.userData as any)._originalIndex = index.array.slice(0);
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
    const a = originalArray[i];
    const fid = featureIdAttr.getX(a);
    if (hiddenFeatureIds.has(fid)) continue;

    filtered[writeOffset++] = originalArray[i];
    filtered[writeOffset++] = originalArray[i + 1];
    filtered[writeOffset++] = originalArray[i + 2];
  }

  // TODO filterArrary缓存，因为长度一样
  const filteredArray = filtered.subarray(0, writeOffset);
  geometry.setIndex(new BufferAttribute(filteredArray, 1));
  geometry.index!.needsUpdate = true;
}

/** 恢复 mesh 的原始 index */
export function restoreMeshIndex(mesh: Mesh): void {
  const original = (mesh.userData as any)?._originalIndex;
  if (!original) return;

  const { meshFeatures } = mesh.userData;
  const geometry = (meshFeatures?.geometry ?? mesh.geometry) as import("three").BufferGeometry;
  if (!geometry?.index) return;

  geometry.setIndex(new BufferAttribute(original, 1));
  geometry.index!.needsUpdate = true;
}

/** 遍历 scene 中所有 tile mesh，应用可见性过滤 */
export function applyVisibilityToScene(
  scene: Object3D,
  hiddenOids: Set<number>
): void {
  const oidSet = hiddenOids;
  if (oidSet.size === 0) {
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
    if (
      mesh.userData?.meshFeatures &&
      mesh.userData?.structuralMetadata &&
      !mesh.userData?.isSplit
    ) {
      applyVisibilityToMesh(mesh, oidSet);
    }
  });
}
