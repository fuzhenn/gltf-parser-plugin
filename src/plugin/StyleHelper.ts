import type { MeshCollector } from "../MeshCollector";
import type { TilesRenderer } from "3d-tiles-renderer";
import type { ColorInput } from "./PartColorHelper";
import {
  Color,
  Material,
  MeshStandardMaterial,
  Object3D,
} from "three";

/** 条件样式值：Three.js Material 或 简单颜色/透明度对象 */
export type StyleValue = Material | { color?: ColorInput; opacity?: number };

/** 条件项：[条件表达式或 true, 样式值] */
export type StyleCondition = [string | boolean, StyleValue];

/** 样式配置 */
export interface StyleConfig {
  /** 可见性表达式，仅满足条件的构件显示，如 'foo === bar' */
  show?: string;
  /** 条件样式数组，第一个满足条件的应用对应样式；[true, material] 为默认样式 */
  conditions?: StyleCondition[];
}

/** 内部使用：插件需提供的接口 */
interface StyleHelperContext {
  getTiles(): TilesRenderer | null;
  getAllOidsFromTiles(): number[];
  getPropertyDataByOid(oid: number): Record<string, unknown> | null;
  hidePartsByOids(oids: number[]): void;
  showPartsByOids(oids: number[]): void;
  getMeshCollectorByOid(oid: number): MeshCollector;
  getScene(): Object3D | null;
}

function ensureColor(color: ColorInput): Color {
  if (color instanceof Color) return color;
  return new Color(color);
}

/** 根据 { color, opacity } 创建材质并缓存 */
const styleMaterialCache = new Map<string, MeshStandardMaterial>();

function getMaterialForStyle(style: { color?: ColorInput; opacity?: number }): MeshStandardMaterial {
  const colorHex = style.color != null ? ensureColor(style.color).getHex() : 0x888888;
  const opacity = style.opacity != null ? Math.max(0, Math.min(1, style.opacity)) : 1;
  const key = `${colorHex}_${opacity}`;

  if (!styleMaterialCache.has(key)) {
    const mat = new MeshStandardMaterial({
      color: colorHex,
      roughness: 0.5,
      metalness: 0.1,
      opacity,
      transparent: opacity < 1,
    });
    styleMaterialCache.set(key, mat);
  }
  return styleMaterialCache.get(key)!;
}

/**
 * 在 propertyData 上下文中安全求值表达式
 * 支持如 'foo === bar'、'foo == "bar1"'、'count > 10' 等
 */
function evaluateCondition(
  expr: string | boolean,
  propertyData: Record<string, unknown> | null
): boolean {
  if (expr === true) return true;
  if (expr === false) return false;
  if (typeof expr !== "string" || !expr.trim()) return true;

  const data = propertyData ?? {};
  const keys = Object.keys(data);
  const values = keys.map((k) => data[k]);

  try {
    const fn = new Function(...keys, `return Boolean(${expr})`);
    return fn(...values);
  } catch {
    return false;
  }
}

/**
 * 根据 conditions 和 propertyData 解析出应使用的样式值
 */
function resolveStyleValue(
  conditions: StyleCondition[],
  propertyData: Record<string, unknown> | null
): StyleValue | null {
  for (const [cond, value] of conditions) {
    if (evaluateCondition(cond, propertyData)) {
      return value;
    }
  }
  return null;
}

/**
 * 将 StyleValue 转为 Material
 */
function toMaterial(value: StyleValue): Material {
  if (value instanceof Material) return value;
  return getMaterialForStyle(value);
}

/**
 * 构件样式辅助器
 * 通过 show 表达式控制可见性，通过 conditions 应用条件样式
 */
export class StyleHelper {
  private style: StyleConfig | null = null;
  private styledOids = new Set<number>();
  private hiddenOids = new Set<number>();
  private materialByOid = new Map<number, Material>();
  private originalMaterialByMesh = new Map<string, Material>();
  private meshChangeHandlers = new Map<number, () => void>();

