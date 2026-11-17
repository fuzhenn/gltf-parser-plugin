import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** 坐标数值显示精度（小数位） */
const COORD_DECIMALS = 3;

/** 点击判定阈值：按下与抬起位移不超过该值（像素）视为点击，超过视为拖拽旋转 */
const CLICK_MOVE_THRESHOLD_PX = 4;

/** 默认同时保留的最大点位标记数量（超出后移除最早的标记） */
const DEFAULT_MAX_MARKERS = 10;

export interface PointCoordinateMarkerOptions {
  /** 是否在拾取点处显示一个小圆点标记；默认 true */
  showDot?: boolean;
  /** 同时保留的最大点位标记数量，超出后移除最早的标记；默认 10 */
  maxMarkers?: number;
}

/** 单个点位标记：拾取点世界坐标 + 对应的坐标框与小圆点 DOM 元素 */
interface MarkerEntry {
  point: THREE.Vector3;
  label: HTMLDivElement;
  dot: HTMLDivElement | null;
}

/**
 * PointCoordinateMarker - 点位坐标拾取标签（支持多点）。
 *
 * 开启后监听画布上的鼠标点击：射线命中模型表面时，在命中点处显示一个
 * 白色圆角框，框内为该点的世界坐标 xyz 信息，并在拾取点处显示一个小圆点。
 * 每次点击都会新增一个点位标记，多个标记同时保留（数量上限 maxMarkers，
 * 超出后自动移除最早的标记）；点击模型以外的空白处会清除全部标记。
 *
 * 圆角框为 DOM 元素（HTML 覆盖层实现）：圆角、阴影与文字排版直接由 CSS
 * 完成，无需生成贴图。每帧把各拾取点的世界坐标投影到屏幕坐标并更新对应
 * 圆角框的位置 —— 拾取点固定在模型表面，投影结果随相机视角转动而变化，
 * 表现为圆角框锚定在拾取点上、跟随相机视角转动；单个拾取点转到相机背后
 * 时仅隐藏该点对应的标签，不影响其他标记。
 *
 * 点击与拖拽区分：按下与抬起位移小于 CLICK_MOVE_THRESHOLD_PX 才视为
 * 点击拾取，超过阈值视为旋转 / 平移等轨道拖拽，不触发拾取。
 *
 * 覆盖层使用 position: fixed 定位，坐标直接取视口坐标，不依赖画布父容器
 * 的定位方式；覆盖层与内部元素均设置 pointer-events: none，不拦截画布的
 * 鼠标事件。
 */
export class PointCoordinateMarker {
  private canvas: HTMLElement;
  private controls: OrbitControls;
  private showDot: boolean;
  private maxMarkers: number;
  /** 射线拾取目标（模型的根节点或网格对象数组），enable() 时传入 */
  private targets: THREE.Object3D[] = [];
  private raycaster = new THREE.Raycaster();
  private enabled = false;
  /** 当前全部点位标记（按拾取顺序保存，最早的在前） */
  private markers: MarkerEntry[] = [];

  // ---------- DOM ----------
  /** 覆盖层容器（fixed 定位锚点，内部元素按视口坐标绝对定位） */
  private overlay: HTMLDivElement;

  // ---------- 点击检测状态 ----------
  /** 已按下的左键指针 id，null 表示未按下 */
  private downPointerId: number | null = null;
  private downX = 0;
  private downY = 0;

  constructor(canvas: HTMLElement, controls: OrbitControls, options: PointCoordinateMarkerOptions = {}) {
    this.canvas = canvas;
    this.controls = controls;
    this.showDot = options.showDot ?? true;
    this.maxMarkers = Math.max(1, options.maxMarkers ?? DEFAULT_MAX_MARKERS);

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

    document.body.append(this.overlay);

    // 点击检测监听（挂在画布上；OrbitControls 拖拽期间对画布做指针捕获，
    // 抬起事件仍会派发到画布）
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
  }

