import { InstancedMesh, Material } from "three";
import type { BufferGeometry, Mesh } from "three";
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
import { disposeUnsharedGeometryResources } from "./split-cache";
import type { MaterialBuilder } from "../types";
import type { FeatureDataCache } from "../features";

/** 构建结果：mesh + 可登记为本组共享的托管几何 */
export interface SplitMeshBuildResult {
  mesh: Mesh;
  /** mesh 实际挂载的托管合并几何（可登记为本组共享）；实例网格路径或工厂替换几何时为 null */
  geometry: BufferGeometry | null;
}

/**
 * 按 matchedPartIds 从 tile mesh 构建拆分 mesh（普通网格走合并几何，实例网格走实例拆分），
 * 并应用 appearance；未命中或构建失败返回 null。
 *
 * @param sharedGeometry 组内共享几何（同组命中集一致 → 合并几何一致）。
 *   传入时跳过几何构建直接复用；工厂替换了几何时原样返回替换后的 mesh，
 *   由调用方检测 `mesh.geometry !== sharedGeometry` 裁定共享退化。
 */
export function buildSplitMeshForTileMesh(
  tileMesh: Mesh,
  matchedPartIds: Set<number>,
  featureIdAttribute: number,
  appearance: StyleAppearance,
  materialBuilder?: MaterialBuilder,
  featureDataCache?: FeatureDataCache,
  sharedGeometry?: BufferGeometry,
): SplitMeshBuildResult | null {
  if (matchedPartIds.size === 0) return null;

  if (tileMesh instanceof InstancedMesh && isTileInstancedMesh(tileMesh)) {
    const instanced = buildSplitInstancedMeshForTileMesh(
      tileMesh,
      matchedPartIds,
      featureIdAttribute,
      featureDataCache,
    );
    return instanced ? { mesh: instanced, geometry: null } : null;
  }

  if (!isTileMesh(tileMesh)) return null;

  const channel = featureIdAttributeToChannel(featureIdAttribute);
  const geometry =
    sharedGeometry ??
    buildMergedSplitGeometryForTileMesh(
      tileMesh,
      matchedPartIds,
      channel,
    );
  if (!geometry) return null;
  if (!sharedGeometry && geometry.attributes.position.count === 0) {
    disposeUnsharedGeometryResources(geometry, tileMesh.geometry);
    return null;
  }

  const splitMesh = applyStyleAppearanceToSplitMesh(
    geometry,
    tileMesh.material as Material,
    appearance,
    materialBuilder,
  );
  if (!splitMesh) {
    // 新构建的几何失去主人，按需释放（共享输入的生命周期归调用方裁定）
    if (!sharedGeometry) {
      disposeUnsharedGeometryResources(geometry, tileMesh.geometry);
    }
    return null;
  }
  // mesh 工厂按约定可替换 geometry：被替换的新构建几何随之释放
  // （共享输入由调用方检测退化并裁定，此处不动）
  if (!sharedGeometry && splitMesh.geometry !== geometry) {
    disposeUnsharedGeometryResources(geometry, tileMesh.geometry);
  }
  addMeshUserData(tileMesh, splitMesh, matchedPartIds, channel, {
    splitGeometryManagedByCache: true,
  }, featureDataCache);
  return {
    mesh: splitMesh,
    geometry: splitMesh.geometry === geometry ? geometry : null,
  };
}
