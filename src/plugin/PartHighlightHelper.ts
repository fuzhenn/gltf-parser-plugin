import type { MeshCollector, MeshCollectorQuery } from "../MeshCollector";
import type { ColorInput } from "./PartColorHelper";
import {
  Color,
  Material,
  MeshStandardMaterial,
  Object3D,
} from "three";

/** 高亮材质：Three.js Material 或 { color, opacity } */
export type HighlightMaterial = Material | { color?: ColorInput; opacity?: number };

/** 高亮配置 */
export interface HighlightOptions {
  /** 高亮组名称，用于 cancelHighlight(name) 取消 */
  name: string;
  /** 构件 OID 数组 */
  ids: number[];
  /** 高亮材质，支持 Three.js Material 或 { color, opacity } */
  material: HighlightMaterial;
}

/** 内部使用：插件需提供的接口 */
interface PartHighlightHelperContext {
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

const highlightMaterialCache = new Map<string, MeshStandardMaterial>();

function getMaterialForHighlight(
  style: { color?: ColorInput; opacity?: number }
): MeshStandardMaterial {
  const color = style.color != null ? ensureColor(style.color) : new Color(0xffff00);
  const opacity = style.opacity != null ? Math.max(0, Math.min(1, style.opacity)) : 1;
  const key = `${color.getHex()}_${opacity}`;

  if (!highlightMaterialCache.has(key)) {
    const mat = new MeshStandardMaterial({
      color: color.clone(),
      roughness: 0.5,
      metalness: 0.1,
      opacity,
      transparent: opacity < 1,
    });
    highlightMaterialCache.set(key, mat);
  }
  return highlightMaterialCache.get(key)!;
}

function toMaterial(value: HighlightMaterial): Material {
  if (value instanceof Material) return value;
  return getMaterialForHighlight(value);
}

interface HighlightGroup {
  ids: Set<number>;
  material: Material;
}

/**
 * 构件高亮辅助器
 * 支持多组命名高亮，通过 hidePartsByOids + split mesh + 高亮材质实现
 */
export class PartHighlightHelper {
  private highlightGroups = new Map<string, HighlightGroup>();
  private materialByOid = new Map<number, Material>();
  private originalMaterialByMesh = new Map<string, Material>();
  private meshChangeHandlers = new Map<number, () => void>();

  constructor(private context: PartHighlightHelperContext) {}

  private mergeGroups(): { oids: number[]; materialByOid: Map<number, Material> } {
    const oids: number[] = [];
    const materialByOid = new Map<number, Material>();
    for (const group of this.highlightGroups.values()) {
      for (const oid of group.ids) {
        materialByOid.set(oid, group.material);
        oids.push(oid);
      }
    }
    return { oids: [...new Set(oids)], materialByOid };
  }

  private applyToMeshes(oid: number): void {
    const scene = this.context.getScene();
    if (!scene) return;

    const material = this.materialByOid.get(oid);
    if (!material) return;

    const collector = this.context.getMeshCollectorByOid(oid);
    collector.meshes.forEach((mesh) => {
      if (!this.originalMaterialByMesh.has(mesh.uuid)) {
        this.originalMaterialByMesh.set(mesh.uuid, mesh.material as Material);
      }
      mesh.material = material;
      if (!mesh.parent) scene.add(mesh);
    });
  }

  private removeOidsFromScene(oids: number[]): void {
    for (const oid of oids) {
      const collector = this.context.getMeshCollectorByOid(oid);
      collector.meshes.forEach((mesh) => {
        const original = this.originalMaterialByMesh.get(mesh.uuid);
        if (original) {
          mesh.material = original;
          this.originalMaterialByMesh.delete(mesh.uuid);
        }
        if (mesh.parent) mesh.parent.remove(mesh);
      });
    }
  }

