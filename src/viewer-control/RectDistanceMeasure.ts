import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** 点击判定阈值：按下与抬起位移不超过该值（像素）视为点击，超过视为拖拽旋转 */
const CLICK_MOVE_THRESHOLD_PX = 4;

/** 端点圆点半径（像素） */
const ENDPOINT_RADIUS = 4;

export interface RectMeasureOptions {
  /** 距离显示单位名称；默认 'm' */
  unit?: string;
  /** 模型单位 → 显示单位的换算系数（显示距离 = 模型距离 × unitScale）；默认 1 */
  unitScale?: number;
  /** 距离数值小数位；默认 3 */
  decimals?: number;
}

/** 单条测量结果（距离为按 unitScale 换算后的显示值） */
export interface RectMeasurement {
  /** 第一条边的起点 A（世界坐标，模型表面拾取） */
  a: THREE.Vector3;
  /** 第一条边的终点 B（世界坐标，模型表面拾取） */
  b: THREE.Vector3;
  /** 第三次点击落定的对角点 C（世界坐标，C = A + L·u；D = C + (B − A)） */
  c: THREE.Vector3;
  /** A、B 两点间距离（显示单位下） */
  distance: number;
}

/** 单条测量条目：数据与渲染节点一一对应 */
interface RectEntry {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  distance: number;
  /** 该条目的 SVG 分组（三条实线边 + CD 双端箭头线 + A/B 端点圆点） */
  group: SVGGElement;
  lineAB: SVGLineElement;
  lineAC: SVGLineElement;
  lineBD: SVGLineElement;
  /** CD 尺寸线（双端箭头，长度恒等于 |AB|） */
  dimCD: SVGLineElement;
  dotA: SVGCircleElement;
  dotB: SVGCircleElement;
  /** CD 尺寸线中点的距离文本框（HTML，跟随尺寸线中点） */
  dimLabel: HTMLDivElement;
}

/**
 * RectDistanceMeasure - 矩形距离测量工具（类似 HOOPS Visualize 的 point-to-point
 * measure 交互）。
 *
 * 三段式交互：开启后监听画布上的鼠标左键点击，第一、二次点击均在射线命中
 * 模型表面时拾取点 A、B（三点定矩形，A、B 保持模型表面真实坐标，测量值即
 * 真实 |AB|）；此后移动鼠标出现橡皮筋预览 —— 取矩形"进深"方向
 * u = normalize(AB × 视线)，u 同时垂直于 AB 与视线方向，因而平行于屏幕平面，
 * 即矩形平面总取"含 AB 且最正对相机"的那个；沿 u 从 A、B 各推出 L 得
 * C = A + L·u、D = B + L·u，构成矩形 A-B-D-C（AB ∥ CD、AC ∥ BD），四点严格
 * 共面，三维空间中 AB ⊥ AC、AB ⊥ BD、AC ⊥ CD 严格成立；L 取鼠标射线与
 * "过 A、垂直视线"固定平面 Π 的交点在 u 上的投影长度，即矩形宽窄随鼠标离
 * AB 的距离变化。预览绘制为虚线的 AB / AC / BD 三条边与 CD 双端箭头尺寸线，
 * CD 中点（鼠标一侧）显示 |AB| 的距离标签；第三次点击冻结当前 C（D 由
 * D = C + (B − A) 确定）落定为实线 markup。
 *
 * 由于 A、B 取自模型表面而非屏幕，矩形平面一般不平行于屏幕，因此屏幕上的
 * 三处垂直为近似值（正交相机下精确成立，透视相机下仅因射线不平行而有极轻微
 * 偏差），三维空间内则精确成立。
 *
 * 渲染采用 SVG/DOM 覆盖层（fixed 定位，与 DistanceMeasure 完全同一思路）：
 * 线段 / 箭头 / 圆点绘制在覆盖层 <svg> 上（双端箭头用 SVG marker），数值标签
 * 用 HTML 圆角框。每帧把 A、B、C、D 的世界坐标投影到屏幕坐标并更新节点位置
 * —— 落定的 markup 锚定在三维空间、跟随相机视角转动，ABCD 四点的三维坐标
 * 在测量完成后不再改变；任一角点转到相机背后时自动隐藏对应条目。覆盖层始终
 * 显示在模型之上（不被模型遮挡），且不拦截画布的鼠标事件。
 *
 * 预览阶段缓存鼠标 NDC，每帧用当前相机重新求 C —— 相机旋转时橡皮筋始终
 * 正对视角，C 的投影与鼠标位置严格重合。
 *
 * 点击与拖拽区分、Esc 分级取消（预览中 Esc 退回仅保留 A，再按 Esc 全部清除）、
 * enable / disable 语义均与 DistanceMeasure 一致：disable 仅停止拾取、清除
 * 未完成的拾取点，已完成的测量保留显示；再次 enable 时清除全部旧测量；
 * clear() 供外部在任意时刻手动清除全部测量。
 */
