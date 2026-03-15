import type { MeshCollector } from "../MeshCollector";
import {
  Color,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
} from "three";

export type ColorInput = number | string | Color;

/** 内部使用：插件需提供的接口 */
interface ComponentColorHelperContext {
  hideByOids(oids: number[]): void;
  unhideByOids(oids: number[]): void;
  getMeshCollectorByOid(oid: number): MeshCollector;
  getScene(): Object3D | null;
}

function ensureColor(color: ColorInput): Color {
  if (color instanceof Color) return color;
  return new Color(color);
}

function getMaterials(mesh: Mesh): Material[] {
  const mat = mesh.material;
  if (!mat) return [];
  return Array.isArray(mat) ? mat : [mat];
}

/** 根据颜色创建材质，相同颜色复用同一材质 */
function getMaterialForColor(color: Color): MeshStandardMaterial {
  const key = color.getHex();
  if (!materialCache.has(key)) {
    materialCache.set(key, new MeshStandardMaterial({
      color: color.clone(),
      roughness: 0.5,
      metalness: 0.1,
    }));
  }
  return materialCache.get(key)!;
}

const materialCache = new Map<number, MeshStandardMaterial>();

/**
 * 构件着色/透明度辅助器，参考 example 逻辑：hideByOids -> 修改材质 -> scene.add -> mesh-change 监听
 * 由 GLTFParserPlugin 内部使用，scene 通过 tiles.group 获取
 */
export class ComponentColorHelper {
  private coloredOids = new Set<number>();
  private materialByOid = new Map<number, MeshStandardMaterial>();
  private originalMaterialByMesh = new Map<string, Material>();
  private opacityModifiedOids = new Set<number>();
  private opacityByOid = new Map<number, number>();
  private originalOpacityByMaterial = new Map<Material, number>();
  private meshChangeHandlers = new Map<number, () => void>();

  constructor(private context: ComponentColorHelperContext) {}

  private getAllModifiedOids(): number[] {
    return Array.from(new Set([...this.coloredOids, ...this.opacityModifiedOids]));
  }

  private applyToMeshes(oid: number): void {
    const scene = this.context.getScene();
    if (!scene) return;

    const collector = this.context.getMeshCollectorByOid(oid);

    const colorMaterial = this.materialByOid.get(oid);
    const opacity = this.opacityByOid.get(oid);

    collector.meshes.forEach((mesh) => {
      if (!mesh.parent) scene.add(mesh);

      if (colorMaterial) {
        mesh.material = colorMaterial;
      }

      if (opacity !== undefined) {
        for (const mat of getMaterials(mesh)) {
          if (!this.originalOpacityByMaterial.has(mat)) {
            this.originalOpacityByMaterial.set(mat, mat.opacity);
          }
          mat.opacity = opacity;
          mat.transparent = opacity < 1;
        }
      }
    });
  }

  /**
   * 根据 oid 数组设置构件颜色
   * 隐藏原 mesh，将 split mesh 替换材质后加入场景
   */
  setComponentColorByOids(oids: number[], color: ColorInput): void {
    const scene = this.context.getScene();
    if (!scene) return;

    const threeColor = ensureColor(color);
    const material = getMaterialForColor(threeColor);

    for (const oid of oids) {
      this.coloredOids.add(oid);
      this.materialByOid.set(oid, material);

      const collector = this.context.getMeshCollectorByOid(oid);
      collector.meshes.forEach((mesh) => {
        if (!this.originalMaterialByMesh.has(mesh.uuid)) {
          this.originalMaterialByMesh.set(mesh.uuid, mesh.material as Material);
        }
        mesh.material = material;
        scene.add(mesh);
      });

      if (!this.meshChangeHandlers.has(oid)) {
        const handler = () => this.applyToMeshes(oid);
        this.meshChangeHandlers.set(oid, handler);
        collector.addEventListener("mesh-change", handler);
      }
    }

    this.context.hideByOids(this.getAllModifiedOids());
  }