  constructor(private context: StyleHelperContext) {}

  /**
   * 设置样式
   * @param style 样式配置，传 null 或空对象清除样式
   */
  setStyle(style: StyleConfig | null): void {
    this.clearStyle();
    this.style = style;

    if (!style || (!style.show && (!style.conditions || style.conditions.length === 0))) {
      return;
    }

    this.applyStyle();
  }

  /**
   * 获取当前样式配置
   */
  getStyle(): StyleConfig | null {
    return this.style;
  }

  /**
   * 清除样式，恢复默认显示
   */
  clearStyle(): void {
    const scene = this.context.getScene();
    const styledOidsList = Array.from(this.styledOids);
    const hiddenOidsList = Array.from(this.hiddenOids);

    for (const oid of styledOidsList) {
      const collector = this.context.getMeshCollectorByOid(oid);
      collector.meshes.forEach((mesh) => {
        const original = this.originalMaterialByMesh.get(mesh.uuid);
        if (original) {
          mesh.material = original;
          this.originalMaterialByMesh.delete(mesh.uuid);
        }
        if (scene && mesh.parent === scene) scene.remove(mesh);
      });

      const handler = this.meshChangeHandlers.get(oid);
      if (handler) {
        this.meshChangeHandlers.delete(oid);
        collector.removeEventListener("mesh-change", handler);
      }
    }

    this.style = null;
    this.styledOids.clear();
    this.hiddenOids.clear();
    this.materialByOid.clear();
    this.context.showPartsByOids([...styledOidsList, ...hiddenOidsList]);
  }

  private applyStyle(): void {
    const style = this.style;
    if (!style) return;

    const scene = this.context.getScene();
    if (!scene) return;

    const allOids = this.context.getAllOidsFromTiles();
    const hiddenOidsList: number[] = [];
    const visibleOids: number[] = [];

    for (const oid of allOids) {
      const propertyData = this.context.getPropertyDataByOid(oid);
      const showExpr = style.show;

      if (showExpr) {
        const visible = evaluateCondition(showExpr, propertyData);
        if (!visible) {
          hiddenOidsList.push(oid);
          continue;
        }
      }

      visibleOids.push(oid);
    }

    this.hiddenOids = new Set(hiddenOidsList);
    // 隐藏不满足 show 的 + 需要应用样式的（用 split mesh 替换）
    this.context.hidePartsByOids([...hiddenOidsList, ...visibleOids]);

    for (const oid of visibleOids) {
      const propertyData = this.context.getPropertyDataByOid(oid);
      const conditions = style.conditions ?? [];
      const styleValue = resolveStyleValue(conditions, propertyData);

      if (!styleValue) continue;

      this.styledOids.add(oid);
      const material = toMaterial(styleValue);
      this.materialByOid.set(oid, material);

      const collector = this.context.getMeshCollectorByOid(oid);
      this.applyMaterialToCollector(collector, oid, material, scene);

      if (!this.meshChangeHandlers.has(oid)) {
        const handler = () => {
          const mat = this.materialByOid.get(oid);
          const s = this.context.getScene();
          if (mat && s) this.applyMaterialToCollector(collector, oid, mat, s);
        };
        this.meshChangeHandlers.set(oid, handler);
        collector.addEventListener("mesh-change", handler);
      }
    }
  }

  private applyMaterialToCollector(
    collector: MeshCollector,
    _oid: number,
    material: Material,
    scene: Object3D
  ): void {
    collector.meshes.forEach((mesh) => {
      if (!this.originalMaterialByMesh.has(mesh.uuid)) {
        this.originalMaterialByMesh.set(mesh.uuid, mesh.material as Material);
      }
      mesh.material = material;
      if (!mesh.parent) scene.add(mesh);
    });
  }

  /**
   * 瓦片加载完成后重新应用样式（由插件调用）
   */
  onTilesLoadEnd(): void {
    if (this.style) {
      this.applyStyle();
    }
  }

  dispose(): void {
    this.clearStyle();
  }
}
