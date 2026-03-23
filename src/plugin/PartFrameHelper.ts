import type { PartEffectHost } from "./part-effect-host";
import type { ColorInput } from "../utils/color-input";
import { toColor } from "../utils/color-input";
import {
  DoubleSide,
  EdgesGeometry,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  Object3D,
} from "three";

interface FrameOidData {
  meshes: Mesh[];
  lines: LineSegments[];
}

/**
 * 构件线框显示辅助器
 * 通过 hidePartsByOids + split mesh + 填充材质 + EdgesGeometry 实现线框效果
 */
const DEFAULT_FRAME_COLOR = 0x00d4aa;

export class PartFrameHelper {
  private frameOids = new Set<number>();
  private originalMaterialByMesh = new Map<string, Material>();
  private frameDataByOid = new Map<number, FrameOidData>();
  private meshChangeHandlers = new Map<number, () => void>();

  private fillColorByOid = new Map<number, number>();
  private edgeColorByOid = new Map<number, number>();
  private fillMaterialCache = new Map<number, MeshBasicMaterial>();
  private edgeMaterialCache = new Map<number, MeshBasicMaterial>();
  private edgeThreshold: number;

  constructor(private context: PartEffectHost) {
    this.edgeThreshold = 15;
  }

  private getFillMaterial(hex: number): MeshBasicMaterial {
    if (!this.fillMaterialCache.has(hex)) {
      this.fillMaterialCache.set(
        hex,
        new MeshBasicMaterial({
          color: hex,
          transparent: true,
          opacity: 0.3,
          side: DoubleSide,
          depthWrite: false,
        })
      );
    }
    return this.fillMaterialCache.get(hex)!;
  }

  private getEdgeMaterial(hex: number): MeshBasicMaterial {
    if (!this.edgeMaterialCache.has(hex)) {
      this.edgeMaterialCache.set(
        hex,
        new MeshBasicMaterial({
          color: hex,
          transparent: true,
          opacity: 0.8,
        })
      );
    }
    return this.edgeMaterialCache.get(hex)!;
  }

  private createWireframeForMeshes(
    meshes: Mesh[],
    scene: Object3D,
    oid: number
  ): FrameOidData {
    const fillHex = this.fillColorByOid.get(oid) ?? DEFAULT_FRAME_COLOR;
    const edgeHex = this.edgeColorByOid.get(oid) ?? DEFAULT_FRAME_COLOR;
    const fillMaterial = this.getFillMaterial(fillHex);
    const edgeMaterial = this.getEdgeMaterial(edgeHex);

    const frameMeshes: Mesh[] = [];
    const lines: LineSegments[] = [];

    for (const mesh of meshes) {
      if (!this.originalMaterialByMesh.has(mesh.uuid)) {
        this.originalMaterialByMesh.set(mesh.uuid, mesh.material as Material);
      }
      mesh.material = fillMaterial;
      scene.add(mesh);
      frameMeshes.push(mesh);

      const edges = new EdgesGeometry(mesh.geometry, this.edgeThreshold);
      const line = new LineSegments(edges, edgeMaterial);
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

    const newData = this.createWireframeForMeshes(collector.meshes, scene, oid);
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
      const data = this.createWireframeForMeshes(collector.meshes, scene, oid);
      this.frameDataByOid.set(oid, data);

      const handler = () => this.applyFrameToOid(oid);
      this.meshChangeHandlers.set(oid, handler);
      collector.addEventListener("mesh-change", handler);
    }

    this.context.hidePartsByOids(Array.from(this.frameOids));
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
    this.fillColorByOid.clear();
    this.edgeColorByOid.clear();
    this.context.showPartsByOids(oidsToUnhide);
  }

  /**
   * 设置指定构件的线框填充颜色
   * @param oids 构件 OID 数组
   * @param color 颜色值，支持 hex 数字、颜色字符串（如 "#ff0000"）、THREE.Color 对象
   */
  setFrameFillColor(oids: number[], color: ColorInput): void {
    const hex = toColor(color).getHex();
    for (const oid of oids) {
      if (!this.frameOids.has(oid)) continue;
      this.fillColorByOid.set(oid, hex);
      this.applyFrameToOid(oid);
    }
  }

  /**
   * 设置指定构件的线框边框颜色
   * @param oids 构件 OID 数组
   * @param color 颜色值，支持 hex 数字、颜色字符串（如 "#ff0000"）、THREE.Color 对象
   */
  setFrameEdgeColor(oids: number[], color: ColorInput): void {
    const hex = toColor(color).getHex();
    for (const oid of oids) {
      if (!this.frameOids.has(oid)) continue;
      this.edgeColorByOid.set(oid, hex);
      this.applyFrameToOid(oid);
    }
  }

  dispose(): void {
    this.clearAllFrameParts();
    this.fillMaterialCache.forEach((m) => m.dispose());
    this.fillMaterialCache.clear();
    this.edgeMaterialCache.forEach((m) => m.dispose());
    this.edgeMaterialCache.clear();
  }
}
