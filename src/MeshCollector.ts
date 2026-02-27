import { EventDispatcher, Mesh } from "three";

export interface MeshHelperHost {
  _registerCollector(collector: MeshCollector): void;
  _unregisterCollector(collector: MeshCollector): void;
  _getMeshesByOidInternal(oid: number): Mesh[];
}

export interface MeshChangeEvent {
  type: "mesh-change";
  meshes: Mesh[];
}

export type MeshCollectorEventMap = {
  "mesh-change": MeshChangeEvent;
};

/**
 * MeshCollector - 用于监听和收集特定 oid 对应的 mesh
 * 随着瓦片变化，会自动更新 meshes 并触发 mesh-change 事件
 */
export class MeshCollector extends EventDispatcher<MeshCollectorEventMap> {
  private oid: number;
  private plugin: MeshHelperHost;
  private _meshes: Mesh[] = [];
  private _disposed: boolean = false;

  constructor(oid: number, plugin: MeshHelperHost) {
    super();
    this.oid = oid;
    this.plugin = plugin;

    plugin._registerCollector(this);

    this._updateMeshes();
  }

  get meshes(): Mesh[] {
    return this._meshes;
  }

  _updateMeshes(): void {
    if (this._disposed) return;

    const newMeshes = this.plugin._getMeshesByOidInternal(this.oid);

    const hasChanged =
      newMeshes.length !== this._meshes.length ||
      newMeshes.some((mesh: Mesh, i: number) => mesh !== this._meshes[i]);

    if (hasChanged) {
      this._meshes = newMeshes;
      this.dispatchEvent({ type: "mesh-change", meshes: this._meshes });
    }
  }

  getOid(): number {
    return this.oid;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.plugin._unregisterCollector(this);
    this._meshes = [];
  }
}
