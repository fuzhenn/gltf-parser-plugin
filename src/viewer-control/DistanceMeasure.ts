import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** 点击判定阈值：按下与抬起位移不超过该值（像素）视为点击，超过视为拖拽旋转 */
const CLICK_MOVE_THRESHOLD_PX = 4;

/** 端点圆点半径（像素） */
const ENDPOINT_RADIUS = 4;

/** 测量元素统一颜色（线条 / 箭头 / 文本 / 文本框描边均为黑色） */
const MEASURE_COLOR = '#000000';

/** 分量段各轴颜色：X 绿、Y 红、Z 蓝（线与标签文字共用，不受统一黑色影响） */
const AXIS_COLOR = { x: '#2f9e44', y: '#e03131', z: '#1e88e5' } as const;

/** 分量段标签边框颜色（与轴色同色低透明度） */
const AXIS_BORDER_COLOR = {
  x: 'rgba(47, 158, 68, 0.35)',
  y: 'rgba(224, 49, 49, 0.35)',
  z: 'rgba(30, 136, 229, 0.35)',
} as const;

/** 分量段距离小于该值（显示单位）视为零长度，不绘制对应线与标签 */
const AXIS_MIN_DISTANCE = 1e-9;

export interface DistanceMeasureOptions {
  /** 距离显示单位名称；默认 'm' */
  unit?: string;
  /** 模型单位 → 显示单位的换算系数（显示距离 = 模型距离 × unitScale）；默认 1 */
  unitScale?: number;
  /** 距离数值小数位；默认 3 */
  decimals?: number;
  /** 分量折线的纵轴选择（第二段沿该轴绘制，'y' 或 'z'）；默认 'y' */
  verticalAxis?: 'y' | 'z';
}

/** 单条测量结果（距离为按 unitScale 换算后的显示值） */
export interface DistanceMeasurement {
  /** 起点（世界坐标） */
  start: THREE.Vector3;
  /** 终点（世界坐标） */
  end: THREE.Vector3;
  /** 两点间距离（显示单位下） */
  distance: number;
  /** X 轴分量距离 |end.x - start.x|（显示单位下） */
  dx: number;
  /** Y 轴分量距离 |end.y - start.y|（显示单位下） */
  dy: number;
  /** Z 轴分量距离 |end.z - start.z|（显示单位下） */
  dz: number;
}

/** 单条测量条目：数据与渲染节点一一对应 */
interface MeasureEntry {
  start: THREE.Vector3;
  end: THREE.Vector3;
  distance: number;
  /** 该条目的 SVG 分组（线段 + 两端圆点） */
  group: SVGGElement;
  line: SVGLineElement;
  dotStart: SVGCircleElement;
  dotEnd: SVGCircleElement;
  /** 该条目的距离数值标签（HTML，自动排版，位置锚定在线段中点） */
  label: HTMLDivElement;
  /** X 轴分量段 A→C（C = B 在 A 的 Y/Z 上的投影点） */
  lineX: SVGLineElement;
  /** 纵轴分量段 C→D（沿 verticalAxis 配置的轴） */
  lineVert: SVGLineElement;
  /** 剩余轴分量段 D→B */
  lineDiag: SVGLineElement;
  /** 各轴分量距离标签（HTML，颜色按轴，轴别由前缀 X/Y/Z 区分） */
  labelX: HTMLDivElement;
  labelY: HTMLDivElement;
  labelZ: HTMLDivElement;
  /** 各轴分量距离（显示单位下） */
  dx: number;
  dy: number;
  dz: number;
}

