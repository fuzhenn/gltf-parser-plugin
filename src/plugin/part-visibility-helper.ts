import { Object3D } from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import {
  applyVisibilityToAllLoadedMeshes,
  applyVisibilityToScene,
  setMeshPartVisibilityConfigs,
  setMeshPartVisibilityInternalData,
  type MeshPartVisibilityConfig,
} from "../mesh-helper";
import type { InternalData } from "../mesh-helper/mesh";

/**
 * 按 feature 通道登记 show/conditions 规则；隐藏 partId 在各瓦片 mesh 内局部求值。
 */
export class PartVisibilityHelper {
  /** layerId → (featureIdAttribute → 规则列表) */
  private layers = new Map<string, Map<number, MeshPartVisibilityConfig[]>>();

  constructor(
    private readonly getTiles: () => TilesRenderer | null,
    private readonly getInternalData?: () => InternalData | undefined,
  ) {}

  setPartVisibilityConfigLayer(
    layerId: string,
    featureIdAttribute: number,
    configs: MeshPartVisibilityConfig[],
  ): void {
    let layer = this.layers.get(layerId);
    if (!layer) {
      layer = new Map();
      this.layers.set(layerId, layer);
    }
    if (configs.length > 0) {
      layer.set(featureIdAttribute, configs);
    } else {
      layer.delete(featureIdAttribute);
      if (layer.size === 0) this.layers.delete(layerId);
    }
    this.syncToIndexVisibility();
    this.applyToAllTiles();
  }

  removePartVisibilityConfigLayer(
    layerId: string,
    featureIdAttribute?: number,
  ): void {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    if (featureIdAttribute === undefined) {
      this.layers.delete(layerId);
    } else {
      layer.delete(featureIdAttribute);
      if (layer.size === 0) this.layers.delete(layerId);
    }
    this.syncToIndexVisibility();
    this.applyToAllTiles();
  }

  reapplyHidden(): void {
    this.syncToIndexVisibility();
    this.applyToAllTiles();
  }

  applyVisibilityToScene(scene: Object3D): void {
    applyVisibilityToScene(scene);
  }

  private syncToIndexVisibility(): void {
    setMeshPartVisibilityInternalData(this.getInternalData?.());
    for (const attribute of [0, 1]) {
      const merged: MeshPartVisibilityConfig[] = [];
      for (const layer of this.layers.values()) {
        merged.push(...(layer.get(attribute) ?? []));
      }
      setMeshPartVisibilityConfigs(attribute, merged);
    }
  }

  private applyToAllTiles(): void {
    const tiles = this.getTiles();
    if (!tiles) return;
    applyVisibilityToAllLoadedMeshes(tiles);
  }
}
