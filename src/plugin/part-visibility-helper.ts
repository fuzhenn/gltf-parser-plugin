import { Object3D } from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import {
  applyVisibilityToAllLoadedMeshes,
  applyVisibilityToScene,
} from "../mesh-helper";

/**
 * 按 feature id 通道控制瓦片内构件显隐（与 setStyle / 高亮内部使用的逻辑一致）。
 * `hidePartsByFeatureAttribute` 会整体替换对应通道列表；
 * `showPartsByFeatureAttribute` 仅从列表中移除给定 ID。
 */
export class PartVisibilityHelper {
  private hiddenByAttribute = new Map<number, number[]>();

  constructor(private readonly getTiles: () => TilesRenderer | null) {}

  hidePartsByFeatureAttribute(
    featureIds: number[],
    featureIdAttribute: number,
  ): void {
    this.hiddenByAttribute.set(featureIdAttribute, [...featureIds]);
    this.applyToAllTiles();
  }

  showPartsByFeatureAttribute(
    featureIds: number[],
    featureIdAttribute: number,
  ): void {
    const idSet = new Set(featureIds);
    const current = this.hiddenByAttribute.get(featureIdAttribute) ?? [];
    this.hiddenByAttribute.set(
      featureIdAttribute,
      current.filter((id) => !idSet.has(id)),
    );
    this.applyToAllTiles();
  }

  /** @deprecated 请使用 hidePartsByFeatureAttribute(ids, 0) */
  hidePartsByOids(oids: number[]): void {
    this.hidePartsByFeatureAttribute(oids, 0);
  }

  /** @deprecated 请使用 showPartsByFeatureAttribute(ids, 0) */
  showPartsByOids(oids: number[]): void {
    this.showPartsByFeatureAttribute(oids, 0);
  }

  /** @deprecated 请使用 hidePartsByFeatureAttribute(ids, 1) */
  hidePartsByPids(pids: number[]): void {
    this.hidePartsByFeatureAttribute(pids, 1);
  }

  /** @deprecated 请使用 showPartsByFeatureAttribute(ids, 1) */
  showPartsByPids(pids: number[]): void {
    this.showPartsByFeatureAttribute(pids, 1);
  }

  reapplyHidden(): void {
    this.applyToAllTiles();
  }

  applyVisibilityToScene(scene: Object3D): void {
    applyVisibilityToScene(
      scene,
      new Set(this.hiddenByAttribute.get(0) ?? []),
      new Set(this.hiddenByAttribute.get(1) ?? []),
    );
  }

  private applyToAllTiles(): void {
    const tiles = this.getTiles();
    if (!tiles) return;
    applyVisibilityToAllLoadedMeshes(
      tiles,
      new Set(this.hiddenByAttribute.get(0) ?? []),
      new Set(this.hiddenByAttribute.get(1) ?? []),
    );
  }
}