export class RectDistanceMeasure {
  private canvas: HTMLElement;
  private controls: OrbitControls;
  /** 显示配置（单位 / 换算系数 / 小数位） */
  private unit: string;
  private unitScale: number;
  private decimals: number;
  /** 射线拾取目标（模型的根节点或网格对象数组），enable() 时传入 */
  private targets: THREE.Object3D[] = [];
  private raycaster = new THREE.Raycaster();
  private enabled = false;
  private disposed = false;
  /** 已完成的测量条目（按创建顺序） */
  private entries: RectEntry[] = [];
  /** 当前未完成的拾取点：A / B（世界坐标），null 表示尚未拾取 */
  private pendingA: THREE.Vector3 | null = null;
  private pendingB: THREE.Vector3 | null = null;
  /** 预览阶段缓存的鼠标 NDC 坐标（每帧由 update() 重算 C），null 表示尚未移动过鼠标 */
  private mouseNdc: THREE.Vector2 | null = null;
  /** 开启前的画布 cursor，disable / dispose 时恢复 */
  private prevCursor: string | null = null;

  // ---------- DOM ----------
  /** 覆盖层容器（fixed 定位锚点，内部元素按视口坐标定位） */
  private overlay: HTMLDivElement;
  /** SVG 覆盖层：承载测量条目、预览橡皮筋与待完成拾取点（尺寸随视口 100% 拉伸） */
  private svg: SVGSVGElement;
  /** 双端箭头 marker 的引用 id（CD 尺寸线两端共用，orient=auto-start-reverse） */
  private arrowMarkerId: string;
  /** 待完成拾取点 A / B 的圆点标记 */
  private pendingDotA: SVGCircleElement;
  private pendingDotB: SVGCircleElement;
  /** 预览橡皮筋分组（虚线 AB / BC / DA + CD 双端箭头线），仅预览阶段显示 */
  private previewGroup: SVGGElement;
  private previewLineAB: SVGLineElement;
  private previewLineAC: SVGLineElement;
  private previewLineBD: SVGLineElement;
  private previewDimCD: SVGLineElement;
  /** 预览阶段 CD 尺寸线中点的距离文本框 */
  private previewDimLabel: HTMLDivElement;

  // ---------- 点击检测状态 ----------
  /** 已按下的左键指针 id，null 表示未按下 */
  private downPointerId: number | null = null;
  private downX = 0;
  private downY = 0;

  constructor(canvas: HTMLElement, controls: OrbitControls, options: RectMeasureOptions = {}) {
    this.canvas = canvas;
    this.controls = controls;
    this.unit = options.unit ?? 'm';
    this.unitScale = options.unitScale ?? 1;
    this.decimals = options.decimals ?? 3;
    // 实例间隔离：marker id 加随机后缀，避免多个实例共用 <defs> 时互相覆盖
    this.arrowMarkerId = `rect-measure-arrow-${Math.random().toString(36).slice(2)}`;

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

    // SVG 覆盖层：fixed 定位铺满视口，坐标直接取视口坐标，无需监听窗口 resize
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
    this.svg.setAttribute('width', '100%');
    this.svg.setAttribute('height', '100%');
    Object.assign(this.svg.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      pointerEvents: 'none',
      overflow: 'visible',
    } as CSSStyleDeclaration);