  /**
   * 恢复指定构件的颜色
   * 若该 oid 已无颜色且无透明度修改，则从场景移除 split mesh 并 unhide 原 mesh
   */
  restoreComponentColorByOids(oids: number[]): void {
    const scene = this.context.getScene();
    if (!scene) return;

    for (const oid of oids) {
      this.coloredOids.delete(oid);
      this.materialByOid.delete(oid);

      const collector = this.context.getMeshCollectorByOid(oid);
      const opacity = this.opacityByOid.get(oid);

      collector.meshes.forEach((mesh) => {
        const originalMat = this.originalMaterialByMesh.get(mesh.uuid);
        if (originalMat) {
          mesh.material = originalMat;
          this.originalMaterialByMesh.delete(mesh.uuid);
          if (opacity !== undefined) {
            for (const mat of getMaterials(mesh)) {
              if (!this.originalOpacityByMaterial.has(mat)) {
                this.originalOpacityByMaterial.set(mat, mat.opacity);
              }
              mat.opacity = opacity;
              mat.transparent = opacity < 1;
            }
          }
        }
        if (
          !this.coloredOids.has(oid) &&
          !this.opacityModifiedOids.has(oid) &&
          mesh.parent === scene
        ) {
          scene.remove(mesh);
        }
      });

      if (!this.coloredOids.has(oid) && !this.opacityModifiedOids.has(oid)) {
        const handler = this.meshChangeHandlers.get(oid);
        if (handler) {
          this.meshChangeHandlers.delete(oid);
          collector.removeEventListener("mesh-change", handler);
        }
      }
    }

    this.context.unhideByOids(oids);
  }

  /**
   * 根据 oid 数组设置构件透明度
   * 隐藏原 mesh，将 split mesh 修改材质透明度后加入场景
   * @param oids 构件 OID 数组
   * @param opacity 透明度，0-1，0 完全透明，1 完全不透明
   */
  setComponentOpacityByOids(oids: number[], opacity: number): void {
    const scene = this.context.getScene();
    if (!scene) return;

    const clampedOpacity = Math.max(0, Math.min(1, opacity));

    for (const oid of oids) {
      this.opacityModifiedOids.add(oid);
      this.opacityByOid.set(oid, clampedOpacity);

      const colorMat = this.materialByOid.get(oid);
      if (colorMat && colorMat.opacity !== clampedOpacity) {
        const clone = colorMat.clone();
        clone.opacity = clampedOpacity;
        clone.transparent = clampedOpacity < 1;
        this.materialByOid.set(oid, clone);
        this.originalOpacityByMaterial.set(clone, 1);
      }

      const collector = this.context.getMeshCollectorByOid(oid);
      collector.meshes.forEach((mesh) => {
        if (!mesh.parent) scene.add(mesh);
        const mat = colorMat
          ? (this.materialByOid.get(oid) as Material)
          : (mesh.material as Material);
        if (!this.originalOpacityByMaterial.has(mat)) {
          this.originalOpacityByMaterial.set(mat, mat.opacity);
        }
        mat.opacity = clampedOpacity;
        mat.transparent = clampedOpacity < 1;
        if (colorMat) mesh.material = mat;
      });

      if (!this.meshChangeHandlers.has(oid)) {
        const handler = () => this.applyToMeshes(oid);
        this.meshChangeHandlers.set(oid, handler);
        collector.addEventListener("mesh-change", handler);
      }
    }

    this.context.hideByOids(this.getAllModifiedOids());
  }

  /**
   * 恢复指定构件的透明度
   * 若该 oid 已无颜色且无透明度修改，则从场景移除 split mesh 并 unhide 原 mesh
   */
  restoreComponentOpacityByOids(oids: number[]): void {
    const scene = this.context.getScene();
    if (!scene) return;

    for (const oid of oids) {
      this.opacityModifiedOids.delete(oid);
      this.opacityByOid.delete(oid);

      const collector = this.context.getMeshCollectorByOid(oid);
      collector.meshes.forEach((mesh) => {
        for (const mat of getMaterials(mesh)) {
          const original = this.originalOpacityByMaterial.get(mat);
          if (original !== undefined) {
            mat.opacity = original;
            mat.transparent = original < 1;
            this.originalOpacityByMaterial.delete(mat);
          }
        }
        if (
          !this.coloredOids.has(oid) &&
          !this.opacityModifiedOids.has(oid) &&
          mesh.parent === scene
        ) {
          scene.remove(mesh);
        }
      });

      if (!this.coloredOids.has(oid) && !this.opacityModifiedOids.has(oid)) {
        const handler = this.meshChangeHandlers.get(oid);
        if (handler) {
          this.meshChangeHandlers.delete(oid);
          collector.removeEventListener("mesh-change", handler);
        }
      }
    }

    this.context.unhideByOids(oids);
  }
}
