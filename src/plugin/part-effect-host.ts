import type { Object3D } from "three";
import type { TilesRenderer } from "3d-tiles-renderer";
import type { MeshCollector, MeshCollectorQuery } from "../MeshCollector-deleted";
import type { InternalData } from "../mesh-helper/mesh";
import type { MeshPartVisibilityConfig } from "../mesh-helper";

/** 构件外观辅助（着色 / 闪烁 / 线框 / 高亮）从插件注入的能力 */
export interface PartEffectHost {
  getTiles(): TilesRenderer | null;
  setPartVisibilityConfigLayer(
    layerId: string,
    featureIdAttribute: number,
    configs: MeshPartVisibilityConfig[],
  ): void;
  removePartVisibilityConfigLayer(
    layerId: string,
    featureIdAttribute?: number,
  ): void;
  getMeshCollectorByCondition(query: MeshCollectorQuery): MeshCollector;
  releaseMeshCollector(collector: MeshCollector): void;
  clearTileSubsetCache(): void;
  getRootGroup(): Object3D | null;
  getInternalData?(): InternalData | undefined;
}
