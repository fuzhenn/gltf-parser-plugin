/**
 * 深度遍历 payload，收集所有 TypedArray / ArrayBuffer 的底层 buffer（去重）。
 * 用于 worker postMessage 的 transferables，避免 structured clone 拷贝大数组。
 */
export function collectTransferables(
  root: unknown,
  buffers: Set<ArrayBuffer> = new Set(),
  seen: WeakSet<object> = new WeakSet(),
): ArrayBuffer[] {
  if (root == null) return [...buffers];

  if (ArrayBuffer.isView(root)) {
    buffers.add(root.buffer as ArrayBuffer);
    return [...buffers];
  }

  if (root instanceof ArrayBuffer) {
    buffers.add(root);
    return [...buffers];
  }

  if (typeof root !== "object") return [...buffers];

  if (seen.has(root)) return [...buffers];
  seen.add(root);

  if (Array.isArray(root)) {
    for (const item of root) {
      collectTransferables(item, buffers, seen);
    }
    return [...buffers];
  }

  for (const value of Object.values(root)) {
    collectTransferables(value, buffers, seen);
  }

  return [...buffers];
}
