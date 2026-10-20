/**
 * 默认同时处理的瓦片 buffer 总字节数上限：512KB
 */
export const DEFAULT_MAX_CONCURRENT_BYTES = 1024 * 1024;

/**
 * 排队任务条目
 */
interface QueuedTask {
  /** 任务权重（瓦片 buffer 字节数） */
  byteLength: number;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  /** 取消 abort 监听 */
  cleanupAbort?: () => void;
}

function createAbortError(): Error {
  const err = new Error("Tile parse aborted while queued");
  err.name = "AbortError";
  return err;
}

/**
 * 瓦片解析时间片调度器。
 *
 * 按 buffer 字节大小限制同时处理的瓦片（scene）数量：
 * 同时在途的瓦片 buffer 总字节数不超过 maxBytes（默认 1MB），
 * 超出预算的瓦片进入 FIFO 队列，等待在途任务完成释放额度后按序启动。
 *
 * - 单个瓦片自身超过预算时，仅在队列为空闲态（无在途任务）时放行，避免死锁；
 * - 排队中的任务若 abortSignal 触发，会从队列移除并以 AbortError 拒绝，不占用额度。
 */
export class TileParseScheduler {
  private readonly _maxBytes: number;
  private _activeBytes = 0;
  private _processedCount = 0;
  private readonly _queue: QueuedTask[] = [];

  constructor(maxBytes: number = DEFAULT_MAX_CONCURRENT_BYTES) {
    this._maxBytes = Math.max(1, maxBytes);
  }

  /** 当前在途瓦片的 buffer 字节总量 */
  get activeBytes(): number {
    return this._activeBytes;
  }

  /** 当前排队等待的瓦片数量 */
  get pendingCount(): number {
    return this._queue.length;
  }

  /**
   * 取出并清零自上次调用以来完成处理（含失败）的瓦片数量
   */
  consumeProcessedCount(): number {
    const count = this._processedCount;
    this._processedCount = 0;
    return count;
  }

  /**
   * 提交一个带权重（字节数）的解析任务，满足字节预算后执行。
   * @param byteLength 任务权重（瓦片 buffer 字节数）
   * @param task 实际解析任务
   * @param abortSignal 可选的中止信号（排队期间中止则跳过执行）
   */
  run<T>(
    byteLength: number,
    task: () => Promise<T> | T,
    abortSignal?: AbortSignal,
  ): Promise<T> {
    if (abortSignal?.aborted) {
      return Promise.reject(createAbortError());
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueuedTask = {
        byteLength,
        task: () => Promise.resolve(task()),
        resolve: resolve as (value: unknown) => void,
        reject,
      };

      const onAbort = () => {
        const index = this._queue.indexOf(entry);
        if (index !== -1) {
          this._queue.splice(index, 1);
          entry.cleanupAbort?.();
          reject(createAbortError());
        }
      };
      entry.cleanupAbort = () =>
        abortSignal?.removeEventListener("abort", onAbort);
      abortSignal?.addEventListener("abort", onAbort, { once: true });

      this._queue.push(entry);
      this._drain();
    });
  }

  /**
   * 从队首按序启动满足字节预算的任务
   */
  private _drain(): void {
    while (this._queue.length > 0) {
      const entry = this._queue[0];
      // 预算不足且已有在途任务时暂停启动；空闲态（无在途任务）时即使单瓦片超预算也放行
      if (
        this._activeBytes > 0 &&
        this._activeBytes + entry.byteLength > this._maxBytes
      ) {
        break;
      }

      this._queue.shift();
      this._activeBytes += entry.byteLength;
      entry.cleanupAbort?.();

      entry
        .task()
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this._activeBytes = Math.max(
            0,
            this._activeBytes - entry.byteLength,
          );
          this._processedCount += 1;
          this._drain();
        });
    }
  }
}
