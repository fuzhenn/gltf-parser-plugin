/**
 * 键盘输入管理类
 * ------------------------------------------------------------
 * 职责：
 *   1. 统一维护「当前按下的按键集合」，供逻辑层轮询（has / hasAny）；
 *   2. 支持注册「单次按下」回调（onPress），长按只触发一次；
 *   3. 对指定按键阻止浏览器默认行为（页面滚动、焦点移动等）；
 *   4. 窗口失焦时自动清空按键状态，避免出现「按键卡住」；
 *   5. 提供 clear / dispose 便于暂停与销毁。
 *
 * 用法：
 *   const keyboard = new Keyboard({ preventKeys: ['KeyW', 'Space'] });
 *   keyboard.onPress('Space', () => jump());
 *   if (keyboard.has('ShiftLeft')) run();
 *   keyboard.clear();      // 暂停时清空
 *   keyboard.dispose();    // 不再需要时移除监听
 * ------------------------------------------------------------
 */

export interface KeyboardOptions {
  /** 需要阻止默认行为的按键 code 列表 */
  preventKeys?: string[];
  /** 是否忽略长按重复触发的 keydown（默认 true） */
  ignoreRepeat?: boolean;
  /** 监听目标，默认 window */
  target?: EventTarget;
}

/** 「单次按下」回调签名 */
export type PressHandler = (event: KeyboardEvent, keyboard: Keyboard) => void;

export class Keyboard {
  target: EventTarget;
  ignoreRepeat: boolean;
  preventKeys: Set<string>;
  /** 当前处于按下状态的按键 */
  pressed = new Set<string>();
  /** 按键 -> 单次按下回调 */
  private _handlers = new Map<string, PressHandler[]>();

  private readonly _onKeyDown: EventListener;
  private readonly _onKeyUp: EventListener;
  private readonly _onBlur: EventListener;

  constructor({ preventKeys = [], ignoreRepeat = true, target = window }: KeyboardOptions = {}) {
    this.target = target;
    this.ignoreRepeat = ignoreRepeat;
    this.preventKeys = new Set(preventKeys);

    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp = this._handleKeyUp.bind(this);
    this._onBlur = this._handleBlur.bind(this);

    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
  }

  /* ---------------- 内部事件处理 ---------------- */

  private _handleKeyDown(evt: Event): void {
    const e = evt as KeyboardEvent;
    if (this.preventKeys.has(e.code)) e.preventDefault();
    if (e.repeat && this.ignoreRepeat) return;

    const firstPress = !this.pressed.has(e.code);
    this.pressed.add(e.code);
    if (!firstPress) return;

    const list = this._handlers.get(e.code);
    if (list) for (const fn of list) fn(e, this);
  }

  private _handleKeyUp(evt: Event): void {
    const e = evt as KeyboardEvent;
    if (this.preventKeys.has(e.code)) e.preventDefault();
    this.pressed.delete(e.code);
  }

  private _handleBlur(): void {
    this.clear();
  }

  /* ---------------- 查询 ---------------- */

  /** 指定按键是否处于按下状态 */
  has(code: string): boolean {
    return this.pressed.has(code);
  }

  /** 任意一个按键处于按下状态即为 true */
  hasAny(...codes: string[]): boolean {
    for (const c of codes) if (this.pressed.has(c)) return true;
    return false;
  }

  /** 当前按下的按键数量 */
  get size(): number {
    return this.pressed.size;
  }

  /* ---------------- 订阅 ---------------- */

  /**
   * 注册「单次按下」回调
   * @param code KeyboardEvent.code
   * @returns 取消订阅函数
   */
  onPress(code: string, handler: PressHandler): () => void {
    let list = this._handlers.get(code);
    if (!list) { list = []; this._handlers.set(code, list); }
    list.push(handler);
    return () => this.offPress(code, handler);
  }

  /** 移除某个按键的回调（不传 handler 则移除该按键全部回调） */
  offPress(code: string, handler?: PressHandler): void {
    if (!handler) { this._handlers.delete(code); return; }
    const list = this._handlers.get(code);
    if (!list) return;
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) this._handlers.delete(code);
  }

  /* ---------------- 状态控制 ---------------- */

  /** 清空当前按下的按键（回调保留） */
  clear(): void {
    this.pressed.clear();
  }

  /** 移除全部事件监听并清空状态，释放引用 */
  dispose(): void {
    this.target.removeEventListener('keydown', this._onKeyDown);
    this.target.removeEventListener('keyup', this._onKeyUp);
    this.target.removeEventListener('blur', this._onBlur);
    this.clear();
    this._handlers.clear();
  }
}

export default Keyboard;
