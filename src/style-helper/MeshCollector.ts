import { Mesh, Object3D } from "three";
import { resolveStyleConditionFeatureIdAttribute } from "../appearance";
import { getPartIdMapForFeatureAttribute } from "../mesh-helper";
import type { StyleCondition } from "../appearance";
import type { MaterialBuilder } from "../types";

import {
  attachSplitMeshToTileMeshParent,
  buildMatchCacheKey,
  buildSplitCacheKey,
  buildSplitMeshForTileMesh,
  collectTileMeshesFromScene,
  getCachedSplitMeshFromTileMesh,
  releaseConditionCache,
  resolveMatchedPartIdsOnTileMesh,
  setCachedSplitMeshOnTileMesh,
} from "./utils";

export class MeshCollector {
  readonly featureIdAttribute: number;
  private _condition: StyleCondition;
  private readonly _materialBuilder?: MaterialBuilder;
  private readonly _matchCacheKey: string;
  private readonly _splitCacheKey: string;

  constructor(params: {
    condition: StyleCondition;
    materialBuilder?: MaterialBuilder;
  }) {
    this._condition = params.condition;
    this._materialBuilder = params.materialBuilder;
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

      const matchedPartIds = resolveMatchedPartIdsOnTileMesh(
        tileMesh,
        this._condition,
        this._matchCacheKey,
        featureIdAttribute,
      );
      if (matchedPartIds.size === 0) {
        releaseConditionCache(tileMesh, this._matchCacheKey, splitKey);
        continue;
      }

      const splitMesh = buildSplitMeshForTileMesh(
        tileMesh,
        matchedPartIds,
        featureIdAttribute,
        this._condition[1],
        this._materialBuilder,
      );
      if (splitMesh) {
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
    const partIds = resolveMatchedPartIdsOnTileMesh(
      tileMesh,
      this._condition,
      this._matchCacheKey,
      this.featureIdAttribute,
    );
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
}