/**
 * DistanceMeasure - 距离测量工具（类似 Autodesk Viewer 的 Measure 功能）。
 *
 * 开启后监听画布上的鼠标左键点击：射线命中模型表面时拾取点。依次点击两个
 * 点即生成一条测量 —— 线段连接两点、两端显示圆点、线段中点上方显示带单位
 * 的距离数值标签。可连续测量，所有测量条目同时保留。
 *
 * 除 A→B 主线段外，每条测量还绘制轴分量折线：从 A 沿 X 轴画到 C（C 为 B 在
 * A 的 Y/Z 上的投影点），再从 C 沿纵轴（verticalAxis 配置，默认 Y）画到 D，
 * 最后从 D 连线到 B。各分量段中点用文本标签标识该轴距离（分量段的线条与
 * 标签按轴着色：X 绿 / Y 红 / Z 蓝，轴别也由标签前缀 X/Y/Z 区分）；零长度
 * 分量段不绘制。主线段、端点圆点与距离标签统一为黑色。
 *
 * 渲染采用 SVG/DOM 覆盖层（fixed 定位）：线段与圆点绘制在覆盖层 <svg> 上，
 * 数值标签用 HTML 圆角框（与 PointCoordinateMarker 的标签风格一致）。每帧
 * 把各端点的世界坐标投影到屏幕坐标并更新节点位置 —— 线段锚定在模型表面、
 * 跟随相机视角转动；端点转到相机背后时自动隐藏对应条目。覆盖层始终显示在
 * 模型之上（不被模型遮挡），且不拦截画布的鼠标事件。
 *
 * 点击与拖拽区分：按下与抬起位移小于 CLICK_MOVE_THRESHOLD_PX 才视为拾取
 * 点击，超过阈值视为旋转 / 平移等轨道拖拽，不触发拾取。按 Esc 清除当前
 * 未完成的第一个拾取点。
 *
 * enable / disable 语义：disable 仅停止拾取、清除未完成的拾取点，已完成
 * 的测量保留显示（关闭功能后再次开启仍可见）；再次 enable 时清除全部旧
 * 测量；clear() 供外部在任意时刻手动清除全部测量。
 */
export class DistanceMeasure {
  private canvas: HTMLElement;
  private controls: OrbitControls;
  /** 显示配置（单位 / 换算系数 / 小数位 / 纵轴） */
  private unit: string;
  private unitScale: number;
  private decimals: number;
  private verticalAxis: 'y' | 'z';
  /** 射线拾取目标（模型的根节点或网格对象数组），enable() 时传入 */
  private targets: THREE.Object3D[] = [];
  private raycaster = new THREE.Raycaster();
  private enabled = false;
  private disposed = false;
  /** 已完成的测量条目（按创建顺序） */
  private entries: MeasureEntry[] = [];
  /** 当前未完成的第一个拾取点（世界坐标），null 表示无待完成拾取点 */
  private pendingPoint: THREE.Vector3 | null = null;
  /** 开启前的画布 cursor，disable / dispose 时恢复 */
  private prevCursor: string | null = null;

  // ---------- DOM ----------
  /** 覆盖层容器（fixed 定位锚点，内部元素按视口坐标定位） */
  private overlay: HTMLDivElement;
  /** SVG 覆盖层：承载所有测量条目的线段与圆点（尺寸随视口 100% 拉伸） */
  private svg: SVGSVGElement;
  /** 待完成拾取点的圆点标记（第一个点已拾取、等待第二个点时显示） */
  private pendingDot: SVGCircleElement;

  // ---------- 点击检测状态 ----------
  /** 已按下的左键指针 id，null 表示未按下 */
  private downPointerId: number | null = null;
  private downX = 0;
  private downY = 0;

