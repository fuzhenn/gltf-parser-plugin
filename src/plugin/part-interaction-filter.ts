import type { TilesRenderer } from "3d-tiles-renderer";
import {
  buildStyleConditionEvaluatorMap,
  evaluateStyleCondition,
  resolveStyleConditionFeatureIdAttribute,
  type StyleAppearance,
  type StyleCondition,
  type StyleConditionInput,
} from "../appearance";
import { getPropertyDataMapFromTilesByFeatureAttribute } from "../mesh-helper";

/** 冻结默认外观（半透明幽灵体）；freeze 条目未指定样式时使用 */
export const FROZEN_DEFAULT_APPEARANCE: StyleAppearance = { opacity: 0.2 };

/**
 * 冻结状态单一数据源：持有冻结条件（StyleHelper 冻结视觉由此读取）与
 * 解析后的冻结集（交互屏蔽判定）。冻结集按 feature id 通道存储
 * （channel 0 → oid，1 → pid），值为 fid。
 */
export class PartInteractionFilter {
  private readonly _getTiles: () => TilesRenderer | null;
  private readonly _frozenByChannel = new Map<number, Set<number>>();
  private _conditions: StyleCondition[] = [];

  constructor(getTiles: () => TilesRenderer | null) {
    this._getTiles = getTiles;
  }

  /** 当前冻结条件数组（整体替换语义） */
  get conditions(): readonly StyleCondition[] {
    return this._conditions;
  }

  /** 指定通道的 fid 是否被冻结 */
  isFrozen(channel: number, fid: number): boolean {
    return this._frozenByChannel.get(channel)?.has(fid) ?? false;
  }

  /** 是否存在任意冻结 */
  hasFrozen(): boolean {
    for (const set of this._frozenByChannel.values()) {
      if (set.size > 0) return true;
    }
    return false;
  }

  /**
   * 整体替换冻结状态：selection 归一化为条件数组（单条目补默认幽灵体外观），
   * 逐条解析出 { channel, partIds } 并登记冻结集。
   */
  freeze(selection: StyleConditionInput | StyleCondition[]): void {
    this._conditions = Array.isArray(selection)
      ? selection
      : [[selection, FROZEN_DEFAULT_APPEARANCE]];

    this._frozenByChannel.clear();
    for (const condition of this._conditions) {
      const { channel, partIds } = this._resolveConditionPartIds(condition[0]);
      if (partIds.length === 0) continue;
      let set = this._frozenByChannel.get(channel);
      if (!set) {
        set = new Set();
        this._frozenByChannel.set(channel, set);
      }
      for (const fid of partIds) set.add(fid);
    }
  }

  /** 取消全部冻结 */
  unfreeze(): void {
    this._frozenByChannel.clear();
    this._conditions = [];
  }

  /**
   * 将条件解析为 feature id（partId）列表：字符串 / 布尔 / 带通道对象。
   * descriptor 的 `featureIdAttribute` 决定通道（默认 0 = oid，1 = pid），
   * 求值在对应通道的属性数据上执行；无属性数据的构件不命中。
   */
  private _resolveConditionPartIds(selection: StyleConditionInput): {
    channel: number;
    partIds: number[];
  } {
    const channel = resolveStyleConditionFeatureIdAttribute(selection);
    const tiles = this._getTiles();
    if (!tiles || selection === false) {
      return { channel, partIds: [] };
    }
    const evaluators = buildStyleConditionEvaluatorMap(
      typeof selection === "boolean" ? {} : { show: selection },
    );
    const partIds: number[] = [];
    for (const [fid, data] of getPropertyDataMapFromTilesByFeatureAttribute(
      tiles,
      channel,
    )) {
      if (data && evaluateStyleCondition(selection, data, evaluators)) {
        partIds.push(fid);
      }
    }
    return { channel, partIds };
  }
}

// 实现过程中发现的问题
// 1.如果从当前的tilemesh上构建splitmesh，那之前缓存到的 featureid -> index 的缓存就失效了
// 如果用这种方式就需要每次 index 变化 → 重建 indexCache → 重建全部 split
// splitmesh缓存现在也会生效，因为增加了frozen和show，他们变化也会引起splitmesh重建

// 想法
// 每次计算parid，通过交集来操作
