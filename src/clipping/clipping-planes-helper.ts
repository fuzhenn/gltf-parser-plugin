import { Object3D, Plane } from "three";
import type { TilesRenderer } from "3d-tiles-renderer";
import { applyClippingPlanesToObject3D } from "./apply-planes";

/**
 * 管理 tiles.group 下 mesh 材质的剖切平面；瓦片动态加载/复现时增量应用当前配置。
 * setClippingPlanes 立即作用于已加载瓦片；新加载 / LRU 复现的瓦片及样式 split mesh
 * 由 update-after 每帧对可见瓦片 scene 调用 {@link applyToScene} 幂等补齐。
 */
export class ClippingPlanesHelper {
  private planes: Plane[] | null = null;

  constructor(private readonly getTiles: () => TilesRenderer | null) {}

  setClippingPlanes(planes: Plane[] | null): void {
    this.planes = planes?.length ? planes : null;

    const tiles = this.getTiles();
    if (tiles) {
      applyClippingPlanesToObject3D(tiles.group, this.planes);
    }
  }

  /** 对单个瓦片 scene 应用当前剖切配置；幂等，可每帧调用 */
  applyToScene(scene: Object3D): void {
    applyClippingPlanesToObject3D(scene, this.planes);
  }

  dispose(): void {
    this.planes = null;
  }
}
