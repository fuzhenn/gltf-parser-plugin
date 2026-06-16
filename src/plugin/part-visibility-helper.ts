import { Object3D } from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import {
  applyVisibilityToAllLoadedMeshes,
  applyVisibilityToScene,
} from "../mesh-helper";

/**
 * 按 OID / PID 控制瓦片内构件显隐（与 setStyle / 高亮内部使用的逻辑一致）。
 * `hidePartsByOids` / `hidePartsByPids` 会整体替换对应列表；
 * `showPartsByOids` / `showPartsByPids` 仅从列表中移除给定 ID。
 */
export class PartVisibilityHelper {
  private hiddenOids: number[] = [];
  private hiddenPids: number[] = [];

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

  hidePartsByPids(pids: number[]): void {
    this.hiddenPids = [...pids];
    this.applyToAllTiles();
  }

  showPartsByPids(pids: number[]): void {
    const pidSet = new Set(pids);
    this.hiddenPids = this.hiddenPids.filter((pid) => !pidSet.has(pid));
    this.applyToAllTiles();
  }

  reapplyHidden(): void {
    this.applyToAllTiles();
  }

  applyVisibilityToScene(scene: Object3D): void {
    applyVisibilityToScene(
      scene,
      new Set(this.hiddenOids),
      new Set(this.hiddenPids),
    );
  }

  private applyToAllTiles(): void {
    const tiles = this.getTiles();
    if (!tiles) return;
    applyVisibilityToAllLoadedMeshes(
      tiles,
      new Set(this.hiddenOids),
      new Set(this.hiddenPids),
    );
  }
}
