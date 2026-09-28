import { Mesh, Object3D } from "three";
import type { TilesRenderer } from "3d-tiles-renderer";
import { MeshCollector } from "./mesh-collector";
import {
  FROZEN_SPLIT_KEY_PREFIX,
  attachSplitMeshToTileMeshParent,
  releaseFrozenSplitCaches,
  setCachedSplitMeshOnTileMesh,
} from "./split-cache";
import {
  buildMatchCacheKey,
  buildShowHiddenCacheKey,
  buildSplitCacheKey,
} from "./cache-keys";
import {
  resolveMatchedPartIdsOnTileMesh,
  resolveShowHiddenPartIdsOnTileMesh,
} from "./condition-match";
import { buildSplitMeshForTileMesh } from "./split-builder";
import {
  collectTileMeshesFromScene,
  getPartIdMapForFeatureAttribute,
  isTileInstancedMesh,
  isTileMesh,
} from "../features";
import {
  hideMatchedFeaturesOnInstancedMesh,
  hideMatchedFeaturesOnTileMesh,
} from "../geometry";
import {
  resolveShowContent,
  resolveShowFeatureIdAttribute,
  resolveStyleConditionFeatureIdAttribute,
  type StyleConfig,
  type StyleShowInput,
} from "./appearance";
import type { MaterialBuilder } from "../types";
import type { PartInteractionFilter } from "../interaction";

/** scene 级样式代数标记（挂在 scene.userData，随瓦片释放自动清理） */
const STYLE_GENERATION_KEY = "_gltfParserStyleGeneration";

export class StyleHelper {
  style: StyleConfig | null = null;
  private readonly _collectors = new Map<string, MeshCollector>();
  private readonly _materialBuilder?: MaterialBuilder;
  private readonly _interactionFilter?: PartInteractionFilter;
  private _generation = 0;
  private _show: StyleShowInput | null = null;
  private _showChannel?: number;
  private _showHiddenKey: string | null = null;

  constructor(
    materialBuilder?: MaterialBuilder,
    interactionFilter?: PartInteractionFilter,
  ) {
    this._materialBuilder = materialBuilder;
    this._interactionFilter = interactionFilter;
  }

  /** 样式代数：每次 setStyle 递增，scene 上的标记落后即为"过期" */
  get generation(): number {
    return this._generation;
  }

  setStyle(style: StyleConfig | null, scenes: Object3D[]): MeshCollector[] {
    this.style = style;
    const keep = new Set(
      (style?.conditions ?? []).map((c) => buildSplitCacheKey(c)),
    );
    const added: MeshCollector[] = [];

    for (const [key, collector] of this._collectors) {
      if (keep.has(key)) continue;
      for (const scene of scenes) collector.dispose(scene);
      this._collectors.delete(key);
    }

    for (const condition of style?.conditions ?? []) {
      const key = buildSplitCacheKey(condition);
      if (this._collectors.has(key)) continue;
      const collector = new MeshCollector({
        condition,
        materialBuilder: this._materialBuilder,
        interactionFilter: this._interactionFilter,
      });
      this._collectors.set(key, collector);
      added.push(collector);
    }

    this._applyShowState(style?.show);
    // collector 按条件 key 复用，show 状态需统一同步（含新建的）
    for (const collector of this._collectors.values()) {
      collector.setShow(this._show ?? undefined);
    }

    this._generation++;
    return added;
  }

  /** 解析并登记 show 状态（keep-set 补集语义，空表达式视为未启用） */
  private _applyShowState(show?: StyleShowInput): void {
    const showContent = show != null ? resolveShowContent(show)?.trim() : undefined;
    if (show == null || !showContent) {
      this._show = null;
      this._showChannel = undefined;
      this._showHiddenKey = null;
      return;
    }
    this._show = show;
    this._showChannel = resolveShowFeatureIdAttribute(show);
    this._showHiddenKey = buildShowHiddenCacheKey(show);
  }

  /**
   * 冻结变化后调用：代数++，可见瓦片立即重算（index 隐藏 + 样式 split + 冻结幽灵体），
   * 不可见瓦片由 update-after 的 applySceneIfStale 懒补，新瓦片由 load-model 覆盖。
   */
  reapplyFrozen(tiles: TilesRenderer): void {
    this._generation++;
    const visibleTiles = tiles.visibleTiles as
      | Set<{ engineData?: { scene?: Object3D } }>
      | undefined;
    if (!visibleTiles) return;
    for (const tile of visibleTiles) {
      const scene = tile?.engineData?.scene;
      if (scene) this.applySceneIfStale(scene);
    }
  }

  applyTileMeshVisibility(scene: Object3D): void {
    // 暂只支持所有条件共用同一属性通道，取首个 collector 的通道；出现多通道需求时再扩展。
    // 不能因"无条件无冻结无 show"早退：样式清空后仍需走 restore 归还各 mesh 的 _styleFilteredIndex
    const styleChannel = this._collectors.values().next().value
      ?.featureIdAttribute;
    const showChannel = this._show != null ? this._showChannel : undefined;
    // 单通道合成：条件为主通道，冻结恒为 channel 0，show 按自身通道；
    // 通道不一致的来源不参与该 mesh 的 index 隐藏（生效集/幽灵体路径同样按通道降级）
    const hideChannel = styleChannel ?? showChannel ?? 0;

    const styleFids = new Set<number>();
    const frozenFids = new Set<number>();
    const showHiddenFids = new Set<number>();
    scene.traverse((child) => {
      styleFids.clear();
      frozenFids.clear();
      showHiddenFids.clear();
      const isInstanced = isTileInstancedMesh(child);
      if (!isInstanced && !isTileMesh(child)) return;

      for (const collector of this._collectors.values()) {
        collector.addMatchedFeatureIds(child, styleFids);
      }
      // 单通道合成：各来源均按 hideChannel 通道取 fid 并入（通道不同的来源不参与）
      this._collectFrozenFids(child, hideChannel, frozenFids);
      this._collectShowHiddenFids(child, showHiddenFids);

      const merged = styleFids;
      if (frozenFids.size > 0) {
        for (const fid of frozenFids) merged.add(fid);
      }
      if (showChannel === hideChannel && showHiddenFids.size > 0) {
        for (const fid of showHiddenFids) merged.add(fid);
      }

      if (isInstanced) {
        hideMatchedFeaturesOnInstancedMesh(child, hideChannel, merged);
      } else {
        hideMatchedFeaturesOnTileMesh(child, hideChannel, merged);
      }
    });
  }

