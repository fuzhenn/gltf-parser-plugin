import { Mesh } from "three";
import type { MeshCollector } from "../MeshCollector";

export interface InteractionFilterContext {
  getCollectorCache(): Map<number, MeshCollector>;
}

/**
 * 冻结与隔离逻辑：管理构件的交互过滤及 getMeshCollectorByOid 获取的 mesh 在场景中的显隐
 */
export class InteractionFilter {
  private frozenOids = new Set<number>();
  private isolatedOids = new Set<number>();
  private trackedMeshes = new Map<number, Set<Mesh>>();
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

  private trackMesh(mesh: Mesh, oid: number): void {
    if (this.meshListeners.has(mesh)) return;

    const onAdded = () => {
      if (this.isPluginRemoving) return;
      mesh.userData._detachedParent = null;
      if (this.isOidBlocked(oid) && mesh.parent) {
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

  onCollectorMeshChange(oid: number, newMeshes: Mesh[]): void {
    const tracked = this.trackedMeshes.get(oid);
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
        this.trackMesh(mesh, oid);
        trackSet.add(mesh);
      }
    }
    this.trackedMeshes.set(oid, trackSet);
  }

  private syncCollectorMeshes(): void {
    this.isPluginRemoving = true;

    for (const [oid, collector] of this.context.getCollectorCache()) {
      const blocked = this.isOidBlocked(oid);

      for (const mesh of collector.meshes) {
        if (!this.meshListeners.has(mesh)) continue;

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

  onUnregisterCollector(oid: number): void {
    const tracked = this.trackedMeshes.get(oid);
    if (tracked) {
      for (const mesh of tracked) {
        this.untrackMesh(mesh);
      }
      this.trackedMeshes.delete(oid);
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