  private unregisterOids(oids: number[]): void {
    for (const oid of oids) {
      const handler = this.meshChangeHandlers.get(oid);
      if (handler) {
        this.meshChangeHandlers.delete(oid);
        const collector = this.context.getMeshCollectorByOid(oid);
        collector.removeEventListener("mesh-change", handler);
      }
    }
  }

  private registerOids(oids: number[]): void {
    const scene = this.context.getScene();
    if (!scene) return;

    for (const oid of oids) {
      const collector = this.context.getMeshCollectorByOid(oid);
      if (!this.meshChangeHandlers.has(oid)) {
        const handler = () => this.applyToMeshes(oid);
        this.meshChangeHandlers.set(oid, handler);
        collector.addEventListener("mesh-change", handler);
      }
    }
  }

  /**
   * 高亮指定构件
   * @param options 高亮配置，包含 name、ids、material
   */
  highlight(options: HighlightOptions): void {
    const { name, ids, material } = options;
    const scene = this.context.getScene();
    if (!scene) return;

    const mat = toMaterial(material);

    // 若同名组已存在，先移除
    const existing = this.highlightGroups.get(name);
    if (existing) {
      this.removeOidsFromScene(Array.from(existing.ids));
      this.unregisterOids(Array.from(existing.ids));
      this.context.showPartsByOids(Array.from(existing.ids));
    }

    const newIds = new Set(ids);
    this.highlightGroups.set(name, { ids: newIds, material: mat });

    const { oids: allOids, materialByOid: newMaterialByOid } = this.mergeGroups();
    this.materialByOid = newMaterialByOid;

    for (const oid of newIds) {
      const collector = this.context.getMeshCollectorByOid(oid);
      collector.meshes.forEach((mesh) => {
        if (!this.originalMaterialByMesh.has(mesh.uuid)) {
          this.originalMaterialByMesh.set(mesh.uuid, mesh.material as Material);
        }
        mesh.material = mat;
        scene.add(mesh);
      });
    }

    this.registerOids(Array.from(newIds));
    this.context.hidePartsByOids(allOids);
  }

  /**
   * 取消指定名称的高亮
   * @param name 高亮组名称
   */
  cancelHighlight(name: string): void {
    const group = this.highlightGroups.get(name);
    if (!group) return;

    const cancelledOids = Array.from(group.ids);
    this.highlightGroups.delete(name);

    const { oids: remainingOids, materialByOid: newMaterialByOid } =
      this.mergeGroups();

    const oidsToRestore: number[] = [];
    const oidsToReapply: number[] = [];

    for (const oid of cancelledOids) {
      if (newMaterialByOid.has(oid)) {
        oidsToReapply.push(oid);
      } else {
        oidsToRestore.push(oid);
      }
    }

    this.removeOidsFromScene(cancelledOids);
    this.unregisterOids(oidsToRestore);

    this.materialByOid = newMaterialByOid;

    if (oidsToRestore.length > 0) {
      this.context.showPartsByOids(oidsToRestore);
    }

    if (remainingOids.length > 0) {
      this.context.hidePartsByOids(remainingOids);
      for (const oid of oidsToReapply) {
        this.applyToMeshes(oid);
      }
    }
  }

  /**
   * 取消所有高亮
   */
  cancelAllHighlight(): void {
    const allOids: number[] = [];
    for (const group of this.highlightGroups.values()) {
      allOids.push(...group.ids);
    }
    this.highlightGroups.clear();
    this.materialByOid.clear();
    this.removeOidsFromScene(allOids);
    this.unregisterOids(allOids);
    this.context.showPartsByOids(allOids);
  }

  /**
   * 瓦片加载完成后重新应用高亮（由插件调用）
   */
  onTilesLoadEnd(): void {
    if (this.highlightGroups.size === 0) return;
    const { materialByOid } = this.mergeGroups();
    this.materialByOid = materialByOid;
    for (const oid of materialByOid.keys()) {
      this.applyToMeshes(oid);
    }
  }

  dispose(): void {
    this.cancelAllHighlight();
  }
}
