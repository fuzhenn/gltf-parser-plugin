import {
  normalizeMeshCollectorOids,
  type MeshCollector,
  type MeshCollectorQuery,
} from "../MeshCollector";
import type { TilesRenderer } from "3d-tiles-renderer";
import { getPropertyDataMapFromTiles } from "../mesh-helper/mesh";
import type { ColorInput } from "../utils/color-input";
import { toColor } from "../utils/color-input";
import { evaluateStyleCondition } from "./style-condition-eval";
import { Material, MeshStandardMaterial, Object3D } from "three";

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
  hidePartsByOids(oids: number[]): void;
  showPartsByOids(oids: number[]): void;
  getMeshCollectorByCondition(query: MeshCollectorQuery): MeshCollector;
  getScene(): Object3D | null;
}

/** 根据 { color, opacity } 创建材质并缓存 */
const styleMaterialCache = new Map<string, MeshStandardMaterial>();

function getMaterialForStyle(style: { color?: ColorInput; opacity?: number }): MeshStandardMaterial {
  const colorHex = style.color != null ? toColor(style.color).getHex() : 0x888888;
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
 * 根据 conditions 和 propertyData 解析出应使用的样式值
 */
function resolveStyleValue(
  conditions: StyleCondition[],
  propertyData: Record<string, unknown> | null
): StyleValue | null {
  for (const [cond, value] of conditions) {
    if (evaluateStyleCondition(cond, propertyData)) {
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
  /** 当前样式配置，可通过 plugin.style 获取 */
  style: StyleConfig | null = null;
  private styledOids = new Set<number>();
  private hiddenOids = new Set<number>();
  private materialByOid = new Map<number, Material>();
  private originalMaterialByMesh = new Map<string, Material>();
  /** 按材质分组后的收集器，key 与 collector.getCacheKey() 一致 */
  private meshChangeHandlers = new Map<string, () => void>();
  /** 当前样式占用的收集器（用于 clearStyle / 下次 applyStyle 前卸载监听） */
  private styleCollectors: MeshCollector[] = [];

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
   * 清除样式，恢复默认显示
   */
  clearStyle(): void {
    const scene = this.context.getScene();
    const styledOidsList = Array.from(this.styledOids);
    const hiddenOidsList = Array.from(this.hiddenOids);

    for (const collector of this.styleCollectors) {
      collector.meshes.forEach((mesh) => {
        const original = this.originalMaterialByMesh.get(mesh.uuid);
        if (original) {
          mesh.material = original;
          this.originalMaterialByMesh.delete(mesh.uuid);
        }
        if (scene && mesh.parent === scene) scene.remove(mesh);
      });

      const handler = this.meshChangeHandlers.get(collector.getCacheKey());
      if (handler) {
        collector.removeEventListener("mesh-change", handler);
      }
    }
    this.meshChangeHandlers.clear();
    this.styleCollectors = [];

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

    const tiles = this.context.getTiles();
    if (!tiles) return;

    // 一次场景 traverse 构建 oid→属性；后续对 Map 单次遍历同时做 show 筛选 + conditions 分组
    const propertyByOid = getPropertyDataMapFromTiles(tiles);

    // 瓦片更新后重复 apply 时先卸掉旧监听，避免堆积
    for (const collector of this.styleCollectors) {
      const h = this.meshChangeHandlers.get(collector.getCacheKey());
      if (h) collector.removeEventListener("mesh-change", h);
    }
    this.styleCollectors = [];
    this.meshChangeHandlers.clear();

    const hiddenOidsList: number[] = [];
    /** 相同解析材质（uuid）的 OID 合并，共用一条 MeshCollector */
    const groups = new Map<
      string,
      { material: Material; oids: number[] }
    >();

    const conditions = style.conditions ?? [];

    for (const [oid, propertyData] of propertyByOid) {
      if (style.show) {
        if (!evaluateStyleCondition(style.show, propertyData)) {
          hiddenOidsList.push(oid);
          continue;
        }
      }

      const styleValue = resolveStyleValue(conditions, propertyData);
      if (!styleValue) continue;

      this.styledOids.add(oid);
      const material = toMaterial(styleValue);
      this.materialByOid.set(oid, material);

      const gkey = material.uuid;
      let g = groups.get(gkey);
      if (!g) {
        g = { material, oids: [] };
        groups.set(gkey, g);
      }
      g.oids.push(oid);
    }

    this.hiddenOids = new Set(hiddenOidsList);
    const oidsToHide = [...hiddenOidsList];
    for (const { oids } of groups.values()) {
      oidsToHide.push(...oids);
    }

    for (const { material, oids } of groups.values()) {
      const sortedOids = normalizeMeshCollectorOids(oids);
      const collector = this.context.getMeshCollectorByCondition({
        oids: sortedOids,
      });
      this.applyMaterialToCollector(collector, material, scene);
      this.styleCollectors.push(collector);

      const cacheKey = collector.getCacheKey();
      const handler = () => {
        const s = this.context.getScene();
        if (s) this.applyMaterialToCollector(collector, material, s);
      };
      this.meshChangeHandlers.set(cacheKey, handler);
      collector.addEventListener("mesh-change", handler);
    }

    // 只隐藏不满足 show 的 + 需要应用样式的（用 split mesh 替换）
    this.context.hidePartsByOids(oidsToHide);
  }

  private applyMaterialToCollector(
    collector: MeshCollector,
    material: Material,
    scene: Object3D
  ): void {
    collector.meshes.forEach((mesh) => {
      if (!this.originalMaterialByMesh.has(mesh.uuid)) {
        this.originalMaterialByMesh.set(mesh.uuid, mesh.material as Material);
      }
      mesh.material = material;
     scene.add(mesh);
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