  constructor(canvas: HTMLElement, controls: OrbitControls, options: DistanceMeasureOptions = {}) {
    this.canvas = canvas;
    this.controls = controls;
    this.unit = options.unit ?? 'm';
    this.unitScale = options.unitScale ?? 1;
    this.decimals = options.decimals ?? 3;
    this.verticalAxis = options.verticalAxis ?? 'y';

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

    // SVG 覆盖层：fixed 定位铺满视口，所有测量条目的线段与圆点都绘制其上；
    // 宽高用 100% 随视口拉伸，坐标直接取视口坐标，无需监听窗口 resize
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

    // 待完成拾取点圆点（默认隐藏）：白色填充黑色描边，与测量条目配色一致
    this.pendingDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle') as SVGCircleElement;
    this.pendingDot.setAttribute('r', String(ENDPOINT_RADIUS));
    this.pendingDot.setAttribute('fill', '#ffffff');
    this.pendingDot.setAttribute('stroke', MEASURE_COLOR);
    this.pendingDot.setAttribute('stroke-width', '2');
    this.pendingDot.style.display = 'none';

    this.svg.append(this.pendingDot);
    this.overlay.append(this.svg);
    document.body.append(this.overlay);

    // 点击检测监听（挂在画布上；OrbitControls 拖拽期间对画布做指针捕获，
    // 抬起事件仍会派发到画布）
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    // Esc 清除未完成拾取点（挂在 window 上：焦点可能不在画布上）
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

  /** 关闭测量：停止拾取并清除未完成的拾取点；已完成的测量保留显示 */
  public disable(): void {
    this.enabled = false;
    this.setCanvasCursor(null);
    this.setPendingPoint(null);
  }

  /** 更新显示配置（单位 / 换算系数 / 小数位 / 纵轴），并刷新已有条目的标签文本 */
  public setOptions(options: DistanceMeasureOptions): void {
    if (this.disposed) return;
    if (options.unit !== undefined) this.unit = options.unit;
    if (options.unitScale !== undefined) this.unitScale = options.unitScale;
    if (options.decimals !== undefined) this.decimals = options.decimals;
    if (options.verticalAxis !== undefined) this.verticalAxis = options.verticalAxis;
    for (const entry of this.entries) {
      entry.distance = entry.start.distanceTo(entry.end) * this.unitScale;
      this.updateAxisDistances(entry);
      this.updateEntryLabel(entry);
    }
  }

  /** 是否已开启测量 */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /** 清除全部测量条目（含未完成的拾取点） */
  public clear(): void {
    for (const entry of this.entries) {
      entry.group.remove();
      entry.label.remove();
      entry.labelX.remove();
      entry.labelY.remove();
      entry.labelZ.remove();
    }
    this.entries = [];
    this.setPendingPoint(null);
  }

  /** 当前全部测量结果（端点与距离的副本，修改不影响内部状态） */
  public getMeasurements(): DistanceMeasurement[] {
    return this.entries.map((entry) => ({
      start: entry.start.clone(),
      end: entry.end.clone(),
      distance: entry.distance,
      dx: entry.dx,
      dy: entry.dy,
      dz: entry.dz,
    }));
  }

  /** 释放 DOM 与事件监听（同时清除全部测量） */
  public dispose(): void {
    if (this.disposed) return;
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    this.setCanvasCursor(null);
    this.clear();
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

  /** Esc 清除当前未完成的第一个拾取点 */
  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.disposed || !this.enabled || event.key !== 'Escape') return;
    this.setPendingPoint(null);
  };

  /** 对指针位置做射线拾取：命中模型则拾取点，未命中则忽略（不打断当前流程） */
  private pick(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.controls.object);
    const hits = this.raycaster.intersectObjects(this.targets, true);
    if (hits.length === 0) return;

