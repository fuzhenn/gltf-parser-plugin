import type { MeshCollector, MeshCollectorQuery } from "../MeshCollector";
import { Color, Material, MeshStandardMaterial, Object3D } from "three";

import type { ColorInput } from "./PartColorHelper";

/** 内部使用：插件需提供的接口 */
interface PartBlinkHelperContext {
  hidePartsByOids(oids: number[]): void;
  showPartsByOids(oids: number[]): void;
  getMeshCollectorByOid(oid: number): MeshCollector;
  getMeshCollectorByCondition(query: MeshCollectorQuery): MeshCollector;
  getScene(): Object3D | null;
}

function ensureColor(color: ColorInput): Color {
  if (color instanceof Color) return color;
  return new Color(color);
}

/**
 * 构件闪烁强调辅助器
 * 通过 hidePartsByOids + split mesh + emissive 动画实现闪烁效果
 */
export class PartBlinkHelper {
  private blinkOids = new Set<number>();
  private originalMaterialByMesh = new Map<string, Material>();
  private meshChangeHandlers = new Map<number, () => void>();

  private blinkMaterial: MeshStandardMaterial;
  private blinkColor: Color;
  private cycleMs: number;
  private flashTime = 0;
  private rafId: number | null = null;
  private lastTime = 0;

  constructor(private context: PartBlinkHelperContext) {
    this.blinkColor = new Color(0xffaa00);
    this.blinkMaterial = new MeshStandardMaterial({
      color: this.blinkColor.clone(),
      emissive: this.blinkColor.clone(),
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.9,
    });
    this.cycleMs = 1000;
  }

  private applyBlinkToMeshes(oid: number): void {
    const scene = this.context.getScene();
    if (!scene) return;

    const collector = this.context.getMeshCollectorByOid(oid);
    collector.meshes.forEach((mesh) => {
      if (!mesh.parent) scene.add(mesh);
      if (!this.originalMaterialByMesh.has(mesh.uuid)) {
        this.originalMaterialByMesh.set(mesh.uuid, mesh.material as Material);
      }
      mesh.material = this.blinkMaterial;
    });
  }

  private startAnimation(): void {
    if (this.rafId !== null) return;
    this.lastTime = performance.now();

    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      const now = performance.now();
      const delta = (now - this.lastTime) / this.cycleMs;
      this.lastTime = now;
      this.flashTime += delta * Math.PI * 2;
      const intensity = 0.3 + Math.sin(this.flashTime) * 0.3;
      this.blinkMaterial.emissiveIntensity = intensity;
    };
    tick();
  }

  private stopAnimation(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * 设置需要闪烁的构件
   * @param oids 构件 OID 数组
   */
  setBlinkPartsByOids(oids: number[]): void {
    this.clearAllBlinkParts();

    const scene = this.context.getScene();
    if (!scene) return;

    for (const oid of oids) {
      this.blinkOids.add(oid);

      const collector = this.context.getMeshCollectorByOid(oid);
      collector.meshes.forEach((mesh) => {
        if (!this.originalMaterialByMesh.has(mesh.uuid)) {
          this.originalMaterialByMesh.set(mesh.uuid, mesh.material as Material);
        }
        mesh.material = this.blinkMaterial;
        scene.add(mesh);
      });

      const handler = () => this.applyBlinkToMeshes(oid);
      this.meshChangeHandlers.set(oid, handler);
      collector.addEventListener("mesh-change", handler);
    }

    this.context.hidePartsByOids(Array.from(this.blinkOids));
    if (this.blinkOids.size > 0) this.startAnimation();
  }

  /**
   * 设置闪烁颜色
   * @param color 颜色值，支持 hex 数字、颜色字符串（如 "#ff0000"）、THREE.Color 对象
   */
  setBlinkColor(color: ColorInput): void {
    const c = ensureColor(color);
    this.blinkColor.copy(c);
    this.blinkMaterial.color.copy(c);
    this.blinkMaterial.emissive.copy(c);
  }

  /**
   * 设置闪烁周期时间（毫秒）
   * @param ms 一个完整闪烁周期（暗->亮->暗）的时长，默认 1000
   */
  setBlinkIntervalTime(ms: number): void {
    this.cycleMs = Math.max(100, ms);
  }

  /**
   * 清除所有闪烁构件
   */
  clearAllBlinkParts(): void {
    const scene = this.context.getScene();
    if (!scene) return;

    this.stopAnimation();

    const oidsToUnhide = Array.from(this.blinkOids);

    for (const oid of oidsToUnhide) {
      const collector = this.context.getMeshCollectorByOid(oid);
      collector.meshes.forEach((mesh) => {
        const original = this.originalMaterialByMesh.get(mesh.uuid);
        if (original) {
          mesh.material = original;
          this.originalMaterialByMesh.delete(mesh.uuid);
        }
        if (mesh.parent === scene) scene.remove(mesh);
      });

      const handler = this.meshChangeHandlers.get(oid);
      if (handler) {
        this.meshChangeHandlers.delete(oid);
        collector.removeEventListener("mesh-change", handler);
      }
    }

    this.blinkOids.clear();
    this.context.showPartsByOids(oidsToUnhide);
  }

  dispose(): void {
    this.clearAllBlinkParts();
  }
}
