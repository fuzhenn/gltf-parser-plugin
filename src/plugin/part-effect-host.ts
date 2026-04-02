import type { Object3D } from "three";
import type { TilesRenderer } from "3d-tiles-renderer";
import type { MeshCollector, MeshCollectorQuery } from "../MeshCollector";

/** 构件外观辅助（着色 / 闪烁 / 线框 / 高亮）从插件注入的能力 */
export interface PartEffectHost {
  getTiles(): TilesRenderer | null;
  hidePartsByOids(oids: number[]): void;
  showPartsByOids(oids: number[]): void;
  getMeshCollectorByCondition(query: MeshCollectorQuery): MeshCollector;
  getRootGroup(): Object3D | null;
}
