import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** 坐标数值显示精度（小数位） */
const COORD_DECIMALS = 3;

/** 点击判定阈值：按下与抬起位移不超过该值（像素）视为点击，超过视为拖拽旋转 */
const CLICK_MOVE_THRESHOLD_PX = 4;

export interface PointCoordinateMarkerOptions {
  /** 是否在拾取点处显示一个小圆点标记；默认 true */
  showDot?: boolean;
}

/**
 * PointCoordinateMarker - 点位坐标拾取标签。
 *
 * 开启后监听画布上的鼠标点击：射线命中模型表面时，在命中点处显示一个
 * 白色圆角框，框内为该点的世界坐标 xyz 信息，并在拾取点处显示一个小圆点。
 *
 * 圆角框为 DOM 元素（HTML 覆盖层实现）：圆角、阴影与文字排版直接由 CSS
 * 完成，无需生成贴图。每帧把拾取点的世界坐标投影到屏幕坐标并更新圆角框
 * 的位置 —— 拾取点固定在模型表面，投影结果随相机视角转动而变化，表现为
 * 圆角框锚定在拾取点上、跟随相机视角转动；拾取点转到相机背后时自动隐藏。
 *
 * 点击与拖拽区分：按下与抬起位移小于 CLICK_MOVE_THRESHOLD_PX 才视为
 * 点击拾取，超过阈值视为旋转 / 平移等轨道拖拽，不触发拾取。点击空白处
 * （未命中模型）会隐藏当前标签。
 *
 * 覆盖层使用 position: fixed 定位，坐标直接取视口坐标，不依赖画布父容器
 * 的定位方式；覆盖层与内部元素均设置 pointer-events: none，不拦截画布的
 * 鼠标事件。
 */
export class PointCoordinateMarker {
  private canvas: HTMLElement;
  private controls: OrbitControls;
  private showDot: boolean;
  /** 射线拾取目标（模型的根节点或网格对象数组），enable() 时传入 */
  private targets: THREE.Object3D[] = [];
  private raycaster = new THREE.Raycaster();
  private enabled = false;
  /** 当前拾取点（世界坐标），null 表示尚未拾取或已清除 */
  private point: THREE.Vector3 | null = null;

  // ---------- DOM ----------
  /** 覆盖层容器（fixed 定位锚点，内部元素按视口坐标绝对定位） */
  private overlay: HTMLDivElement;
  /** 白色圆角坐标框 */
  private label: HTMLDivElement;
  /** 拾取点小圆点 */
  private dot: HTMLDivElement;

  // ---------- 点击检测状态 ----------
  /** 已按下的左键指针 id，null 表示未按下 */
  private downPointerId: number | null = null;
  private downX = 0;
  private downY = 0;

  constructor(canvas: HTMLElement, controls: OrbitControls, options: PointCoordinateMarkerOptions = {}) {
    this.canvas = canvas;
    this.controls = controls;
    this.showDot = options.showDot ?? true;

    // 覆盖层：fixed 定位、尺寸为零、不拦截鼠标事件，仅作为子元素的定位锚点
    this.overlay = document.createElement('div');
    Object.assign(this.overlay.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '0',
      height: '0',
      pointerEvents: 'none',
      zIndex: '10',
    } as CSSStyleDeclaration);

    // 白色圆角坐标框：默认隐藏，拾取成功后显示
    this.label = document.createElement('div');
    Object.assign(this.label.style, {
      position: 'absolute',
      transform: 'translate(-50%, -100%)',
      background: '#ffffff',
      borderRadius: '8px',
      padding: '5px 10px',
      border: '1px solid rgba(0, 0, 0, 0.12)',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
      color: '#333333',
      font: '12px/1.5 Consolas, Menlo, monospace',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      display: 'none',
    } as CSSStyleDeclaration);

    // 拾取点小圆点
    this.dot = document.createElement('div');
    Object.assign(this.dot.style, {
      position: 'absolute',
      transform: 'translate(-50%, -50%)',
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      background: '#ffffff',
      border: '2px solid rgba(0, 0, 0, 0.45)',
      boxSizing: 'border-box',
      pointerEvents: 'none',
      display: 'none',
    } as CSSStyleDeclaration);

