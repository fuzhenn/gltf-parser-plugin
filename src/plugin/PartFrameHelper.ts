import type { MeshCollector } from "../MeshCollector";
import {
  DoubleSide,
  EdgesGeometry,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  Object3D,
} from "three";

/** 内部使用：插件需提供的接口 */
interface PartFrameHelperContext {
  hideByOids(oids: number[]): void;
  unhideByOids(oids: number[]): void;
  getMeshCollectorByOid(oid: number): MeshCollector;
  getScene(): Object3D | null;
}

interface FrameOidData {
  meshes: Mesh[];
  lines: LineSegments[];
}

/**
 * 构件线框显示辅助器
 * 通过 hideByOids + split mesh + 填充材质 + EdgesGeometry 实现线框效果
 */
export class PartFrameHelper {
  private frameOids = new Set<number>();
  private originalMaterialByMesh = new Map<string, Material>();
  private frameDataByOid = new Map<number, FrameOidData>();
  private meshChangeHandlers = new Map<number, () => void>();

  private fillMaterial: MeshBasicMaterial;
  private edgeMaterial: MeshBasicMaterial;
  private edgeThreshold: number;

  constructor(private context: PartFrameHelperContext) {
    this.fillMaterial = new MeshBasicMaterial({
      color: 0x00d4aa,
      transparent: true,
      opacity: 0.3,
      side: DoubleSide,
      depthWrite: false,
    });
    this.edgeMaterial = new MeshBasicMaterial({
      color: 0x00d4aa,
      transparent: true,
      opacity: 0.8,
    });
    this.edgeThreshold = 15;
  }

  private createWireframeForMeshes(
    meshes: Mesh[],
    scene: Object3D
  ): FrameOidData {
    const frameMeshes: Mesh[] = [];
    const lines: LineSegments[] = [];

    for (const mesh of meshes) {
      if (!this.originalMaterialByMesh.has(mesh.uuid)) {
        this.originalMaterialByMesh.set(mesh.uuid, mesh.material as Material);
      }
      mesh.material = this.fillMaterial;
      scene.add(mesh);
      frameMeshes.push(mesh);

      const edges = new EdgesGeometry(mesh.geometry, this.edgeThreshold);
      const line = new LineSegments(edges, this.edgeMaterial);
      line.matrix.copy(mesh.matrixWorld);
      line.matrixAutoUpdate = false;
      scene.add(line);
      lines.push(line);
    }

    return { meshes: frameMeshes, lines };
  }

  private removeFrameData(data: FrameOidData, scene: Object3D): void {
    for (const mesh of data.meshes) {
      const original = this.originalMaterialByMesh.get(mesh.uuid);
      if (original) {
        mesh.material = original;
        this.originalMaterialByMesh.delete(mesh.uuid);
      }
      if (mesh.parent === scene) scene.remove(mesh);
    }
    for (const line of data.lines) {
      if (line.parent === scene) scene.remove(line);
      line.geometry.dispose();
    }
  }

  private applyFrameToOid(oid: number): void {
    const scene = this.context.getScene();
    if (!scene) return;

    const collector = this.context.getMeshCollectorByOid(oid);
    const oldData = this.frameDataByOid.get(oid);
    if (oldData) this.removeFrameData(oldData, scene);

    const newData = this.createWireframeForMeshes(collector.meshes, scene);
    this.frameDataByOid.set(oid, newData);
  }

  /**
   * 设置需要线框显示的构件
   * @param oids 构件 OID 数组
   */
  setFramePartsByOids(oids: number[]): void {
    this.clearAllFrameParts();

    const scene = this.context.getScene();
    if (!scene) return;

    for (const oid of oids) {
      this.frameOids.add(oid);

      const collector = this.context.getMeshCollectorByOid(oid);
      const data = this.createWireframeForMeshes(collector.meshes, scene);
      this.frameDataByOid.set(oid, data);

      const handler = () => this.applyFrameToOid(oid);
      this.meshChangeHandlers.set(oid, handler);
      collector.addEventListener("mesh-change", handler);
    }

    this.context.hideByOids(Array.from(this.frameOids));
  }

  /**
   * 清除所有线框显示构件
   */
  clearAllFrameParts(): void {
    const scene = this.context.getScene();
    if (!scene) return;

    const oidsToUnhide = Array.from(this.frameOids);

    for (const oid of oidsToUnhide) {
      const data = this.frameDataByOid.get(oid);
      if (data) {
        this.removeFrameData(data, scene);
        this.frameDataByOid.delete(oid);
      }

      const handler = this.meshChangeHandlers.get(oid);
      if (handler) {
        this.meshChangeHandlers.delete(oid);
        const collector = this.context.getMeshCollectorByOid(oid);
        collector.removeEventListener("mesh-change", handler);
      }
    }

    this.frameOids.clear();
    this.context.unhideByOids(oidsToUnhide);
  }

  dispose(): void {
    this.clearAllFrameParts();
  }
}