    // 双端箭头 marker（CD 尺寸线两端共用）
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', this.arrowMarkerId);
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '8');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    // auto-start-reverse：start 端自动反转朝向，end 端表现为 auto，两端共用
    marker.setAttribute('orient', 'auto-start-reverse');
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 Z');
    arrow.setAttribute('fill', '#000000');
    marker.append(arrow);
    defs.append(marker);
    this.svg.append(defs);

    // 待完成拾取点圆点（默认隐藏）：白色填充蓝色描边，与测量条目配色一致
    this.pendingDotA = this.createPendingDot();
    this.pendingDotB = this.createPendingDot();

    // 预览橡皮筋分组：虚线三条边 + CD 双端箭头尺寸线（默认隐藏）
    this.previewGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g') as SVGGElement;
    this.previewLineAB = this.createPreviewLine();
    this.previewLineAC = this.createPreviewLine();
    this.previewLineBD = this.createPreviewLine();
    this.previewDimCD = this.createDimLine();
    this.previewGroup.append(this.previewLineAB, this.previewLineAC, this.previewLineBD, this.previewDimCD);
    this.previewGroup.style.display = 'none';
    this.previewDimLabel = this.createLabel();

    this.svg.append(this.pendingDotA, this.pendingDotB, this.previewGroup);
    this.overlay.append(this.svg, this.previewDimLabel);
    document.body.append(this.overlay);

    // 点击检测与鼠标移动监听（挂在画布上；OrbitControls 拖拽期间对画布做指针
    // 捕获，抬起事件仍会派发到画布）
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    // Esc 分级取消（挂在 window 上：焦点可能不在画布上）
    window.addEventListener('keydown', this.onKeyDown);
  }

  /** 开启测量（清除全部旧测量）：targets 为参与射线拾取的模型对象（根节点或网格数组，递归拾取） */
  public enable(targets: THREE.Object3D | THREE.Object3D[]): void {
    if (this.disposed) return;
    this.targets = Array.isArray(targets) ? targets.slice() : [targets];
    this.clear();
    this.enabled = true;
    this.setCanvasCursor('crosshair');
  }

  /** 关闭测量：停止拾取并清除未完成的拾取点与预览；已完成的测量保留显示 */
  public disable(): void {
    this.enabled = false;
    this.setCanvasCursor(null);
    this.setPending(null, null);
  }

  /** 更新显示配置（单位 / 换算系数 / 小数位），并刷新已有条目的标签文本 */
  public setOptions(options: RectMeasureOptions): void {
    if (this.disposed) return;
    if (options.unit !== undefined) this.unit = options.unit;
    if (options.unitScale !== undefined) this.unitScale = options.unitScale;
    if (options.decimals !== undefined) this.decimals = options.decimals;
    for (const entry of this.entries) {
      entry.distance = entry.a.distanceTo(entry.b) * this.unitScale;
      this.updateEntryLabel(entry);
    }
  }

  /** 是否已开启测量 */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /** 清除全部测量条目（含未完成的拾取点与预览） */
  public clear(): void {
    for (const entry of this.entries) {
      entry.group.remove();
      entry.dimLabel.remove();
    }
    this.entries = [];
    this.setPending(null, null);
  }

  /** 当前全部测量结果（端点与距离的副本，修改不影响内部状态） */
  public getMeasurements(): RectMeasurement[] {
    return this.entries.map((entry) => ({
      a: entry.a.clone(),
      b: entry.b.clone(),
      c: entry.c.clone(),
      distance: entry.distance,
    }));
  }

  /** 释放 DOM 与事件监听（同时清除全部测量） */
  public dispose(): void {
    if (this.disposed) return;
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    this.setCanvasCursor(null);
    this.clear();
    this.previewDimLabel.remove();
    this.overlay.remove();
    this.disposed = true;
  }

  // ---------- 指针事件处理 ----------

  private onPointerDown = (event: PointerEvent): void => {
    if (this.disposed || !this.enabled) return;
    // 仅响应画布上的鼠标左键
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    // 已有按键按下（正在其他拖拽交互）时不进入点击判定
    if (event.buttons !== 1) return;
    this.downPointerId = event.pointerId;
    this.downX = event.clientX;
    this.downY = event.clientY;
  };

  /** 缓存鼠标 NDC 坐标（预览阶段每帧由此重算 C，相机旋转时橡皮筋跟随视角） */
  private onPointerMove = (event: PointerEvent): void => {
    if (this.disposed || !this.enabled) return;
    if (event.pointerType !== 'mouse') return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (this.mouseNdc === null) this.mouseNdc = new THREE.Vector2();
    this.mouseNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.disposed || this.downPointerId !== event.pointerId) return;
    this.downPointerId = null;
    if (!this.enabled) return;
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    // 位移超过阈值视为轨道拖拽（旋转 / 平移），不触发拾取
    const moved = Math.hypot(event.clientX - this.downX, event.clientY - this.downY);
    if (moved > CLICK_MOVE_THRESHOLD_PX) return;
    this.pick(event);
  };

  /** Esc 分级取消：预览中退回仅保留 A，再次按全部清除 */
  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.disposed || !this.enabled || event.key !== 'Escape') return;
    if (this.pendingB !== null) {
      this.setPending(this.pendingA, null);
    } else {
      this.setPending(null, null);
    }
    this.update();
  };

  /** 对指针位置做射线拾取：前两次点击需命中模型，第三次点击固定 C 落定 */
  private pick(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(_ndc.set(ndcX, ndcY), this.controls.object);

    if (this.pendingA === null || this.pendingB === null) {
      const hits = this.raycaster.intersectObjects(this.targets, true);
      if (hits.length === 0) return;
      const point = hits[0].point.clone();
      if (this.pendingA === null) {
        // 第一个点：记录并显示待完成圆点，等待第二个点
        this.setPending(point, null);
      } else {
        // 第二个点：AB 成为固定边，进入橡皮筋预览阶段
        this.setPending(this.pendingA, point);
      }
      this.update();
      return;
    }

    // 第三个点：沿进深方向 u 落定对角点 C（见 resolveC），D 随之确定并冻结
    const c = new THREE.Vector3();
    const resolved =
      this.resolveC(ndcX, ndcY, c) ||
      (this.mouseNdc !== null ? this.resolveC(this.mouseNdc.x, this.mouseNdc.y, c) : false);
    if (!resolved) return;
    this.createEntry(this.pendingA, this.pendingB, c);
    this.setPending(null, null);
    this.update();
  }

  /**
   * 求矩形"进深"方向 u（A → C、B → D 的单位方向）：u = normalize(AB × 视线)，
   * 同时垂直于 AB 与视线方向，因而平行于屏幕平面 —— 矩形平面总取"含 AB 且最
   * 正对相机"的那个，三维空间中 AB ⊥ AC、AB ⊥ BD、AC ⊥ CD 严格成立。
   *
   * AB 近乎正对相机（与视线平行）时叉积退化，退回取相机上方向在 AB 垂面内的
   * 分量（此时矩形平面无法正对相机，屏幕上只能看到近似一条边）。
   */
  private resolveRectAxis(ab: THREE.Vector3, viewDir: THREE.Vector3, out: THREE.Vector3): boolean {
    const lenSq = ab.lengthSq();
    if (lenSq < 1e-12) return false;
    out.crossVectors(ab, viewDir);
    if (out.lengthSq() > lenSq * 1e-8) {
      out.normalize();
      return true;
    }
    // 退化：AB 与视线近乎平行，改用相机上方向（或 X 轴）构造 AB 的垂直方向
    const up = this.controls.object.up;
    out.copy(up).addScaledVector(ab, -up.dot(ab) / lenSq);
    if (out.lengthSq() < 1e-12) {
      out.set(1, 0, 0).addScaledVector(ab, -ab.x / lenSq);
    }
    if (out.lengthSq() < 1e-12) return false;
    out.normalize();
    return true;
  }

  /**
   * 求对角点 C = A + L·u（D 由 D = C + (B − A) 得到，A-B-D-C 为严格矩形）。
   *
   * L 取鼠标射线与固定平面 Π（过 A、法线为当前视线方向）的交点在 u 上的投影
   * 长度 —— 鼠标离 AB 越远，矩形越宽；乘积后 C 落在 Π 内（u ⊥ 视线），矩形
   * 因此始终位于"过 A 且正对相机"的深度上。透视 / 正交相机下光线与 Π 都不
   * 平行，仅在极端退化情况下返回 false。
   */
  private resolveC(ndcX: number, ndcY: number, out: THREE.Vector3): boolean {
    if (this.pendingA === null || this.pendingB === null) return false;
    const camera = this.controls.object;
    const viewDir = camera.getWorldDirection(_viewDir);
    // 进深方向只取决于 AB 与视线，与鼠标位置无关
    const ab = _v2.subVectors(this.pendingB, this.pendingA);
    if (!this.resolveRectAxis(ab, viewDir, _axis)) return false;
    this.raycaster.setFromCamera(_ndc.set(ndcX, ndcY), camera);
    const ray = this.raycaster.ray;
    const denom = viewDir.dot(ray.direction);
    if (Math.abs(denom) < 1e-6) return false;
    const dist = viewDir.dot(_v1.subVectors(this.pendingA, ray.origin)) / denom;
    if (dist <= 0) return false;
    _hit.copy(ray.origin).addScaledVector(ray.direction, dist);
    const length = _hit.sub(this.pendingA).dot(_axis);
    out.copy(this.pendingA).addScaledVector(_axis, length);
    return true;
  }

  // ---------- 条目创建与更新 ----------

  /** 创建一条测量条目（SVG 分组 + 距离标签）：三条实线边 + CD 双端箭头 + A/B 圆点 */
  private createEntry(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g') as SVGGElement;

    const lineAB = this.createEdgeLine();
    const lineAC = this.createEdgeLine();
    const lineBD = this.createEdgeLine();
    const dimCD = this.createDimLine();

    const dotA = this.createEndpointDot();
    const dotB = this.createEndpointDot();

    group.append(lineAB, lineAC, lineBD, dimCD, dotA, dotB);
    this.svg.append(group);

    const dimLabel = this.createLabel();
    this.overlay.append(dimLabel);

    const distance = a.distanceTo(b) * this.unitScale;
    const entry: RectEntry = {
      a, b, c, distance, group, lineAB, lineAC, lineBD, dimCD, dotA, dotB, dimLabel,
    };
    this.updateEntryLabel(entry);
    this.entries.push(entry);
  }

  /** 创建测量边线段（黑色实线） */
  private createEdgeLine(): SVGLineElement {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line') as SVGLineElement;
    line.setAttribute('stroke', '#000000');
    line.setAttribute('stroke-width', '1');
    line.setAttribute('stroke-linecap', 'round');
    return line;
  }

  /** 创建预览边线段（黑色虚线） */
  private createPreviewLine(): SVGLineElement {
    const line = this.createEdgeLine();
    line.setAttribute('stroke-dasharray', '7 5');
    return line;
  }

  /** 创建 CD 尺寸线（黑色实线，双端箭头） */
  private createDimLine(): SVGLineElement {
    const line = this.createEdgeLine();
    const url = `url(#${this.arrowMarkerId})`;
    line.setAttribute('marker-start', url);
    line.setAttribute('marker-end', url);
    return line;
  }

  /** 创建端点圆点（白色填充黑色描边） */
  private createEndpointDot(): SVGCircleElement {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle') as SVGCircleElement;
    dot.setAttribute('r', String(ENDPOINT_RADIUS));
    dot.setAttribute('fill', '#ffffff');
    dot.setAttribute('stroke', '#000000');
    dot.setAttribute('stroke-width', '2');
    return dot;
  }

  /** 创建待完成拾取点圆点（默认隐藏） */
  private createPendingDot(): SVGCircleElement {
    const dot = this.createEndpointDot();
    dot.style.display = 'none';
    return dot;
  }

  /** 创建距离文本框（白色圆角框风格与 DistanceMeasure 一致，居中于 CD 尺寸线中点） */
  private createLabel(): HTMLDivElement {
    const label = document.createElement('div');
    Object.assign(label.style, {
      position: 'absolute',
      transform: 'translate(-50%, -50%)',
      background: '#ffffff',
      borderRadius: '8px',
      padding: '4px 9px',
      border: '1px solid #000000',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
      color: '#000000',
      font: '12px/1.5 Consolas, Menlo, monospace',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      display: 'none',
    } as CSSStyleDeclaration);
    return label;
  }

  /** 按当前显示配置刷新条目的标签文本 */
  private updateEntryLabel(entry: RectEntry): void {
    entry.dimLabel.textContent = `${entry.distance.toFixed(this.decimals)} ${this.unit}`;
  }

  /** 记录 / 清除未完成的拾取点（pendingDot 与预览橡皮筋跟随显示） */
  private setPending(a: THREE.Vector3 | null, b: THREE.Vector3 | null): void {
    this.pendingA = a;
    this.pendingB = b;
    this.pendingDotA.style.display = a !== null ? 'block' : 'none';
    this.pendingDotB.style.display = b !== null ? 'block' : 'none';
    this.previewGroup.style.display = 'none';
    this.previewDimLabel.style.display = 'none';
  }

  // ---------- 每帧更新 ----------

  /**
   * 每帧更新：把待完成拾取点与各条目的角点投影到屏幕坐标，同步 SVG 线段、
   * 圆点与标签位置；预览阶段由缓存的鼠标 NDC 重算 C 并更新橡皮筋。角点位于
   * 相机背后时隐藏对应元素。由外部渲染循环调用。
   */
  public update(): void {
    if (this.disposed) return;
    if (this.entries.length === 0 && this.pendingA === null) return;

    const camera = this.controls.object;
    const camDir = camera.getWorldDirection(_camDir);
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    // 待完成拾取点圆点（拾取点固定在模型表面，投影随相机视角变化）
    this.layoutPendingDot(this.pendingA, this.pendingDotA, camera, camDir, rect, _screenA);
    this.layoutPendingDot(this.pendingB, this.pendingDotB, camera, camDir, rect, _screenB);

    // 预览橡皮筋：由缓存鼠标 NDC 重算 C，推导 D = C + (B − A) 并投影绘制
    this.updatePreview(camera, camDir, rect);

    for (const entry of this.entries) {
      // A-B-D-C 为矩形：D = C + (B − A)，故 CD ∥ AB 且 |CD| = |AB|，四点共面
      // （C、D 在落定时冻结，之后三维坐标不再改变）
      const d3 = _entryD.copy(entry.c).add(_v1.subVectors(entry.b, entry.a));
      const a = this.projectToScreen(entry.a, camera, camDir, rect, _screenA);
      const b = this.projectToScreen(entry.b, camera, camDir, rect, _screenB);
      const c = this.projectToScreen(entry.c, camera, camDir, rect, _screenC);
      const d = this.projectToScreen(d3, camera, camDir, rect, _screenD);
      // 任一角点转到相机背后时投影会翻转错位，整条隐藏
      if (!a || !b || !c || !d) {
        entry.group.style.display = 'none';
        entry.dimLabel.style.display = 'none';
        continue;
      }
      entry.group.style.display = 'block';
      entry.dimLabel.style.display = 'block';

      // 三条实线边 AB / AC / BD（CD 是 AB 的平行对边，用双端箭头尺寸线表达）
      this.setLine(entry.lineAB, a, b);
      this.setLine(entry.lineAC, a, c);
      this.setLine(entry.lineBD, b, d);
      this.setLine(entry.dimCD, c, d);
      entry.dotA.setAttribute('cx', `${a.x}`);
      entry.dotA.setAttribute('cy', `${a.y}`);
      entry.dotB.setAttribute('cx', `${b.x}`);
      entry.dotB.setAttribute('cy', `${b.y}`);

      // CD 尺寸线中点文本框居中于 C-D 中点
      entry.dimLabel.style.left = `${(c.x + d.x) / 2}px`;
      entry.dimLabel.style.top = `${(c.y + d.y) / 2}px`;
    }
  }

  /** 更新单个待完成拾取点圆点的屏幕位置与可见性 */
  private layoutPendingDot(
    point: THREE.Vector3 | null,
    dot: SVGCircleElement,
    camera: THREE.Camera,
    camDir: THREE.Vector3,
    rect: DOMRect,
    out: { x: number; y: number },
  ): void {
    if (point === null) return;
    const p = this.projectToScreen(point, camera, camDir, rect, out);
    if (p) {
      dot.setAttribute('cx', `${p.x}`);
      dot.setAttribute('cy', `${p.y}`);
      dot.style.display = 'block';
    } else {
      dot.style.display = 'none';
    }
  }

  /** 更新预览橡皮筋（虚线三条边 + CD 双端箭头 + 跟随鼠标的距离标签） */
  private updatePreview(
    camera: THREE.Camera,
    camDir: THREE.Vector3,
    rect: DOMRect,
  ): void {
    const active =
      this.pendingA !== null &&
      this.pendingB !== null &&
      this.mouseNdc !== null &&
      this.resolveC(this.mouseNdc.x, this.mouseNdc.y, _previewC);
    if (!active) return;

    const a = this.projectToScreen(this.pendingA!, camera, camDir, rect, _screenA);
    const b = this.projectToScreen(this.pendingB!, camera, camDir, rect, _screenB);
    const d3 = _previewD.copy(_previewC).add(_v1.subVectors(this.pendingB!, this.pendingA!));
    const c = this.projectToScreen(_previewC, camera, camDir, rect, _screenC);
    const d = this.projectToScreen(d3, camera, camDir, rect, _screenD);
    if (!a || !b || !c || !d) return;

    this.previewGroup.style.display = 'block';
    this.previewDimLabel.style.display = 'block';
    this.setLine(this.previewLineAB, a, b);
    this.setLine(this.previewLineAC, a, c);
    this.setLine(this.previewLineBD, b, d);
    this.setLine(this.previewDimCD, c, d);

    // 距离 = |AB|（CD 与 AB 等长，尺寸线在鼠标位置直观展示该长度）
    const distance = this.pendingA!.distanceTo(this.pendingB!) * this.unitScale;
    this.previewDimLabel.textContent = `${distance.toFixed(this.decimals)} ${this.unit}`;
    this.previewDimLabel.style.left = `${(c.x + d.x) / 2}px`;
    this.previewDimLabel.style.top = `${(c.y + d.y) / 2}px`;
  }

  /** 写入线段两端屏幕坐标 */
  private setLine(line: SVGLineElement, from: { x: number; y: number }, to: { x: number; y: number }): void {
    line.setAttribute('x1', `${from.x}`);
    line.setAttribute('y1', `${from.y}`);
    line.setAttribute('x2', `${to.x}`);
    line.setAttribute('y2', `${to.y}`);
  }

  /** 世界坐标 → 视口坐标；位于相机背后（或正上方）时返回 null */
  private projectToScreen(
    point: THREE.Vector3,
    camera: THREE.Camera,
    camDir: THREE.Vector3,
    rect: DOMRect,
    out: { x: number; y: number },
  ): { x: number; y: number } | null {
    _toCamera.subVectors(point, camera.position);
    if (_toCamera.dot(camDir) <= 0) return null;
    _projected.copy(point).project(camera);
    out.x = rect.left + (_projected.x * 0.5 + 0.5) * rect.width;
    out.y = rect.top + (-_projected.y * 0.5 + 0.5) * rect.height;
    return out;
  }

  // ---------- 光标 ----------

  /** 开启时画布光标设为十字（提示拾取模式），关闭 / 释放时恢复原状 */
  private setCanvasCursor(cursor: string | null): void {
    if (this.disposed) return;
    if (cursor !== null) {
      if (this.prevCursor === null) this.prevCursor = this.canvas.style.cursor;
      this.canvas.style.cursor = cursor;
    } else if (this.prevCursor !== null) {
      this.canvas.style.cursor = this.prevCursor;
      this.prevCursor = null;
    }
  }
}

/** 临时变量（避免每帧分配） */
const _camDir = new THREE.Vector3();
const _toCamera = new THREE.Vector3();
const _projected = new THREE.Vector3();
const _viewDir = new THREE.Vector3();
const _ndc = new THREE.Vector2();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
/** 矩形进深方向 u（⊥ AB 且 ∥ 屏幕平面） */
const _axis = new THREE.Vector3();
/** 鼠标射线与固定平面 Π 的交点 */
const _hit = new THREE.Vector3();
const _entryD = new THREE.Vector3();
const _previewC = new THREE.Vector3();
const _previewD = new THREE.Vector3();
const _screenA = { x: 0, y: 0 };
const _screenB = { x: 0, y: 0 };
const _screenC = { x: 0, y: 0 };
const _screenD = { x: 0, y: 0 };