  applySceneIfStale(scene: Object3D): void {
    if (scene.userData[STYLE_GENERATION_KEY] === this._generation) {
      return;
    }
    this.applyTileMeshVisibility(scene);
    this._applyStyle(scene);
    this._applyFrozenVisuals(scene);
    scene.userData[STYLE_GENERATION_KEY] = this._generation;
  }

  getSplitMeshes(scene: Object3D): Mesh[] {
    const splitMeshes: Mesh[] = [];
    for (const tileMesh of collectTileMeshesFromScene(scene)) {
      for (const collector of this._collectors.values()) {
        const mesh = collector.getSplitMesh(tileMesh);
        if (mesh) splitMeshes.push(mesh);
      }
    }
    return splitMeshes;
  }

  disposeTileScene(scene: Object3D): void {
    for (const collector of this._collectors.values()) {
      collector.dispose(scene);
    }
    for (const tileMesh of collectTileMeshesFromScene(scene)) {
      releaseFrozenSplitCaches(tileMesh, FROZEN_SPLIT_KEY_PREFIX);
    }
  }

  private _applyStyle(scene: Object3D): void {
    for (const collector of this._collectors.values()) {
      collector.applyStyle(scene);
    }
  }

  /**
   * 收集该 mesh 上指定通道被冻结的 featureId 并入 out（供 index 隐藏合成）。
   * 冻结集是 oid/pid 域（与 idMap 键同域），index 剔除需要 `_FEATURE_ID_N`
   * 原始值域（idMap 值），须经 idMap 转换。
   */
  private _collectFrozenFids(
    source: Mesh,
    channel: number,
    out: Set<number>,
  ): void {
    const filter = this._interactionFilter;
    if (!filter?.hasFrozen()) return;
    const idMap = getPartIdMapForFeatureAttribute(source, channel);
    if (!idMap) return;
    for (const partId of Object.keys(idMap)) {
      if (!filter.isFrozen(channel, Number(partId))) continue;
      const fid = idMap[Number(partId)];
      if (fid !== undefined) out.add(fid);
    }
  }

  /** 收集该 mesh 上被 show 隐藏的 fids（keep-set 补集语义，按 show 自身通道） */
  private _collectShowHiddenFids(source: Mesh, out: Set<number>): void {
    if (this._show == null || this._showChannel === undefined) return;
    const hidden = resolveShowHiddenPartIdsOnTileMesh(
      source,
      this._show,
      this._showHiddenKey!,
      this._showChannel,
    );
    if (hidden.size === 0) return;
    const idMap = getPartIdMapForFeatureAttribute(source, this._showChannel);
    if (!idMap) return;
    for (const partId of hidden) {
      const fid = idMap[partId];
      if (fid !== undefined) out.add(fid);
    }
  }

  /**
   * 冻结视觉：每条冻结条件按条件求值命中 partIds，拆分出带样式的 frozenMesh
   * （复用样式 split 的构建与缓存机制，appearance 缺省为半透明幽灵体）。
   * tilemesh 的 index 已剔除冻结部分（applyTileMeshVisibility），交互由
   * PartInteractionFilter 在拾取判定层拦截。
   * 冻结视觉不受 show/条件样式影响（冻结 > show）：保证任意调用顺序结果一致。
   */
  private _applyFrozenVisuals(scene: Object3D): void {
    // 冻结条件由 PartInteractionFilter 持有（单一数据源），此处只做视觉寄生
    for (const tileMesh of collectTileMeshesFromScene(scene)) {
      // 先清扫旧冻结 split（条件数组被整体替换时旧 key 不在新数组里，重算路径无法覆盖）
      releaseFrozenSplitCaches(tileMesh, FROZEN_SPLIT_KEY_PREFIX);

      for (const condition of this._interactionFilter?.conditions ?? []) {
        const channel = resolveStyleConditionFeatureIdAttribute(condition[0]);
        const matchKey = buildMatchCacheKey(condition[0]);
        const splitKey = FROZEN_SPLIT_KEY_PREFIX + buildSplitCacheKey(condition);

        const matchedPartIds = resolveMatchedPartIdsOnTileMesh(
          tileMesh,
          condition,
          matchKey,
          channel,
        );
        if (matchedPartIds.size === 0) continue;

        const frozenMesh = buildSplitMeshForTileMesh(
          tileMesh,
          matchedPartIds,
          channel,
          condition[1],
          this._materialBuilder,
        );
        if (frozenMesh) {
          attachSplitMeshToTileMeshParent(tileMesh, frozenMesh);
          setCachedSplitMeshOnTileMesh(tileMesh, splitKey, frozenMesh);
        }
      }
    }
  }
}
