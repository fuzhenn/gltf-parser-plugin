/**
 * 冻结与隔离状态管理（仅做交互屏蔽判定，不涉及显隐）：
 * - 冻结（freeze）：集合内 OID 的交互被忽略
 * - 隔离（isolate）：集合非空时，仅集合内 OID 可交互
 */
export class PartInteractionFilter {
  private readonly _frozen = new Set<number>();
  private readonly _isolated = new Set<number>();

  /** OID 被屏蔽的原因：`frozen` 已冻结 / `isolated` 不在隔离集合内 / `null` 未屏蔽 */
  blockedReason(oid: number): "frozen" | "isolated" | null {
    if (this._frozen.has(oid)) return "frozen";
    if (this._isolated.size > 0 && !this._isolated.has(oid)) return "isolated";
    return null;
  }

  /** OID 是否被屏蔽（冻结命中，或不在隔离集合内） */
  isOidBlocked(oid: number): boolean {
    return this.blockedReason(oid) !== null;
  }

  freeze(oids: Iterable<number>): void {
    for (const oid of oids) this._frozen.add(oid);
  }

  unfreeze(oids: Iterable<number>): void {
    for (const oid of oids) this._frozen.delete(oid);
  }

  unfreezeAll(): void {
    this._frozen.clear();
  }

  isolate(oids: Iterable<number>): void {
    for (const oid of oids) this._isolated.add(oid);
  }

  unisolate(oids: Iterable<number>): void {
    for (const oid of oids) this._isolated.delete(oid);
  }

  unisolateAll(): void {
    this._isolated.clear();
  }
}
