import { Object3D, Plane, WebGLRenderer } from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import { applyClippingPlanesToObject3D } from "../mesh-helper/clipping-planes";

/**
 * 管理 tiles.group 下 mesh 材质的剖切平面；瓦片动态加载/复现时增量应用当前配置。
 */
export class ClippingPlanesHelper {
  private planes: Plane[] | null = null;

  constructor(
    private readonly getTiles: () => TilesRenderer | null,
    private readonly getRenderer: () => WebGLRenderer | null,
  ) {}

  setClippingPlanes(planes: Plane[] | null): void {
    this.planes = planes?.length ? planes : null;

    const renderer = this.getRenderer();
    if (renderer) {
      renderer.localClippingEnabled = this.planes != null;
    }

    const tiles = this.getTiles();
    if (tiles) {
      applyClippingPlanesToObject3D(tiles.group, this.planes);
    }
  }

  /** 瓦片 scene 挂载或样式 split mesh 创建后，应用当前剖切配置 */
  applyToScene(scene: Object3D): void {
    applyClippingPlanesToObject3D(scene, this.planes);
  }

  dispose(): void {
    this.planes = null;
    const renderer = this.getRenderer();
    if (renderer) {
      renderer.localClippingEnabled = false;
    }
  }
}
