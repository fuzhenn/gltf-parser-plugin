import { Object3D } from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import { applyVisibilityToScene } from "../mesh-helper";

/**
 * 按 OID 控制瓦片内构件显隐（与 setStyle / 高亮内部使用的逻辑一致）。
 * 状态为当前「被隐藏的 OID 列表」：`hidePartsByOids` 会整体替换该列表，`showPartsByOids` 仅从列表中移除给定 OID。
 */
export class PartVisibilityHelper {
  private hiddenOids: number[] = [];

  constructor(private readonly getTiles: () => TilesRenderer | null) {}

  hidePartsByOids(oids: number[]): void {
    this.hiddenOids = [...oids];
    this.applyToAllTiles();
  }

  showPartsByOids(oids: number[]): void {
    const oidSet = new Set(oids);
    this.hiddenOids = this.hiddenOids.filter((oid) => !oidSet.has(oid));
    this.applyToAllTiles();
  }

  /** 新加载的瓦片场景：应用当前隐藏集 */
  applyVisibilityToScene(scene: Object3D): void {
    applyVisibilityToScene(scene, new Set(this.hiddenOids));
  }

  private applyToAllTiles(): void {
    const tiles = this.getTiles();
    if (!tiles) return;
    const hiddenSet = new Set(this.hiddenOids);
    tiles.traverse((tile: unknown) => {
      const tileWithCache = tile as {
        engineData?: { scene: Object3D };
      };
      if (tileWithCache.engineData?.scene) {
        applyVisibilityToScene(tileWithCache.engineData.scene, hiddenSet);
      }
      return true;
    }, null);
  }
}
