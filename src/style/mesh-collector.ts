import type { Material, Mesh, Object3D } from "three";
import {
  resolveShowFeatureIdAttribute,
  resolveStyleConditionFeatureIdAttribute,
  type StyleCondition,
  type StyleRefine,
  type StyleShowInput,
} from "./appearance";
import {
  getPartIdMapForFeatureAttribute,
  lookupFeatureId,
} from "../features";
import type { FeatureDataCache } from "../features";
import type { MaterialBuilder } from "../types";
import type { PartInteractionFilter } from "../interaction";

import {
  buildCollectorGroupKey,
  buildMatchCacheKey,
  buildShowHiddenCacheKey,
} from "./cache-keys";
import {
  attachSplitMeshToTileMeshParent,
  disposeSplitGeometry,
  getOrCreateSplitMeshGroup,
  getSharedSplitGeometry,
  getSplitMeshGroup,
  releaseSharedSplitGeometry,
  removeMatchedFeatureIdsCache,
  removeSplitMeshGroup,
  setSharedSplitGeometry,
} from "./split-cache";
import {
  resolveMatchedPartIdsOnTileMesh,
  resolveShowHiddenPartIdsOnTileMesh,
} from "./condition-match";
import { buildSplitMeshForTileMesh } from "./split-builder";
import {
  applyStyleColorOpacity,
  disposeOwnedStyleMaterial,
} from "./material-resolver";
import { collectTileMeshesFromScene } from "../features";

/**
 * 一个 collector 对应一组「同 key 条件」（buildCollectorGroupKey 相同）。
 * 组 key 含条件表达式 + material 引用 + mesh 回调 + TRS 位姿 + refine，且不含
 * color/opacity —— 因此组内 condition 表达式必然一致（命中集一致）、几何来源
 * 一致，唯一可能不同的就是 color/opacity。组内按位置对齐维护 split mesh
 * （tileMesh 上按组 key 缓存一个 Mesh 数组，条件位置即数组下标），
 * 外观变化原地写 color/opacity，不重建几何。
 */
export class MeshCollector {
  readonly featureIdAttribute: number;
  private _conditions: StyleCondition[];
  private readonly _groupKey: string;
  private readonly _refine: StyleRefine;
  private readonly _materialBuilder?: MaterialBuilder;
  private readonly _interactionFilter?: PartInteractionFilter;
  private readonly _getOidPathMap?: () => Map<number, string>;
  private readonly _featureDataCache?: FeatureDataCache;
  private readonly _matchCacheKey: string;
  private _show: StyleShowInput | null = null;
  private _showChannel?: number;
  private _showHiddenKey: string | null = null;

  constructor(params: {
    conditions: StyleCondition[];
    materialBuilder?: MaterialBuilder;
    interactionFilter?: PartInteractionFilter;
    show?: StyleShowInput;
    getOidPathMap?: () => Map<number, string>;
    featureDataCache?: FeatureDataCache;
  }) {
    this._conditions = params.conditions;
    this._groupKey = buildCollectorGroupKey(params.conditions[0]);
    this._refine = params.conditions[0][1]?.refine ?? "replace";
    this._materialBuilder = params.materialBuilder;
    this._interactionFilter = params.interactionFilter;
    this._getOidPathMap = params.getOidPathMap;
    this._featureDataCache = params.featureDataCache;
    this._matchCacheKey = buildMatchCacheKey(params.conditions[0][0]);
    this.featureIdAttribute = resolveStyleConditionFeatureIdAttribute(
      params.conditions[0][0],
    );
    this.setShow(params.show);
  }

  /**
   * setStyle 复用 collector 时调用：同组条件按位置对齐整体替换。
   */
  updateConditions(conditions: StyleCondition[]): void {
    this._conditions = conditions;
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
    const count = this._conditions.length;
    const oidPathMap = this._getOidPathMap?.();

    for (const tileMesh of tileMeshes) {
      // 组内条件表达式一致 → 条件求值与生效集计算每 tileMesh 只做一次
      const matchedPartIds = resolveMatchedPartIdsOnTileMesh(
        tileMesh,
        this._conditions[0],
        this._matchCacheKey,
        this.featureIdAttribute,
        oidPathMap,
        this._featureDataCache,
      );
      const effective = this._filterHiddenOnTileMesh(
        tileMesh,
        matchedPartIds,
        oidPathMap,
      );

      // 清扫数量收缩后越界的旧缓存条目（低频路径）
      this._releaseOutOfRangeSplitMeshes(tileMesh, count);

      for (let i = 0; i < count; i++) {
        const appearance = this._conditions[i][1];
        const cached = getSplitMeshGroup(tileMesh, this._groupKey)?.[i];

        if (cached) {
          // 快速路径：材质独享（构建时 clone 一次），原地写条件声明的
          // color/opacity，零分配零编译，几何与缓存结构不动
          applyStyleColorOpacity(cached.material as Material, appearance);
          continue;
        }
        if (effective.size === 0) continue;

        // 组内命中集一致 → 合并几何一致：首个构建的几何登记为组共享，后续
        // 槽位复用（每槽仅独享材质，color/opacity 原地写，几何内存 1/N）
        const shared = getSharedSplitGeometry(tileMesh, this._groupKey);
        const result = buildSplitMeshForTileMesh(
          tileMesh,
          effective,
          this.featureIdAttribute,
          appearance,
          this._materialBuilder,
          this._featureDataCache,
          shared,
        );
        if (!result) continue;

        if (shared) {
          if (result.mesh.geometry !== shared) {
            // mesh 工厂替换了几何 → 共享输入失去主人，释放并让本组退化为
            // 每槽独享（工厂行为按约定一致，shared 已无 mesh 引用）
            releaseSharedSplitGeometry(tileMesh, this._groupKey);
          }
        } else if (result.geometry) {
          setSharedSplitGeometry(tileMesh, this._groupKey, result.geometry);
        }

        attachSplitMeshToTileMeshParent(tileMesh, result.mesh);
        getOrCreateSplitMeshGroup(tileMesh, this._groupKey)[i] = result.mesh;
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
    oidPathMap?: Map<number, string>,
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
        oidPathMap,
        this._featureDataCache,
      );
      if (hidden.size > 0) {
        for (const partId of matched) {
          if (hidden.has(partId)) drop(partId);
        }
      }
    }

    return effective ?? matched;
  }

