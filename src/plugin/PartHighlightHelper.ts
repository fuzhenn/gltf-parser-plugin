import {
  MESH_CACHE_NAMESPACE_HIGHLIGHT,
  normalizeMeshCollectorOids,
  type MeshCollector,
} from "../MeshCollector";
import { getPropertyDataMapFromTiles } from "../mesh-helper/mesh";
import type { StyleCondition } from "./style-appearance-types";
import {
  buildStyleConditionEvaluatorMap,
  evaluateStyleCondition,
} from "./style-condition-eval";
import type { PartEffectHost } from "./part-effect-host";
import type { ColorInput } from "../utils/color-input";
import { toColor } from "../utils/color-input";
import {
  Color,
  Euler,
  Material,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from "three";
import type {
  StyleAppearance,
  StyleEulerInput,
  StyleMaterialResolver,
  StyleMeshFactory,
  StyleVec3Input,
} from "./style-appearance-types";
import {
  appearanceGroupKey,
  applyEuler,
  applyStyleAppearanceToMesh,
  applyVec3,
  buildPivotStyleMatrix,
  eulerKey,
  restoreMeshAppearanceMaps,
  vec3Key,
  type MeshAppearanceMaps,
  type StoredTransform,
} from "./style-appearance-shared";

/** 高亮材质：Three.js Material 或 { color, opacity } */
export type HighlightMaterial = Material | { color?: ColorInput; opacity?: number };

/** 条件命中后的外观：材质可为简写、函数或 Material（可省略）；位姿与 setStyle 一致 */
export interface HighlightAppearance {
  material?: HighlightMaterial | StyleMaterialResolver;
  /**
   * 直接以颜色定义材质（可被 JSON 序列化），与 `material` 同级。
   * - 仅提供 `color`：使用默认 `MeshStandardMaterial` 并应用该颜色；
   * - 同时提供 `color` 与 `material`：解析 material 后把颜色写入其 `.color`（若存在），
   *   传入 Material 实例或简写时会内部克隆，不污染入参/缓存。
   */
  color?: ColorInput;
  mesh?: StyleMeshFactory;
  translation?: StyleVec3Input;
  scale?: StyleVec3Input;
  rotation?: StyleEulerInput;
  origin?: StyleVec3Input;
}

export type HighlightCondition = [string | boolean, HighlightAppearance];

/**
 * 高亮配置：语义与 setStyle 相似，多一个 name 用于命名分组
 *
 * 与 setStyle 的关键差异：`conditions` 中**所有**命中的条目都会各自生效，
 * 分别创建独立的 MeshCollector 与 split mesh 实例，视觉上叠加；
 * 典型用途如"填充 + 线框"同时存在（见 `src/plugin/demo.html`）。
 */
export interface HighlightOptions {
  /** 高亮组名称，用于 cancelHighlight(name) 取消 */
  name: string;
  /** 可见性表达式，仅满足条件的构件参与高亮，如 'foo === bar' */
  show?: string;
  /** 条件外观数组；所有命中的条目都会各自生效并叠加渲染；`[true, appearance]` 为默认 */
  conditions?: HighlightCondition[];
  /** 若指定，仅在这些 OID 与属性数据的交集中应用（与 conditions 组合） */
  oids?: number[];
}

const highlightMaterialCache = new Map<string, MeshStandardMaterial>();

function getMaterialForHighlight(
  style: { color?: ColorInput; opacity?: number },
): MeshStandardMaterial {
  const color = style.color != null ? toColor(style.color) : new Color(0xffff00);
  const opacity =
    style.opacity != null ? Math.max(0, Math.min(1, style.opacity)) : 1;
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

function toStyleAppearance(ha: HighlightAppearance): StyleAppearance {
  const mat = ha.material;
  const appearance: StyleAppearance = {
    mesh: ha.mesh,
    translation: ha.translation,
    scale: ha.scale,
    rotation: ha.rotation,
    origin: ha.origin,
  };
  if (ha.color !== undefined) {
    appearance.color = ha.color;
  }
  if (mat !== undefined) {
    appearance.material =
      typeof mat === "function"
        ? mat
        : mat instanceof Material
          ? mat
          : toMaterial(mat);
  }
  return appearance;
}

interface HighlightGroupConfig {
  show?: string;
  conditions?: HighlightCondition[];
  oids?: number[];
}

function cloneHighlightOptions(options: HighlightOptions): HighlightOptions {
  return {
    name: options.name,
    show: options.show,
    conditions: options.conditions?.map(
      ([c, h]): HighlightCondition => [c, { ...h }],
    ),
    oids: options.oids?.slice(),
  };
}

function highlightAppearanceNeedsTransform(ha: HighlightAppearance): boolean {
  return (
    ha.translation !== undefined ||
    ha.scale !== undefined ||
    ha.rotation !== undefined
  );
}

function highlightAppearanceTransformKey(ha: HighlightAppearance): string {
  return `${vec3Key(ha.translation)}|${vec3Key(ha.scale)}|${eulerKey(ha.rotation)}|${vec3Key(ha.origin)}`;
}

/**
 * 与 {@link applyStyleAppearanceToMesh} 一致：基准为单位变换时，仅由 TRS 与 origin 枢轴得到的局部矩阵，列主序 16 个数（Three.js `Matrix4.elements` 顺序）。
 */
function localMatrix16FromHighlightAppearance(
  ha: HighlightAppearance,
): number[] | undefined {
  if (!highlightAppearanceNeedsTransform(ha)) return undefined;

  const obj = new Object3D();
  const hasScaleOrRotation =
    ha.scale !== undefined || ha.rotation !== undefined;

  if (hasScaleOrRotation) {
    const pivot = new Vector3();
    if (ha.origin !== undefined) {
      applyVec3(pivot, ha.origin);
    } else {
      pivot.set(0, 0, 0);
    }

    let sx = 1;
    let sy = 1;
    let sz = 1;
    if (ha.scale !== undefined) {
      if (Array.isArray(ha.scale)) {
        sx = ha.scale[0] ?? 1;
        sy = ha.scale[1] ?? 1;
        sz = ha.scale[2] ?? 1;
      } else {
        const sc = ha.scale as Vector3;
        sx = sc.x;
        sy = sc.y;
        sz = sc.z;
      }
    }

    const euler = new Euler();
    if (ha.rotation !== undefined) {
      applyEuler(euler, ha.rotation);
    } else {
      euler.set(0, 0, 0);
    }

    const styleM = buildPivotStyleMatrix(pivot, sx, sy, sz, euler);
    obj.updateMatrix();
    obj.matrix.multiply(styleM);
    obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
  }

  if (ha.translation !== undefined) {
    applyVec3(obj.position, ha.translation);
  }

  obj.updateMatrix();
  return Array.from(obj.matrix.elements);
}

/**
 * 构件高亮辅助器
 * 与 setStyle 相同的 show / conditions / 位姿语义，多组命名高亮；底层通过 hidePartsByOids + split mesh 实现
 */
export class PartHighlightHelper {
  private highlightGroups = new Map<string, HighlightGroupConfig>();
  /** 最近一次 highlight(name, …) 传入的完整参数，供 getHighlightConfigByName 读取 */
  private highlightConfigByName = new Map<string, HighlightOptions>();

  private originalMaterialByMesh = new Map<string, Material>();
  private originalTransformByMesh = new Map<string, StoredTransform>();
  private meshChangeHandlers = new Map<string, () => void>();
  private highlightCollectors: MeshCollector[] = [];
  /** 上次 hidePartsByOids 传入的 OID 列表，用于重新应用前 showParts */
  private lastHiddenOids: number[] = [];

  constructor(private context: PartEffectHost) {}

  private getMaps(): MeshAppearanceMaps {
    return {
      originalMaterialByMesh: this.originalMaterialByMesh,
      originalTransformByMesh: this.originalTransformByMesh,
    };
  }

  /**
   * 聚合所有命名 highlight 组产出的外观分组，并返回涉及的 OID 集合（用于隐藏原片）。
   *
   * `conditions` 中所有命中的条目都会各自进入对应 `appearanceGroupKey` 分组，
   * 每个分组独立创建 MeshCollector / split mesh，实现多外观叠加（如填充 + 线框）。
   */
  private buildAppearanceGroups(
    propertyByOid: Map<number, Record<string, unknown> | null>,
  ): {
    groups: Map<string, { appearance: StyleAppearance; oids: number[] }>;
    styledOids: Set<number>;
  } {
    const groupsByKey = new Map<
      string,
      { appearance: StyleAppearance; oids: Set<number> }
    >();
    const styledOids = new Set<number>();

    for (const [, hl] of this.highlightGroups) {
      const evaluators = buildStyleConditionEvaluatorMap({
        show: hl.show,
        conditions: (hl.conditions ?? []) as StyleCondition[],
      });
      const conditions = (hl.conditions ?? []).map(
        ([c, h]): [string | boolean, StyleAppearance] => [
          c,
          toStyleAppearance(h),
        ],
      );
      const oidsSet = hl.oids ? new Set(hl.oids) : null;

      for (const [oid, propertyData] of propertyByOid) {
        if (propertyData == null) continue;
        if (oidsSet && !oidsSet.has(oid)) continue;
        if (
          hl.show &&
          !evaluateStyleCondition(hl.show, propertyData, evaluators)
        )
          continue;

        for (const [cond, appearance] of conditions) {
          if (!evaluateStyleCondition(cond, propertyData, evaluators)) continue;
          const gkey = appearanceGroupKey(appearance);
          let g = groupsByKey.get(gkey);
          if (!g) {
            g = { appearance, oids: new Set() };
            groupsByKey.set(gkey, g);
          }
          g.oids.add(oid);
          styledOids.add(oid);
        }
      }
    }

    const groups = new Map<
      string,
      { appearance: StyleAppearance; oids: number[] }
    >();
    for (const [gkey, g] of groupsByKey) {
      groups.set(gkey, { appearance: g.appearance, oids: [...g.oids] });
    }

    return { groups, styledOids };
  }

  /** 各组 show 失败需隐藏的 OID（与 setStyle 一致：show 不满足则隐藏原片） */
  private collectUnionShowHide(
    propertyByOid: Map<number, Record<string, unknown> | null>,
  ): Set<number> {
    const unionHide = new Set<number>();
    for (const [, hl] of this.highlightGroups) {
      const evaluators = buildStyleConditionEvaluatorMap({
        show: hl.show,
        conditions: (hl.conditions ?? []) as StyleCondition[],
      });
      const oidsSet = hl.oids ? new Set(hl.oids) : null;
      for (const [oid, propertyData] of propertyByOid) {
        if (propertyData == null) continue;
        if (oidsSet && !oidsSet.has(oid)) continue;
        if (
          hl.show &&
          !evaluateStyleCondition(hl.show, propertyData, evaluators)
        ) {
          unionHide.add(oid);
        }
      }
    }
    return unionHide;
  }

  private clearCollectorsAndRestoreMeshes(): void {
    const maps = this.getMaps();
    for (const collector of this.highlightCollectors) {
      collector.meshes.forEach((mesh) => {
        restoreMeshAppearanceMaps(mesh, maps);
        mesh.removeFromParent();
      });
      const handler = this.meshChangeHandlers.get(
        collector.getInteractionGroupKey(),
      );
      if (handler) {
        collector.removeEventListener("mesh-change", handler);
      }
      this.context.releaseMeshCollector(collector);
    }
    this.meshChangeHandlers.clear();
    this.highlightCollectors = [];
  }

  private reapplyAll(): void {
    this.clearCollectorsAndRestoreMeshes();

    if (this.lastHiddenOids.length > 0) {
      this.context.showPartsByOids(this.lastHiddenOids);
    }

    if (this.highlightGroups.size === 0) {
      this.lastHiddenOids = [];
      return;
    }

    const tiles = this.context.getTiles();
    const scene = this.context.getRootGroup();
    if (!tiles || !scene) return;

    const propertyByOid = getPropertyDataMapFromTiles(
      tiles,
      this.context.getPropertyEnricher?.(),
    );
    const { groups, styledOids } = this.buildAppearanceGroups(propertyByOid);
    const unionHide = this.collectUnionShowHide(propertyByOid);

    const oidsToHide = [...new Set([...styledOids, ...unionHide])];
    this.lastHiddenOids = oidsToHide;

    const maps = this.getMaps();

    for (const { appearance, oids } of groups.values()) {
      const sortedOids = normalizeMeshCollectorOids(oids);
      const collector = this.context.getMeshCollectorByCondition({
        oids: sortedOids,
        meshCacheNamespace: MESH_CACHE_NAMESPACE_HIGHLIGHT,
      });
      this.highlightCollectors.push(collector);

      const groupKey = collector.getInteractionGroupKey();
      const handler = () => {
        const s = this.context.getRootGroup();
        if (!s) return;
        collector.meshes.forEach((mesh) => {
          applyStyleAppearanceToMesh(mesh, appearance, s, maps);
        });
      };
      this.meshChangeHandlers.set(groupKey, handler);
      collector.addEventListener("mesh-change", handler);
      handler();
    }

    this.context.hidePartsByOids(oidsToHide);
  }

  /**
   * 高亮指定构件（语义与 setStyle 一致，多 name 参数）
   */
  highlight(options: HighlightOptions): void {
    const { name, show, conditions, oids } = options;
    if (!show && (!conditions || conditions.length === 0)) {
      this.cancelHighlight(name);
      return;
    }

    this.highlightGroups.set(name, { show, conditions, oids });
    this.highlightConfigByName.set(name, cloneHighlightOptions(options));
    this.reapplyAll();
  }

  /**
   * 按名称获取最近一次 highlight 传入的配置（取消高亮后不再可用）
   */
  getHighlightConfigByName(name: string): HighlightOptions | undefined {
    const saved = this.highlightConfigByName.get(name);
    return saved ? cloneHighlightOptions(saved) : undefined;
  }

  /**
   * 按名称从已保存的 highlight 配置中取出位姿矩阵（列主序 16 个数，同 Three.js Matrix4）。
   * 仅当 `conditions` 里所有「含 translation / scale / rotation」的外观其 TRS+origin 完全一致时返回；否则返回 undefined。
   */
  getHighlightMatrixByName(name: string): number[] | undefined {
    const saved = this.highlightConfigByName.get(name);
    if (!saved?.conditions?.length) return undefined;

    let matrix: number[] | undefined;
    let seenKey: string | undefined;

    for (const [, ha] of saved.conditions) {
      if (!highlightAppearanceNeedsTransform(ha)) continue;
      const m = localMatrix16FromHighlightAppearance(ha);
      if (!m) continue;
      const k = highlightAppearanceTransformKey(ha);
      if (seenKey === undefined) {
        seenKey = k;
        matrix = m;
      } else if (seenKey !== k) {
        return undefined;
      }
    }

    return matrix ? matrix.slice() : undefined;
  }

  /**
   * 取消指定名称的高亮
   */
  cancelHighlight(name: string): void {
    this.highlightConfigByName.delete(name);
    if (!this.highlightGroups.has(name)) return;
    this.highlightGroups.delete(name);
    this.reapplyAll();
  }

  /**
   * 取消所有高亮
   */
  cancelAllHighlight(): void {
    this.highlightGroups.clear();
    this.highlightConfigByName.clear();
    this.reapplyAll();
  }

  /**
   * 瓦片加载完成后重新应用高亮（由插件调用）
   */
  onTilesLoadEnd(): void {
    if (this.highlightGroups.size === 0) return;
    this.reapplyAll();
  }

  dispose(): void {
    this.cancelAllHighlight();
  }
}
