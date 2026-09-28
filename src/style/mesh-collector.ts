import type { Mesh, Object3D } from "three";
import {
  resolveShowFeatureIdAttribute,
  resolveStyleConditionFeatureIdAttribute,
  type StyleCondition,
  type StyleShowInput,
} from "./appearance";
import { getPartIdMapForFeatureAttribute } from "../features";
import type { MaterialBuilder } from "../types";
import type { PartInteractionFilter } from "../interaction";

import {
  buildMatchCacheKey,
  buildShowHiddenCacheKey,
  buildSplitCacheKey,
} from "./cache-keys";
import {
  attachSplitMeshToTileMeshParent,
  getCachedSplitMeshFromTileMesh,
  releaseConditionCache,
  removeMatchedFeatureIdsCache,
  setCachedSplitMeshOnTileMesh,
} from "./split-cache";
import {
  resolveMatchedPartIdsOnTileMesh,
  resolveShowHiddenPartIdsOnTileMesh,
} from "./condition-match";
import { buildSplitMeshForTileMesh } from "./split-builder";
import { collectTileMeshesFromScene } from "../features";

export class MeshCollector {
  readonly featureIdAttribute: number;
  private _condition: StyleCondition;
  private readonly _materialBuilder?: MaterialBuilder;
  private readonly _interactionFilter?: PartInteractionFilter;
  private readonly _matchCacheKey: string;
  private readonly _splitCacheKey: string;
  private _show: StyleShowInput | null = null;
  private _showChannel?: number;
  private _showHiddenKey: string | null = null;

  constructor(params: {
    condition: StyleCondition;
    materialBuilder?: MaterialBuilder;
    interactionFilter?: PartInteractionFilter;
    show?: StyleShowInput;
  }) {
    this._condition = params.condition;
    this._materialBuilder = params.materialBuilder;
    this._interactionFilter = params.interactionFilter;
    this._matchCacheKey = buildMatchCacheKey(params.condition[0]);
    this._splitCacheKey = buildSplitCacheKey(params.condition);
    this.featureIdAttribute = resolveStyleConditionFeatureIdAttribute(
      params.condition[0],
    );
    this.setShow(params.show);
  }

  /** show 变更时由 StyleHelper 调用（collector 按条件 key 复用，show 状态需同步更新） */
  setShow(show?: StyleShowInput): void {
    this._show = show ?? null;
    this._showChannel =
      this._show == null
        ? undefined
        : resolveShowFeatureIdAttribute(this._show);
    this._showHiddenKey =
      this._show == null ? null : buildShowHiddenCacheKey(this._show);
  }

  applyStyle(scene: Object3D): void {
    const tileMeshes = collectTileMeshesFromScene(scene);
    const splitKey = this._splitCacheKey;

    for (const tileMesh of tileMeshes) {
      const matchedPartIds = resolveMatchedPartIdsOnTileMesh(
        tileMesh,
        this._condition,
        this._matchCacheKey,
        this.featureIdAttribute,
      );
      const effective = this._filterHiddenOnTileMesh(tileMesh, matchedPartIds);

      // 本方法仅在 scene 代数过期（setStyle/freeze/show 变化或新瓦片）时执行：
      // 直接拆旧 split 重建，不做逐 mesh 精细比对（均为低频操作，简单优先）
      releaseConditionCache(tileMesh, this._matchCacheKey, splitKey);
      if (effective.size === 0) continue;

      const splitMesh = buildSplitMeshForTileMesh(
        tileMesh,
        effective,
        this.featureIdAttribute,
        this._condition[1],
        this._materialBuilder,
      );
      if (splitMesh) {
        attachSplitMeshToTileMeshParent(tileMesh, splitMesh);
        setCachedSplitMeshOnTileMesh(tileMesh, splitKey, splitMesh);
      }
    }
  }

  /**
   * 生效命中集 = 条件命中 − 冻结 − show 隐藏（优先级：冻结/show 优先于样式）。
   * 冻结按条件自身通道参与减法（冻结集按通道存 oid/pid，与 partId 同域直接比对；
   * idMap 的值是 `_FEATURE_ID_N` 原始值域，不能拿来比对冻结集）；
   * show 仅在与条件同通道时参与减法（不同通道无法保证 partId 语义一致，降级为不参与）。
   */
  private _filterHiddenOnTileMesh(
    tileMesh: Mesh,
    matched: Set<number>,
  ): Set<number> {
    const filter = this._interactionFilter;
    const canFilterShow =
      this._show != null && this._showChannel === this.featureIdAttribute;
    if ((!filter && !canFilterShow) || matched.size === 0) {
      return matched;
    }

    // 惰性拷贝：仅当确实需要剔除时才复制集合
    let effective: Set<number> | null = null;
    const drop = (partId: number): void => {
      if (!effective) effective = new Set(matched);
      effective.delete(partId);
    };

    if (filter?.hasFrozen()) {
      for (const partId of matched) {
        if (filter.isFrozen(this.featureIdAttribute, partId)) {
          drop(partId);
        }
      }
    }

    if (this._show != null && this._showChannel === this.featureIdAttribute) {
      const hidden = resolveShowHiddenPartIdsOnTileMesh(
        tileMesh,
        this._show,
        this._showHiddenKey!,
        this._showChannel!,
      );
      if (hidden.size > 0) {
        for (const partId of matched) {
          if (hidden.has(partId)) drop(partId);
        }
      }
    }

    return effective ?? matched;
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
      if (this._showHiddenKey) {
        removeMatchedFeatureIdsCache(tileMesh, this._showHiddenKey);
      }
    }
  }
}
