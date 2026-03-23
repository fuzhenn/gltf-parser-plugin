import { Mesh } from "three";
import type { MeshCollector } from "../MeshCollector";

export interface InteractionFilterContext {
  getCollectorCache(): Map<string, MeshCollector>;
}

/**
 * 冻结与隔离逻辑：管理构件的交互过滤及 MeshCollector 获取的 mesh 在场景中的显隐
 * split mesh 使用 userData.oid（单 feature）或 userData.collectorOids（合并 mesh）：任一相关 OID 被冻结/隔离规则命中则整 mesh 脱离场景
 */
export class InteractionFilter {
  private frozenOids = new Set<number>();
  private isolatedOids = new Set<number>();
  /** 按 collector 分组键追踪 mesh */
  private trackedMeshes = new Map<string, Set<Mesh>>();
  private meshListeners = new Map<
    Mesh,
    { onAdded: () => void; onRemoved: () => void }
  >();
  private isPluginRemoving = false;

  constructor(private context: InteractionFilterContext) {}

  isOidBlocked(oid: number): boolean {
    if (this.frozenOids.has(oid)) return true;
    if (this.isolatedOids.size > 0 && !this.isolatedOids.has(oid)) return true;
    return false;
  }

  /** 合并 split：任一 collector OID 被 block 则整 mesh 视为应隐藏 */
  private isMeshInteractionBlocked(mesh: Mesh): boolean {
    const coids = mesh.userData?.collectorOids as number[] | undefined;
    if (coids && coids.length > 0) {
      return coids.some((oid) => this.isOidBlocked(oid));
    }
    const oid = mesh.userData?.oid as number | undefined;
    return oid !== undefined && this.isOidBlocked(oid);
  }

  private trackMesh(mesh: Mesh): void {
    if (this.meshListeners.has(mesh)) return;

    const onAdded = () => {
      if (this.isPluginRemoving) return;
      mesh.userData._detachedParent = null;
      if (this.isMeshInteractionBlocked(mesh) && mesh.parent) {
        const parent = mesh.parent;
        this.isPluginRemoving = true;
        mesh.userData._detachedParent = parent;
        parent.remove(mesh);
        this.isPluginRemoving = false;
      }
    };

    const onRemoved = () => {
      if (this.isPluginRemoving) return;
      mesh.userData._detachedParent = null;
    };

    mesh.addEventListener("added", onAdded);
    mesh.addEventListener("removed", onRemoved);
    this.meshListeners.set(mesh, { onAdded, onRemoved });
  }

  private untrackMesh(mesh: Mesh): void {
    const listeners = this.meshListeners.get(mesh);
    if (listeners) {
      mesh.removeEventListener("added", listeners.onAdded);
      mesh.removeEventListener("removed", listeners.onRemoved);
      this.meshListeners.delete(mesh);
    }
    mesh.userData._detachedParent = null;
  }

  onCollectorMeshChange(groupKey: string, newMeshes: Mesh[]): void {
    const tracked = this.trackedMeshes.get(groupKey);
    const newSet = new Set(newMeshes);

    if (tracked) {
      for (const mesh of tracked) {
        if (!newSet.has(mesh)) {
          this.untrackMesh(mesh);
          tracked.delete(mesh);
        }
      }
    }

    const trackSet = tracked || new Set<Mesh>();
    for (const mesh of newMeshes) {
      if (!trackSet.has(mesh)) {
        this.trackMesh(mesh);
        trackSet.add(mesh);
      }
    }
    this.trackedMeshes.set(groupKey, trackSet);
  }

  private syncCollectorMeshes(): void {
    this.isPluginRemoving = true;

    for (const [, collector] of this.context.getCollectorCache()) {
      for (const mesh of collector.meshes) {
        if (!this.meshListeners.has(mesh)) continue;

        const blocked = this.isMeshInteractionBlocked(mesh);

        if (blocked) {
          if (mesh.parent && !mesh.userData._detachedParent) {
            const parent = mesh.parent;
            mesh.userData._detachedParent = parent;
            parent.remove(mesh);
          }
        } else {
          const storedParent = mesh.userData._detachedParent;
          if (storedParent && !mesh.parent) {
            storedParent.add(mesh);
            mesh.userData._detachedParent = null;
          }
        }
      }
    }

    this.isPluginRemoving = false;
  }

  onUnregisterCollector(groupKey: string): void {
    const tracked = this.trackedMeshes.get(groupKey);
    if (tracked) {
      for (const mesh of tracked) {
        this.untrackMesh(mesh);
      }
      this.trackedMeshes.delete(groupKey);
    }
  }

  freezeByOids(oids: number[]): void {
    for (const oid of oids) {
      this.frozenOids.add(oid);
    }
    this.syncCollectorMeshes();
  }

  freezeByOid(oid: number): void {
    this.frozenOids.add(oid);
    this.syncCollectorMeshes();
  }

  unfreezeByOids(oids: number[]): void {
    for (const oid of oids) {
      this.frozenOids.delete(oid);
    }
    this.syncCollectorMeshes();
  }

  unfreezeByOid(oid: number): void {
    this.frozenOids.delete(oid);
    this.syncCollectorMeshes();
  }

  unfreeze(): void {
    this.frozenOids.clear();
    this.syncCollectorMeshes();
  }

  getFrozenOids(): number[] {
    return Array.from(this.frozenOids);
  }

  isolateByOids(oids: number[]): void {
    for (const oid of oids) {
      this.isolatedOids.add(oid);
    }
    this.syncCollectorMeshes();
  }

  isolateByOid(oid: number): void {
    this.isolatedOids.add(oid);
    this.syncCollectorMeshes();
  }

  unisolateByOids(oids: number[]): void {
    for (const oid of oids) {
      this.isolatedOids.delete(oid);
    }
    this.syncCollectorMeshes();
  }

  unisolateByOid(oid: number): void {
    this.isolatedOids.delete(oid);
    this.syncCollectorMeshes();
  }

  unisolate(): void {
    this.isolatedOids.clear();
    this.syncCollectorMeshes();
  }

  getIsolatedOids(): number[] {
    return Array.from(this.isolatedOids);
  }

  dispose(): void {
    for (const [, meshSet] of this.trackedMeshes) {
      for (const mesh of meshSet) {
        this.untrackMesh(mesh);
      }
    }
    this.trackedMeshes.clear();
    this.meshListeners.clear();
    this.frozenOids.clear();
    this.isolatedOids.clear();
  }
}