    this.overlay.append(this.label);
    if (this.showDot) this.overlay.append(this.dot);
    document.body.append(this.overlay);

    // 点击检测监听（挂在画布上；OrbitControls 拖拽期间对画布做指针捕获，
    // 抬起事件仍会派发到画布）
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
  }

  /** 开启拾取：targets 为参与射线拾取的模型对象（根节点或网格数组，递归拾取） */
  public enable(targets: THREE.Object3D | THREE.Object3D[]): void {
    this.targets = Array.isArray(targets) ? targets.slice() : [targets];
    this.enabled = true;
  }

  /** 关闭拾取并隐藏当前坐标标签（保留 targets，便于再次开启） */
  public disable(): void {
    this.enabled = false;
    this.downPointerId = null;
    this.point = null;
    this.hide();
  }

  /** 是否已开启拾取 */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /** 当前拾取点（世界坐标）；未拾取时返回 null */
  public getPoint(): THREE.Vector3 | null {
    return this.point;
  }

  /** 释放 DOM 与事件监听 */
  public dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.overlay.remove();
    this.enabled = false;
    this.point = null;
  }

  // ---------- 指针事件处理 ----------

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    // 仅响应画布上的鼠标左键
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    // 已有按键按下（正在其他拖拽交互）时不进入点击判定
    if (event.buttons !== 1) return;
    this.downPointerId = event.pointerId;
    this.downX = event.clientX;
    this.downY = event.clientY;
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.enabled || this.downPointerId !== event.pointerId) return;
    this.downPointerId = null;
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    // 位移超过阈值视为轨道拖拽（旋转 / 平移），不触发拾取
    const moved = Math.hypot(event.clientX - this.downX, event.clientY - this.downY);
    if (moved > CLICK_MOVE_THRESHOLD_PX) return;
    this.pick(event);
  };

  /** 对指针位置做射线拾取：命中模型则更新拾取点与标签内容，未命中则隐藏标签 */
  private pick(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.controls.object);
    const hits = this.raycaster.intersectObjects(this.targets, true);
    if (hits.length === 0) {
      this.point = null;
      this.hide();
      return;
    }
    this.point = hits[0].point.clone();
    this.updateLabelText();
    // 立即刷新一次位置，无需等待下一帧
    this.update();
  }

  // ---------- 标签更新 ----------

  private updateLabelText(): void {
    if (!this.point) return;
    const { x, y, z } = this.point;
    this.label.textContent = `X: ${x.toFixed(COORD_DECIMALS)}  Y: ${y.toFixed(COORD_DECIMALS)}  Z: ${z.toFixed(COORD_DECIMALS)}`;
  }

  /** 隐藏坐标框与小圆点 */
  private hide(): void {
    this.label.style.display = 'none';
    this.dot.style.display = 'none';
  }

  /**
   * 每帧更新：把拾取点投影到屏幕坐标并同步圆角框与小圆点的位置，
   * 由外部渲染循环调用；未开启、未拾取或拾取点位于相机背后时隐藏。
   */
  public update(): void {
    if (!this.enabled || !this.point) return;

    // 拾取点在相机背后（或正上方）时投影会翻转错位，隐藏标签
    const camDir = this.controls.object.getWorldDirection(_camDir);
    if (_toPoint.subVectors(this.point, this.controls.object.position).dot(camDir) <= 0) {
      this.hide();
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const ndc = _projected.copy(this.point).project(this.controls.object);

    // 视口坐标（覆盖层为 fixed 定位，left/top 直接取视口坐标）
    const x = rect.left + ((ndc.x * 0.5 + 0.5) * rect.width);
    const y = rect.top + ((-ndc.y * 0.5 + 0.5) * rect.height);

    this.dot.style.left = `${x}px`;
    this.dot.style.top = `${y}px`;
    this.dot.style.display = this.showDot ? 'block' : 'none';

    // 坐标框锚定在小圆点上方（间距 12px），不遮挡拾取点
    this.label.style.left = `${x}px`;
    this.label.style.top = `${y - 12}px`;
    this.label.style.display = 'block';
  }
}

/** 临时向量（避免每帧分配） */
const _camDir = new THREE.Vector3();
const _toPoint = new THREE.Vector3();
const _projected = new THREE.Vector3();