  /** 创建一个新的标记元素组（白色圆角坐标框 + 可选小圆点） */
  private createMarkerElements(): MarkerEntry {
    const label = document.createElement('div');
    Object.assign(label.style, {
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

    let dot: HTMLDivElement | null = null;
    if (this.showDot) {
      dot = document.createElement('div');
      Object.assign(dot.style, {
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
    }

    this.overlay.append(label);
    if (dot) this.overlay.append(dot);

    return { point: new THREE.Vector3(), label, dot };
  }

  /** 移除单个标记（从列表中删除并销毁其 DOM 元素） */
  private removeMarker(marker: MarkerEntry): void {
    const index = this.markers.indexOf(marker);
    if (index >= 0) this.markers.splice(index, 1);
    marker.label.remove();
    marker.dot?.remove();
  }

  /** 开启拾取：targets 为参与射线拾取的模型对象（根节点或网格数组，递归拾取） */
  public enable(targets: THREE.Object3D | THREE.Object3D[]): void {
    this.targets = Array.isArray(targets) ? targets.slice() : [targets];
    this.enabled = true;
  }

  /** 关闭拾取（已显示的标记保留，可用 clear() 清除），便于再次开启 */
  public disable(): void {
    this.enabled = false;
    this.downPointerId = null;
  }

  /** 是否已开启拾取 */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /** 清除全部点位标记 */
  public clear(): void {
    while (this.markers.length > 0) {
      this.removeMarker(this.markers[this.markers.length - 1]);
    }
  }

  /** 最近一次拾取点（世界坐标）；未拾取时返回 null */
  public getPoint(): THREE.Vector3 | null {
    const last = this.markers[this.markers.length - 1];
    return last ? last.point.clone() : null;
  }

  /** 全部拾取点（世界坐标，按拾取顺序）；无拾取点时返回空数组 */
  public getPoints(): THREE.Vector3[] {
    return this.markers.map((m) => m.point.clone());
  }

  /** 释放 DOM 与事件监听 */
  public dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.clear();
    this.overlay.remove();
    this.enabled = false;
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

  /** 对指针位置做射线拾取：命中模型则新增点位标记，未命中则清除全部标记 */
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
      // 点击空白处：清除全部标记
      this.clear();
      this.update();
      return;
    }

    // 超出上限时移除最早的标记
    if (this.markers.length >= this.maxMarkers) {
      this.removeMarker(this.markers[0]);
    }

    const marker = this.createMarkerElements();
    marker.point.copy(hits[0].point);
    this.markers.push(marker);
    this.updateLabelText(marker);
    // 立即刷新一次位置，无需等待下一帧
    this.update();
  }

  // ---------- 标签更新 ----------

  private updateLabelText(marker: MarkerEntry): void {
    const { x, y, z } = marker.point;
    marker.label.textContent = `X: ${x.toFixed(COORD_DECIMALS)}  Y: ${y.toFixed(COORD_DECIMALS)}  Z: ${z.toFixed(COORD_DECIMALS)}`;
  }

  /** 隐藏单个标记的坐标框与小圆点 */
  private hideMarker(marker: MarkerEntry): void {
    marker.label.style.display = 'none';
    if (marker.dot) marker.dot.style.display = 'none';
  }

  /**
   * 每帧更新：把各拾取点投影到屏幕坐标并同步对应圆角框与小圆点的位置，
   * 由外部渲染循环调用；未开启或无标记时空操作。单个拾取点位于相机背后
   * （或正上方）时仅隐藏该点的标签，其他标记不受影响。
   */
  public update(): void {
    if (!this.enabled || this.markers.length === 0) return;

    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const camDir = this.controls.object.getWorldDirection(_camDir);

    for (const marker of this.markers) {
      // 拾取点在相机背后（或正上方）时投影会翻转错位，隐藏该标记
      if (_toPoint.subVectors(marker.point, this.controls.object.position).dot(camDir) <= 0) {
        this.hideMarker(marker);
        continue;
      }

      const ndc = _projected.copy(marker.point).project(this.controls.object);

      // 视口坐标（覆盖层为 fixed 定位，left/top 直接取视口坐标）
      const x = rect.left + ((ndc.x * 0.5 + 0.5) * rect.width);
      const y = rect.top + ((-ndc.y * 0.5 + 0.5) * rect.height);

      if (marker.dot) {
        marker.dot.style.left = `${x}px`;
        marker.dot.style.top = `${y}px`;
        marker.dot.style.display = 'block';
      }

      // 坐标框锚定在小圆点上方（间距 12px），不遮挡拾取点
      marker.label.style.left = `${x}px`;
      marker.label.style.top = `${y - 12}px`;
      marker.label.style.display = 'block';
    }
  }
}

/** 临时向量（避免每帧分配） */
const _camDir = new THREE.Vector3();
const _toPoint = new THREE.Vector3();
const _projected = new THREE.Vector3();
