import { EventDispatcher, Mesh } from "three";

/** 收集器查询：OID 范围 + 可选属性条件（语义同 setStyle 的 show / conditions 中的表达式字符串） */
export interface MeshCollectorQuery {
  /**
   * 限定在这些 OID 内收集；不传或空数组时，若提供 condition 则从全场景 OID 中筛选
   */
  oids?: readonly number[];
  /**
   * 属性表达式，如 `type === "wall"`，与 setStyle 里 `show` 或 `conditions[i][0]`（为 string 时）相同
   */
  condition?: string;
}

export interface MeshHelperHost {
  _registerCollector(collector: MeshCollector): void;
  _unregisterCollector(collector: MeshCollector): void;
  _getMeshesForCollectorQueryInternal(params: {
    oids: readonly number[];
    condition?: string;
  }): Mesh[];
}

export interface MeshChangeEvent {
  type: "mesh-change";
  meshes: Mesh[];
}

export type MeshCollectorEventMap = {
  "mesh-change": MeshChangeEvent;
};

/** 去重并排序 OID */
export function normalizeMeshCollectorOids(oids: readonly number[]): number[] {
  return [...new Set(oids)].sort((a, b) => a - b);
}

/**
 * 与 MeshCollector.getCacheKey()、插件 collectorCache 键一致
 */
export function meshCollectorQueryCacheKey(query: MeshCollectorQuery): string {
  const oidsNorm = normalizeMeshCollectorOids(query.oids ?? []);
  const oidPart = oidsNorm.length > 0 ? oidsNorm.join(",") : "*";
  const condRaw = query.condition?.trim() ?? "";
  const condPart = condRaw === "" ? "_" : encodeURIComponent(condRaw);
  return `${oidPart}@@${condPart}`;
}

/** @deprecated 请使用 meshCollectorQueryCacheKey({ oids }) */
export function meshCollectorGroupKey(oids: readonly number[]): string {
  return meshCollectorQueryCacheKey({ oids });
}

/**
 * MeshCollector - 按查询条件监听并收集 split mesh
 */
export class MeshCollector extends EventDispatcher<MeshCollectorEventMap> {
  private readonly queryOids: number[];
  private readonly condition: string | undefined;
  private readonly cacheKey: string;
  private plugin: MeshHelperHost;
  private _meshes: Mesh[] = [];
  private _disposed: boolean = false;

  constructor(query: MeshCollectorQuery, plugin: MeshHelperHost) {
    super();
    const oids = normalizeMeshCollectorOids(query.oids ?? []);
    const condition = query.condition?.trim() || undefined;
    if (oids.length === 0 && !condition) {
      throw new Error(
        "MeshCollector requires at least one OID in oids and/or a non-empty condition",
      );
    }
    this.queryOids = oids;
    this.condition = condition;
    this.cacheKey = meshCollectorQueryCacheKey({ oids, condition });
    this.plugin = plugin;

    plugin._registerCollector(this);

    this._updateMeshes();
  }

  getCacheKey(): string {
    return this.cacheKey;
  }

  /** 查询里显式传入的 OID（规范化后）；仅用 condition 筛选时可能为空数组 */
  getOids(): readonly number[] {
    return this.queryOids;
  }

  /** 有显式 OID 时返回第一个；否则无意义（可能为 undefined） */
  getOid(): number | undefined {
    return this.queryOids[0];
  }

  get meshes(): Mesh[] {
    return this._meshes;
  }

  /** 与 setStyle 一致的条件表达式（若有） */
  getCondition(): string | undefined {
    return this.condition;
  }

  _updateMeshes(): void {
    if (this._disposed) return;

    const newMeshes = this.plugin._getMeshesForCollectorQueryInternal({
      oids: this.queryOids,
      condition: this.condition,
    });

    const hasChanged =
      newMeshes.length !== this._meshes.length ||
      newMeshes.some((mesh: Mesh, i: number) => mesh !== this._meshes[i]);

    if (hasChanged) {
      this._meshes = newMeshes;
      this.dispatchEvent({ type: "mesh-change", meshes: this._meshes });
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.plugin._unregisterCollector(this);
    this._meshes = [];
  }
}
