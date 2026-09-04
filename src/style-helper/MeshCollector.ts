// 1.meshCollector 构造函数需要参数：Conditional
// 2.meshCollector applyStyle(scene: Object3D); plugin : load-model / setStyle
//                 dispose();
//                 getSplitMesh(tileMesh); 返回该瓦片上本 collector 的 split mesh

import { InstancedMesh, Material, Mesh, Object3D } from "three";
import {
  buildStyleConditionEvaluatorMap,
  evaluateStyleCondition,
  resolveStyleConditionFeatureIdAttribute,
} from "../appearance";
import {
  buildMergedSplitGeometryForTileMesh,
  buildMergedSplitGeometryForTileMeshByPids,
  createMergedSplitMeshFromGeometry,
  createMergedSplitMeshFromGeometryByPids,
  featureIdAttributeToChannel,
  getPartIdMapForFeatureAttribute,
  getPropertyDataFromUserData,
  isTileInstancedMesh,
  isTileMesh,
} from "../mesh-helper";
import { buildSplitInstancedMeshForTileMesh } from "../mesh-helper/instance-split";
import type { StyleCondition } from "../appearance";

import {
  buildMatchCacheKey,
  buildSplitCacheKey,
  getCachedSplitMeshFromTileMesh,
  setCachedSplitMeshOnTileMesh,
  getCachedMatchedFeatureIds,
  setCachedMatchedFeatureIds,
  collectTileMeshesFromScene,
  releaseConditionCache,
  attachSplitMeshToTileMeshParent,
} from "./utils";

function collectPartIdsFromTileMesh(
  tileMesh: Mesh,
  featureIdAttribute: number,
): number[] {
  const idMap = getPartIdMapForFeatureAttribute(tileMesh, featureIdAttribute);
  if (!idMap) return [];
  return Object.keys(idMap).map((k) => Number(k));
}

export class MeshCollector {
  readonly featureIdAttribute: number;
  private _condition: StyleCondition;
  private readonly _matchCacheKey: string;
  private readonly _splitCacheKey: string;

  constructor(params: { condition: StyleCondition }) {
    this._condition = params.condition;
    this._matchCacheKey = buildMatchCacheKey(params.condition[0]);
    this._splitCacheKey = buildSplitCacheKey(params.condition);
    this.featureIdAttribute = resolveStyleConditionFeatureIdAttribute(
      params.condition[0],
    );
  }

  applyStyle(scene: Object3D): void {
    const tileMeshes = collectTileMeshesFromScene(scene);
    const featureIdAttribute = this.featureIdAttribute;
    const splitKey = this._splitCacheKey;

    for (const tileMesh of tileMeshes) {
      if (getCachedSplitMeshFromTileMesh(tileMesh, splitKey)) continue;

      const matchedPartIds = this._resolveMatchedPartIdsOnTileMesh(tileMesh);
      if (matchedPartIds.size === 0) {
        releaseConditionCache(tileMesh, this._matchCacheKey, splitKey);
        continue;
      }

      const splitMesh = this._buildSplitMesheForTileMesh(
        tileMesh,
        matchedPartIds,
        featureIdAttribute,
      );
      if (splitMesh) {
        this._applyStyle(splitMesh);
        attachSplitMeshToTileMeshParent(tileMesh, splitMesh);
        setCachedSplitMeshOnTileMesh(tileMesh, splitKey, splitMesh);
      }
    }
  }

  getSplitMesh(tileMesh: Mesh): Mesh | null {
    return getCachedSplitMeshFromTileMesh(tileMesh, this._splitCacheKey);
  }

  /** 把本条件在该 tile mesh 上命中的 featureId 原地累加进 out，避免中间 Set 分配 */
  addMatchedFeatureIds(tileMesh: Mesh, out: Set<number>): void {
    const partIds = this._resolveMatchedPartIdsOnTileMesh(tileMesh);
    const idMap = getPartIdMapForFeatureAttribute(
      tileMesh,
      this.featureIdAttribute,
    );
    if (!idMap) return;
    for (const partId of partIds) {
      const fid = idMap[partId];
      if (fid !== undefined) out.add(fid);
    }
  }

  dispose(scene: Object3D) {
    const matchKey = this._matchCacheKey;
    const splitKey = this._splitCacheKey;
    for (const tileMesh of collectTileMeshesFromScene(scene)) {
      releaseConditionCache(tileMesh, matchKey, splitKey);
    }
  }

  private _resolveMatchedPartIdsOnTileMesh(tileMesh: Mesh): Set<number> {
    const cacheKey = this._matchCacheKey;
    const cached = getCachedMatchedFeatureIds(tileMesh, cacheKey);
    if (cached) return cached;

    const [condInput] = this._condition;
    const featureIdAttribute =
      resolveStyleConditionFeatureIdAttribute(condInput);
    const idMap = getPartIdMapForFeatureAttribute(tileMesh, featureIdAttribute);
    const matchedPartIds = new Set<number>();
    if (!idMap) {
      setCachedMatchedFeatureIds(tileMesh, cacheKey, matchedPartIds);
      return matchedPartIds;
    }

    const evaluators = buildStyleConditionEvaluatorMap({
      conditions: [this._condition],
    });

    for (const partId of collectPartIdsFromTileMesh(
      tileMesh,
      featureIdAttribute,
    )) {
      const propertyData = getPropertyDataFromUserData(
        tileMesh.userData,
        partId,
        featureIdAttribute,
      );
      if (propertyData == null) continue;
      if (!evaluateStyleCondition(condInput, propertyData, evaluators)) {
        continue;
      }
      if (idMap[partId] === undefined) continue;
      matchedPartIds.add(partId);
    }

    setCachedMatchedFeatureIds(tileMesh, cacheKey, matchedPartIds);
    return matchedPartIds;
  }

  private _buildSplitMesheForTileMesh(
    tileMesh: Mesh,
    matchedPartIds: Set<number>,
    featureIdAttribute: number,
  ): Mesh | null {
    if (matchedPartIds.size === 0) return null;

    if (tileMesh instanceof InstancedMesh && isTileInstancedMesh(tileMesh)) {
      const instanced = buildSplitInstancedMeshForTileMesh(
        tileMesh,
        matchedPartIds,
        featureIdAttribute,
      );
      return instanced ? instanced : null;
    }

    if (!isTileMesh(tileMesh)) return null;

    const channel = featureIdAttributeToChannel(featureIdAttribute);
    const geometry =
      channel === "pid"
        ? buildMergedSplitGeometryForTileMeshByPids(tileMesh, matchedPartIds)
        : buildMergedSplitGeometryForTileMesh(tileMesh, matchedPartIds);
    if (!geometry) return null;

    const splitMesh =
      channel === "pid"
        ? createMergedSplitMeshFromGeometryByPids(
            tileMesh,
            geometry,
            matchedPartIds,
          )
        : createMergedSplitMeshFromGeometry(tileMesh, geometry, matchedPartIds);
    return splitMesh ? splitMesh : null;
  }

  private _applyStyle(mesh: Mesh): void {
    const appearance = this._condition[1];
    if (!appearance) return;
    if (appearance.material) {
      mesh.material = appearance.material as Material;
    }
  }
}