  /** 释放单个 split mesh（摘出场景 + 释放独有几何 + dispose 独享材质；
   *  组共享几何的 mesh 跳过几何释放，几何随组缓存条目统一释放；
   *  用户传入的 material 实例无所有权标记，不 dispose） */
  private _releaseSplitMesh(tileMesh: Mesh, splitMesh: Mesh): void {
    splitMesh.removeFromParent();
    if (splitMesh.geometry !== getSharedSplitGeometry(tileMesh, this._groupKey)) {
      disposeSplitGeometry(splitMesh);
    }
    disposeOwnedStyleMaterial(splitMesh.material);
  }

  /** 清扫下标 >= count 的越界缓存 mesh（conditions 数量收缩后残留） */
  private _releaseOutOfRangeSplitMeshes(tileMesh: Mesh, count: number): void {
    const group = getSplitMeshGroup(tileMesh, this._groupKey);
    if (!group) return;
    for (let i = count; i < group.length; i++) {
      const mesh = group[i];
      if (mesh) this._releaseSplitMesh(tileMesh, mesh);
    }
    if (group.length > count) {
      group.length = count;
      if (count === 0) removeSplitMeshGroup(tileMesh, this._groupKey);
    }
  }

  /** 返回本组在该 tile mesh 上的全部 split mesh（按组内位置序） */
  getSplitMeshes(tileMesh: Mesh): Mesh[] {
    const group = getSplitMeshGroup(tileMesh, this._groupKey);
    if (!group) return [];
    const meshes: Mesh[] = [];
    for (let i = 0; i < group.length; i++) {
      const mesh = group[i];
      if (!mesh) continue;
      // 同步 color/opacity：updateConditions 替换条件数组后，按位置把
      // conditions[i][1] 声明的值原地写到独享材质上（零分配，立即生效）
      const appearance = this._conditions[i]?.[1];
      if (appearance) {
        applyStyleColorOpacity(mesh.material as Material, appearance);
      }
      meshes.push(mesh);
    }
    return meshes;
  }

  /** 把本组条件在该 tile mesh 上命中的 featureId 原地累加进 out，避免中间 Set 分配 */
  addMatchedFeatureIds(tileMesh: Mesh, out: Set<number>): void {
    // refine: add → split 仅叠加显示，命中部分不从 tile mesh index
    if (this._refine === "add") return;
    // 组内条件表达式一致（组 key 保证），单次求值即为全组命中
    const partIds = resolveMatchedPartIdsOnTileMesh(
      tileMesh,
      this._conditions[0],
      this._matchCacheKey,
      this.featureIdAttribute,
      this._getOidPathMap?.(),
      this._featureDataCache,
    );
    const idMap = getPartIdMapForFeatureAttribute(
      tileMesh,
      this.featureIdAttribute,
    );
    if (!idMap) return;
    for (const partId of partIds) {
      const fid = lookupFeatureId(idMap, partId);
      if (fid !== undefined) out.add(fid);
    }
  }

  dispose(scene: Object3D) {
    for (const tileMesh of collectTileMeshesFromScene(scene)) {
      const group = getSplitMeshGroup(tileMesh, this._groupKey);
      if (group) {
        for (const mesh of group) {
          if (mesh) this._releaseSplitMesh(tileMesh, mesh);
        }
        removeSplitMeshGroup(tileMesh, this._groupKey);
      }
      removeMatchedFeatureIdsCache(tileMesh, this._matchCacheKey);
      if (this._showHiddenKey) {
        removeMatchedFeatureIdsCache(tileMesh, this._showHiddenKey);
      }
    }
  }
}
