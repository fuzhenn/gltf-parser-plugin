import { InstancedMesh, Material } from "three";
import type { Mesh } from "three";
import {
  featureIdAttributeToChannel,
  isTileInstancedMesh,
  isTileMesh,
} from "../features";
import {
  addMeshUserData,
  buildMergedSplitGeometryForTileMesh,
  buildSplitInstancedMeshForTileMesh,
} from "../geometry";
import type { StyleAppearance } from "./appearance";
import { applyStyleAppearanceToSplitMesh } from "./appearance-apply";
import type { MaterialBuilder } from "../types";

/**
 * 按 matchedPartIds 从 tile mesh 构建拆分 mesh（普通网格走合并几何，实例网格走实例拆分），
 * 并应用 appearance；未命中或构建失败返回 null。
 */
export function buildSplitMeshForTileMesh(
  tileMesh: Mesh,
  matchedPartIds: Set<number>,
  featureIdAttribute: number,
  appearance: StyleAppearance,
  materialBuilder?: MaterialBuilder,
): Mesh | null {
  if (matchedPartIds.size === 0) return null;

  if (tileMesh instanceof InstancedMesh && isTileInstancedMesh(tileMesh)) {
    const instanced = buildSplitInstancedMeshForTileMesh(
      tileMesh,
      matchedPartIds,
      featureIdAttribute,
    );
    return instanced;
  }

  if (!isTileMesh(tileMesh)) return null;

  const channel = featureIdAttributeToChannel(featureIdAttribute);
  const geometry = buildMergedSplitGeometryForTileMesh(
    tileMesh,
    matchedPartIds,
    channel,
  );
  if (!geometry) return null;

  const splitMesh = applyStyleAppearanceToSplitMesh(
    geometry,
    tileMesh.material as Material,
    appearance,
    materialBuilder,
  );
  if (!splitMesh) return null;
  addMeshUserData(tileMesh, splitMesh, matchedPartIds, channel, {
    splitGeometryManagedByCache: true,
  });
  return splitMesh;
}