    const point = hits[0].point.clone();
    if (this.pendingPoint === null) {
      // 第一个点：记录并显示待完成圆点，等待第二个点
      this.setPendingPoint(point);
      this.update();
      return;
    }
    // 第二个点：生成一条测量条目，随后可继续测量下一条
    this.createEntry(this.pendingPoint, point);
    this.setPendingPoint(null);
    this.update();
  }

  // ---------- 条目创建与更新 ----------

  /** 创建一条测量条目（SVG 分组 + 距离标签 + 轴分量折线与标签） */
  private createEntry(start: THREE.Vector3, end: THREE.Vector3): void {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g') as SVGGElement;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line') as SVGLineElement;
    line.setAttribute('stroke', MEASURE_COLOR);
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-linecap', 'round');

    const dotStart = this.createEndpointDot();
    const dotEnd = this.createEndpointDot();

    // 轴分量折线：A→C（X 轴）、C→D（纵轴）、D→B（剩余轴）
    const lineX = this.createAxisLine(AXIS_COLOR.x);
    const lineVert = this.createAxisLine(AXIS_COLOR.y);
    const lineDiag = this.createAxisLine(AXIS_COLOR.z);

    group.append(line, dotStart, dotEnd, lineX, lineVert, lineDiag);
    this.svg.append(group);

    // 距离标签：白色圆角框风格与 PointCoordinateMarker 一致，文字与边框为黑色
    const label = document.createElement('div');
    Object.assign(label.style, {
      position: 'absolute',
      transform: 'translate(-50%, -100%)',
      background: '#ffffff',
      borderRadius: '8px',
      padding: '4px 9px',
      border: '1px solid rgba(0, 0, 0, 0.35)',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
      color: MEASURE_COLOR,
      font: '12px/1.5 Consolas, Menlo, monospace',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      display: 'none',
    } as CSSStyleDeclaration);
    this.overlay.append(label);

    // 各轴分量距离标签（颜色按轴：X 绿 / Y 红 / Z 蓝，轴别由前缀 X/Y/Z 区分）
    const labelX = this.createAxisLabel(AXIS_COLOR.x, AXIS_BORDER_COLOR.x);
    const labelY = this.createAxisLabel(AXIS_COLOR.y, AXIS_BORDER_COLOR.y);
    const labelZ = this.createAxisLabel(AXIS_COLOR.z, AXIS_BORDER_COLOR.z);
    this.overlay.append(labelX, labelY, labelZ);

    const distance = start.distanceTo(end) * this.unitScale;
    const entry: MeasureEntry = {
      start, end, distance, group, line, dotStart, dotEnd, label,
      lineX, lineVert, lineDiag, labelX, labelY, labelZ,
      dx: 0, dy: 0, dz: 0,
    };
    this.updateAxisDistances(entry);
    this.updateEntryLabel(entry);
    this.entries.push(entry);
  }

  /** 创建端点圆点（白色填充黑色描边） */
  private createEndpointDot(): SVGCircleElement {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle') as SVGCircleElement;
    dot.setAttribute('r', String(ENDPOINT_RADIUS));
    dot.setAttribute('fill', '#ffffff');
    dot.setAttribute('stroke', MEASURE_COLOR);
    dot.setAttribute('stroke-width', '2');
    return dot;
  }

  /** 创建轴分量段线（细实线，颜色按轴） */
  private createAxisLine(color: string): SVGLineElement {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line') as SVGLineElement;
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-linecap', 'round');
    return line;
  }

  /** 创建轴分量距离标签（白色圆角框，文字与边框颜色按轴） */
  private createAxisLabel(color: string, borderColor: string): HTMLDivElement {
    const label = document.createElement('div');
    Object.assign(label.style, {
      position: 'absolute',
      transform: 'translate(-50%, -50%)',
      background: '#ffffff',
      borderRadius: '8px',
      padding: '2px 7px',
      border: `1px solid ${borderColor}`,
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
      color,
      font: '12px/1.5 Consolas, Menlo, monospace',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      display: 'none',
    } as CSSStyleDeclaration);
    return label;
  }

  /** 按当前换算系数重算条目的各轴分量距离 */
  private updateAxisDistances(entry: MeasureEntry): void {
    entry.dx = Math.abs(entry.end.x - entry.start.x) * this.unitScale;
    entry.dy = Math.abs(entry.end.y - entry.start.y) * this.unitScale;
    entry.dz = Math.abs(entry.end.z - entry.start.z) * this.unitScale;
  }

  /** 按当前显示配置刷新条目的标签文本（主线段 + 各轴分量） */
  private updateEntryLabel(entry: MeasureEntry): void {
    entry.label.textContent = `${entry.distance.toFixed(this.decimals)} ${this.unit}`;
    entry.labelX.textContent = `X:${entry.dx.toFixed(this.decimals)} ${this.unit}`;
    entry.labelY.textContent = `Y:${entry.dy.toFixed(this.decimals)} ${this.unit}`;
    entry.labelZ.textContent = `Z:${entry.dz.toFixed(this.decimals)} ${this.unit}`;
  }

  /** 记录 / 清除未完成的第一个拾取点（pendingDot 跟随显示） */
  private setPendingPoint(point: THREE.Vector3 | null): void {
    this.pendingPoint = point;
    if (point === null) this.pendingDot.style.display = 'none';
  }

  // ---------- 每帧更新 ----------

  /**
   * 每帧更新：把待完成拾取点与各条目的端点投影到屏幕坐标，同步 SVG 线段、
   * 圆点与标签位置。端点位于相机背后时隐藏对应元素。由外部渲染循环调用。
   */
  public update(): void {
    if (this.disposed) return;
    if (this.entries.length === 0 && this.pendingPoint === null) return;

    const camera = this.controls.object;
    const camDir = camera.getWorldDirection(_camDir);
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    // 待完成拾取点圆点（拾取点固定在模型表面，投影随相机视角变化）
    if (this.pendingPoint !== null) {
      const p = this.projectToScreen(this.pendingPoint, camera, camDir, rect, _screenA);
      if (p) {
        this.pendingDot.setAttribute('cx', `${p.x}`);
        this.pendingDot.setAttribute('cy', `${p.y}`);
        this.pendingDot.style.display = 'block';
      } else {
        this.pendingDot.style.display = 'none';
      }
    }

    for (const entry of this.entries) {
      const a = this.projectToScreen(entry.start, camera, camDir, rect, _screenA);
      const b = this.projectToScreen(entry.end, camera, camDir, rect, _screenB);
      // 任一端点转到相机背后时投影会翻转错位，整条隐藏
      if (!a || !b) {
        entry.group.style.display = 'none';
        entry.label.style.display = 'none';
        this.setAxisSegment(entry.lineX, entry.labelX, null, null, 0);
        this.setAxisSegment(entry.lineVert, entry.labelY, null, null, 0);
        this.setAxisSegment(entry.lineDiag, entry.labelZ, null, null, 0);
        continue;
      }
      entry.group.style.display = 'block';
      entry.label.style.display = 'block';

      entry.line.setAttribute('x1', `${a.x}`);
      entry.line.setAttribute('y1', `${a.y}`);
      entry.line.setAttribute('x2', `${b.x}`);
      entry.line.setAttribute('y2', `${b.y}`);
      entry.dotStart.setAttribute('cx', `${a.x}`);
      entry.dotStart.setAttribute('cy', `${a.y}`);
      entry.dotEnd.setAttribute('cx', `${b.x}`);
      entry.dotEnd.setAttribute('cy', `${b.y}`);

      // 标签锚定在线段中点上方（间距 12px），不遮挡线段
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      entry.label.style.left = `${mx}px`;
      entry.label.style.top = `${my - 12}px`;

      // 轴分量折线：A→C（X 轴）、C→D（纵轴）、D→B（剩余轴），
      // 折点由世界坐标求出后投影，跟随相机视角转动
      const a3 = entry.start;
      const b3 = entry.end;
      _cornerC.set(b3.x, a3.y, a3.z);
      if (this.verticalAxis === 'z') {
        _cornerD.set(b3.x, a3.y, b3.z);
      } else {
        _cornerD.set(b3.x, b3.y, a3.z);
      }
      const c = this.projectToScreen(_cornerC, camera, camDir, rect, _screenC);
      const d = this.projectToScreen(_cornerD, camera, camDir, rect, _screenD);

      this.setAxisSegment(entry.lineX, entry.labelX, a, c, entry.dx);
      if (this.verticalAxis === 'z') {
        this.setAxisSegment(entry.lineVert, entry.labelZ, c, d, entry.dz);
        this.setAxisSegment(entry.lineDiag, entry.labelY, d, b, entry.dy);
      } else {
        this.setAxisSegment(entry.lineVert, entry.labelY, c, d, entry.dy);
        this.setAxisSegment(entry.lineDiag, entry.labelZ, d, b, entry.dz);
      }
    }
  }

  /**
   * 布局单个轴分量段：两端投影均可见且分量距离非零时，绘制线段并在其中点
   * 显示该轴距离标签；否则隐藏对应线段与标签。
   */
  private setAxisSegment(
    line: SVGLineElement,
    label: HTMLDivElement,
    from: { x: number; y: number } | null,
    to: { x: number; y: number } | null,
    distance: number,
  ): void {
    if (from === null || to === null || distance < AXIS_MIN_DISTANCE) {
      line.style.display = 'none';
      label.style.display = 'none';
      return;
    }
    line.style.display = 'block';
    label.style.display = 'block';
    line.setAttribute('x1', `${from.x}`);
    line.setAttribute('y1', `${from.y}`);
    line.setAttribute('x2', `${to.x}`);
    line.setAttribute('y2', `${to.y}`);
    label.style.left = `${(from.x + to.x) / 2}px`;
    label.style.top = `${(from.y + to.y) / 2}px`;
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
const _screenA = { x: 0, y: 0 };
const _screenB = { x: 0, y: 0 };
const _screenC = { x: 0, y: 0 };
const _screenD = { x: 0, y: 0 };
const _cornerC = new THREE.Vector3();
const _cornerD = new THREE.Vector3();
