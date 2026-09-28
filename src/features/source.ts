import { InstancedMesh, Mesh, Object3D } from "three";
import type { TilesRenderer } from "3d-tiles-renderer";

/** 瓦片内原始普通 mesh（非 InstancedMesh、非 split） */
export function isTileMesh(obj: Object3D): obj is Mesh {
  return (
    obj instanceof Mesh &&
    !(obj instanceof InstancedMesh) &&
    !!obj.userData.meshFeatures &&
    !!obj.userData.structuralMetadata &&
    !obj.userData._isSplit
  );
}

export function isTileInstancedMesh(obj: Object3D): obj is InstancedMesh {
  return (
    obj instanceof InstancedMesh &&
    !!obj.userData.instanceFeatures &&
    !!obj.userData.structuralMetadata &&
    !obj.userData._isSplit
  );
}

/**
 * 遍历当前已加载的瓦片 feature 源（普通 mesh + InstancedMesh，按 uuid 去重）。
 */
export function forEachLoadedFeatureSource(
  tiles: TilesRenderer,
  fn: (source: Mesh | InstancedMesh) => void,
): void {
  const seen = new Set<string>();
  const visitRoot = (root: Object3D) => {
    root.traverse((child) => {
      if (
        (!isTileMesh(child) && !isTileInstancedMesh(child)) ||
        seen.has(child.uuid)
      )
        return;
      seen.add(child.uuid);
      fn(child);
    });
  };
  visitRoot(tiles.group);
  tiles.traverse((tile: unknown) => {
    const scene = (tile as { engineData?: { scene?: Object3D } }).engineData
      ?.scene;
    if (scene) visitRoot(scene);
    return true;
  }, null);
}

/** 收集 scene 内全部瓦片 feature 源（普通 mesh + InstancedMesh） */
export function collectTileMeshesFromScene(scene: Object3D): Mesh[] {
  const tileMeshes: Mesh[] = [];
  scene.traverse((child) => {
    if (isTileMesh(child) || isTileInstancedMesh(child)) {
      tileMeshes.push(child as Mesh);
    }
  });
  return tileMeshes;
}
