import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** 点击判定阈值：按下与抬起位移不超过该值（像素）视为点击，超过视为拖拽旋转 */
const CLICK_MOVE_THRESHOLD_PX = 4;

/** 端点圆点半径（像素） */
const ENDPOINT_RADIUS = 4;

/** 顶点角度弧线半径（像素，固定屏幕尺寸，与 ClippingPlane 操作柄同一思路） */
const ARC_RADIUS = 22;

/** 标签相对顶点的偏移间距（像素） */
const LABEL_OFFSET_PX = 8;

/** 测量元素统一颜色（线条 / 文本 / 文本框描边均为黑色） */
const MEASURE_COLOR = '#000000';

export interface AngleMeasureOptions {
  /** 角度显示单位名称；默认 '°' */
  unit?: string;
  /** 角度数值小数位；默认 1 */
  decimals?: number;
}

/** 单条角度测量结果（角度为顶点处两边的夹角，单位度） */
export interface AngleMeasurement {
  /** 角度的顶点（世界坐标） */
  vertex: THREE.Vector3;
  /** 第一条边的端点（世界坐标） */
  start: THREE.Vector3;
  /** 第二条边的端点（世界坐标） */
  end: THREE.Vector3;
  /** 夹角（度） */
  angle: number;
}

/** 单条测量条目：数据与渲染节点一一对应 */
interface AngleEntry {
  vertex: THREE.Vector3;
  start: THREE.Vector3;
  end: THREE.Vector3;
  /** 夹角（度） */
  angle: number;
  /** 该条目的 SVG 分组（两条边线 + 顶点弧线 + 三个端点圆点） */
  group: SVGGElement;
  lineStart: SVGLineElement;
  lineEnd: SVGLineElement;
  arc: SVGPathElement;
  dotVertex: SVGCircleElement;
  dotStart: SVGCircleElement;
  dotEnd: SVGCircleElement;
  /** 该条目的角度数值标签（HTML，位置锚定在弧线外侧角平分方向） */
  label: HTMLDivElement;
}

/**
 * AngleMeasure - 角度测量工具（类似 Autodesk Viewer 的角度测量）。
 *
 * 开启后监听画布上的鼠标左键点击：射线命中模型表面时拾取点。依次点击三个
 * 点即生成一条角度测量 —— 中间一次点击为角度顶点，另两次点击为两条边的
 * 端点；渲染为顶点到两端点的两条线段、顶点处一段圆弧与三个端点圆点，弧线
 * 外侧角平分方向显示带度数符号的角度标签。可连续测量，所有测量条目同时
 * 保留。
 *
 * 渲染采用 SVG/DOM 覆盖层（fixed 定位，与 DistanceMeasure 完全同一思路）：
 * 线段 / 弧线 / 圆点绘制在覆盖层 <svg> 上，数值标签用 HTML 圆角框。每帧
 * 把各端点的世界坐标投影到屏幕坐标并更新节点位置 —— 测量锚定在模型表面、
 * 跟随相机视角转动；任一端点转到相机背后时自动隐藏对应条目。弧线半径为
 * 固定像素尺寸（世界尺寸无关）。覆盖层始终显示在模型之上（不被模型遮挡），
 * 且不拦截画布的鼠标事件。
 *
 * 点击与拖拽区分、Esc 清除未完成拾取点、enable / disable 语义均与
 * DistanceMeasure 一致：disable 仅停止拾取、清除未完成的拾取点，已完成的
 * 测量保留显示；再次 enable 时清除全部旧测量；clear() 供外部在任意时刻
 * 手动清除全部测量。
 */
export class AngleMeasure {
  private canvas: HTMLElement;
  private controls: OrbitControls;
  /** 显示配置（单位 / 小数位） */
  private unit: string;
  private decimals: number;
  /** 射线拾取目标（模型的根节点或网格对象数组），enable() 时传入 */
  private targets: THREE.Object3D[] = [];
  private raycaster = new THREE.Raycaster();
  private enabled = false;
  private disposed = false;
  /** 已完成的测量条目（按创建顺序） */
  private entries: AngleEntry[] = [];
  /** 当前未完成的拾取点序列（0~2 个，依次为边端点 / 顶点），空表示无待完成拾取 */
  private pendingPoints: THREE.Vector3[] = [];
  /** 待完成拾取点的圆点标记（随 pendingPoints 增减显示） */
  private pendingDots: SVGCircleElement[] = [];
  /** 待完成状态两个已拾取点（A、B）之间的连线 */
  private pendingLine: SVGLineElement;
  /** 橡皮筋预览线：拾取进行中从已选锚点连到当前鼠标位置，随鼠标移动 */
  private rubberLine: SVGLineElement;
  /** 最近一次鼠标的视口坐标（无记录 / 鼠标离开画布时隐藏预览线） */
  private mouseX = 0;
  private mouseY = 0;
  private hasMousePos = false;
  /** 开启前的画布 cursor，disable / dispose 时恢复 */
  private prevCursor: string | null = null;

  // ---------- DOM ----------
  /** 覆盖层容器（fixed 定位锚点，内部元素按视口坐标定位） */
  private overlay: HTMLDivElement;
  /** SVG 覆盖层：承载所有测量条目与待完成拾取点（尺寸随视口 100% 拉伸） */
  private svg: SVGSVGElement;

  // ---------- 点击检测状态 ----------
  /** 已按下的左键指针 id，null 表示未按下 */
  private downPointerId: number | null = null;
  private downX = 0;
  private downY = 0;

  constructor(canvas: HTMLElement, controls: OrbitControls, options: AngleMeasureOptions = {}) {
    this.canvas = canvas;
    this.controls = controls;
    this.unit = options.unit ?? '°';
    this.decimals = options.decimals ?? 1;

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

    this.overlay.append(this.svg);
    document.body.append(this.overlay);

    // 待完成拾取点连线：黑色实线，与正式测量边线同款
    this.pendingLine = this.createEdgeLine();
    this.pendingLine.style.display = 'none';
    this.svg.append(this.pendingLine);

    // 橡皮筋预览线：黑色虚线，区分于正式测量边线
    this.rubberLine = document.createElementNS('http://www.w3.org/2000/svg', 'line') as SVGLineElement;
    this.rubberLine.setAttribute('stroke', MEASURE_COLOR);
    this.rubberLine.setAttribute('stroke-width', '2');
    this.rubberLine.setAttribute('stroke-dasharray', '6 4');
    this.rubberLine.style.display = 'none';
    this.svg.append(this.rubberLine);

    // 点击检测监听（挂在画布上；OrbitControls 拖拽期间对画布做指针捕获，
    // 抬起事件仍会派发到画布）
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    // 跟踪鼠标位置（驱动橡皮筋预览线）
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
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
    this.setPendingPoints([]);
  }

  /** 更新显示配置（单位 / 小数位），并刷新已有条目的标签文本 */
  public setOptions(options: AngleMeasureOptions): void {
    if (this.disposed) return;
    if (options.unit !== undefined) this.unit = options.unit;
    if (options.decimals !== undefined) this.decimals = options.decimals;
    for (const entry of this.entries) {
      entry.angle = this.computeAngle(entry.vertex, entry.start, entry.end);
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
    }
    this.entries = [];
    this.setPendingPoints([]);
  }

  /** 当前全部测量结果（顶点 / 边端点与角度的副本，修改不影响内部状态） */
  public getMeasurements(): AngleMeasurement[] {
    return this.entries.map((entry) => ({
      vertex: entry.vertex.clone(),
      start: entry.start.clone(),
      end: entry.end.clone(),
      angle: entry.angle,
    }));
  }

  /** 释放 DOM 与事件监听（同时清除全部测量） */
  public dispose(): void {
    if (this.disposed) return;
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
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

  /** 跟踪鼠标位置，供橡皮筋预览线使用 */
  private onPointerMove = (event: PointerEvent): void => {
    this.mouseX = event.clientX;
    this.mouseY = event.clientY;
    this.hasMousePos = true;
  };

  /** 鼠标离开画布时隐藏橡皮筋预览线（位置已过期） */
  private onPointerLeave = (): void => {
    this.hasMousePos = false;
  };

  /** Esc 清除当前未完成的拾取点 */
  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.disposed || !this.enabled || event.key !== 'Escape') return;
    this.setPendingPoints([]);
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
    const points = [...this.pendingPoints, point];
    if (points.length < 3) {
      // 第 1 / 2 个点（边端点 / 顶点）：记录并显示待完成圆点，等待后续点击
      this.setPendingPoints(points);
      this.update();
      return;
    }
    // 第 3 个点：生成一条角度测量条目，随后可继续测量下一条
    this.createEntry(points[0], points[1], points[2]);
    this.setPendingPoints([]);
    this.update();
  }

  // ---------- 条目创建与更新 ----------

  /** 创建一条角度测量条目（SVG 分组 + 角度标签） */
  private createEntry(start: THREE.Vector3, vertex: THREE.Vector3, end: THREE.Vector3): void {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g') as SVGGElement;

    const lineStart = this.createEdgeLine();
    const lineEnd = this.createEdgeLine();

    // 顶点处夹角弧线：屏幕空间固定半径，d 由每帧 update 重算
    const arc = document.createElementNS('http://www.w3.org/2000/svg', 'path') as SVGPathElement;
    arc.setAttribute('fill', 'rgba(0, 0, 0, 0.12)');
    arc.setAttribute('stroke', MEASURE_COLOR);
    arc.setAttribute('stroke-width', '2');

    const dotVertex = this.createEndpointDot();
    const dotStart = this.createEndpointDot();
    const dotEnd = this.createEndpointDot();
    // 顶点圆点用实心黑，与两个边端点（白底黑边）区分
    dotVertex.setAttribute('fill', MEASURE_COLOR);

    group.append(lineStart, lineEnd, arc, dotVertex, dotStart, dotEnd);
    this.svg.append(group);

    // 角度标签：白色圆角框风格与 DistanceMeasure 一致，文字与边框为黑色
    const label = document.createElement('div');
    Object.assign(label.style, {
      position: 'absolute',
      transform: 'translate(-50%, -50%)',
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

    const entry: AngleEntry = {
      vertex,
      start,
      end,
      angle: 0,
      group,
      lineStart,
      lineEnd,
      arc,
      dotVertex,
      dotStart,
      dotEnd,
      label,
    };
    entry.angle = this.computeAngle(vertex, start, end);
    this.updateEntryLabel(entry);
    this.entries.push(entry);
  }

  /** 创建测量边线段（黑色实线） */
  private createEdgeLine(): SVGLineElement {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line') as SVGLineElement;
    line.setAttribute('stroke', MEASURE_COLOR);
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-linecap', 'round');
    return line;
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

  /** 计算顶点处两条边的夹角（度）；退化边（端点与顶点重合）时夹角视为 0 */
  private computeAngle(vertex: THREE.Vector3, start: THREE.Vector3, end: THREE.Vector3): number {
    const d1 = _v1.subVectors(start, vertex);
    const d2 = _v2.subVectors(end, vertex);
    if (d1.lengthSq() === 0 || d2.lengthSq() === 0) return 0;
    const cos = THREE.MathUtils.clamp(d1.normalize().dot(d2.normalize()), -1, 1);
    return THREE.MathUtils.radToDeg(Math.acos(cos));
  }

  /** 按当前显示配置刷新条目的标签文本 */
  private updateEntryLabel(entry: AngleEntry): void {
    entry.label.textContent = `${entry.angle.toFixed(this.decimals)}${this.unit}`;
  }

  /** 记录 / 清除未完成的拾取点序列（pendingDots 跟随增减显示） */
  private setPendingPoints(points: THREE.Vector3[]): void {
    this.pendingPoints = points;
    // 补足圆点
    while (this.pendingDots.length < points.length) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle') as SVGCircleElement;
      dot.setAttribute('r', String(ENDPOINT_RADIUS));
      dot.setAttribute('fill', '#ffffff');
      dot.setAttribute('stroke', MEASURE_COLOR);
      dot.setAttribute('stroke-width', '2');
      dot.style.display = 'none';
      this.svg.append(dot);
      this.pendingDots.push(dot);
    }
    // 隐藏多余的圆点
    for (let i = 0; i < this.pendingDots.length; i++) {
      this.pendingDots[i].style.display = i < points.length ? 'block' : 'none';
    }
    // 清空拾取点时同步隐藏预览线与连线
    if (points.length < 2) this.pendingLine.style.display = 'none';
    if (points.length === 0) this.rubberLine.style.display = 'none';
  }

  // ---------- 每帧更新 ----------

  /**
   * 每帧更新：把未完成拾取点与各条目的端点投影到屏幕坐标，同步 SVG 线段、
   * 弧线、圆点与标签位置。端点位于相机背后时隐藏对应元素。由外部渲染循环
   * 调用。
   */
  public update(): void {
    if (this.disposed) return;
    if (this.entries.length === 0 && this.pendingPoints.length === 0) return;

    const camera = this.controls.object;
    const camDir = camera.getWorldDirection(_camDir);
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    // 未完成拾取点的圆点（拾取点固定在模型表面，投影随相机视角变化）
    for (let i = 0; i < this.pendingPoints.length; i++) {
      const p = this.projectToScreen(this.pendingPoints[i], camera, camDir, rect, _screenA);
      const dot = this.pendingDots[i];
      if (p) {
        dot.setAttribute('cx', `${p.x}`);
        dot.setAttribute('cy', `${p.y}`);
        dot.style.display = 'block';
      } else {
        dot.style.display = 'none';
      }
    }

    // 已拾取两个点（A、B）时绘制两点之间的实线连线；任一端点转到相机背后时隐藏
    if (this.pendingPoints.length === 2) {
      const pa = this.projectToScreen(this.pendingPoints[0], camera, camDir, rect, _screenA);
      const pb = this.projectToScreen(this.pendingPoints[1], camera, camDir, rect, _screenB);
      if (pa && pb) {
        this.pendingLine.setAttribute('x1', `${pa.x}`);
        this.pendingLine.setAttribute('y1', `${pa.y}`);
        this.pendingLine.setAttribute('x2', `${pb.x}`);
        this.pendingLine.setAttribute('y2', `${pb.y}`);
        this.pendingLine.style.display = 'block';
      } else {
        this.pendingLine.style.display = 'none';
      }
    }

    // 橡皮筋预览线：已有 1 个点时连到该点（A），已有 2 个点时连到顶点（B），
    // 另一端始终跟随当前鼠标位置
    if (this.hasMousePos && this.pendingPoints.length > 0) {
      const anchorIndex = this.pendingPoints.length === 1 ? 0 : 1;
      const anchor = this.projectToScreen(
        this.pendingPoints[anchorIndex], camera, camDir, rect, _screenR,
      );
      if (anchor) {
        this.rubberLine.setAttribute('x1', `${anchor.x}`);
        this.rubberLine.setAttribute('y1', `${anchor.y}`);
        this.rubberLine.setAttribute('x2', `${this.mouseX}`);
        this.rubberLine.setAttribute('y2', `${this.mouseY}`);
        this.rubberLine.style.display = 'block';
      } else {
        // 锚点转到相机背后，投影会翻转错位，隐藏预览线
        this.rubberLine.style.display = 'none';
      }
    } else {
      this.rubberLine.style.display = 'none';
    }

    for (const entry of this.entries) {
      const v = this.projectToScreen(entry.vertex, camera, camDir, rect, _screenV);
      const a = this.projectToScreen(entry.start, camera, camDir, rect, _screenA);
      const b = this.projectToScreen(entry.end, camera, camDir, rect, _screenB);
      // 任一端点转到相机背后时投影会翻转错位，整条隐藏
      if (!v || !a || !b) {
        entry.group.style.display = 'none';
        entry.label.style.display = 'none';
        continue;
      }
      entry.group.style.display = 'block';
      entry.label.style.display = 'block';

      // 两条边线段
      entry.lineStart.setAttribute('x1', `${v.x}`);
      entry.lineStart.setAttribute('y1', `${v.y}`);
      entry.lineStart.setAttribute('x2', `${a.x}`);
      entry.lineStart.setAttribute('y2', `${a.y}`);
      entry.lineEnd.setAttribute('x1', `${v.x}`);
      entry.lineEnd.setAttribute('y1', `${v.y}`);
      entry.lineEnd.setAttribute('x2', `${b.x}`);
      entry.lineEnd.setAttribute('y2', `${b.y}`);
      entry.dotVertex.setAttribute('cx', `${v.x}`);
      entry.dotVertex.setAttribute('cy', `${v.y}`);
      entry.dotStart.setAttribute('cx', `${a.x}`);
      entry.dotStart.setAttribute('cy', `${a.y}`);
      entry.dotEnd.setAttribute('cx', `${b.x}`);
      entry.dotEnd.setAttribute('cy', `${b.y}`);

      // 顶点弧线：屏幕空间固定半径，从一边方向画到另一边方向，取内部夹角
      // （两点几乎重合时方向退化，跳过弧线只保留线段）
      const d1x = a.x - v.x;
      const d1y = a.y - v.y;
      const d2x = b.x - v.x;
      const d2y = b.y - v.y;
      const len1 = Math.hypot(d1x, d1y);
      const len2 = Math.hypot(d2x, d2y);
      if (len1 > 1e-6 && len2 > 1e-6) {
        const u1x = d1x / len1;
        const u1y = d1y / len1;
        const u2x = d2x / len2;
        const u2y = d2y / len2;
        const ax = v.x + u1x * ARC_RADIUS;
        const ay = v.y + u1y * ARC_RADIUS;
        const bx = v.x + u2x * ARC_RADIUS;
        const by = v.y + u2y * ARC_RADIUS;
        // 屏幕坐标 y 向下：atan2 差值归一化到 (-π, π]，正方向为顺时针
        //（SVG sweep=1），取较短的内部夹角（largeArc=0）
        let delta = Math.atan2(u2y, u2x) - Math.atan2(u1y, u1x);
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        const sweep = delta > 0 ? 1 : 0;
        entry.arc.setAttribute(
          'd',
          `M ${ax} ${ay} A ${ARC_RADIUS} ${ARC_RADIUS} 0 0 ${sweep} ${bx} ${by}`,
        );
        entry.arc.style.display = 'inline';

        // 标签锚定在弧线外侧角平分方向（弧线半径 + 间距处），不遮挡线段
        let bisX = u1x + u2x;
        let bisY = u1y + u2y;
        const bisLen = Math.hypot(bisX, bisY);
        if (bisLen < 1e-6) {
          // 两边方向相反（180°）时角平分线退化，任取一个垂直方向
          bisX = -u1y;
          bisY = u1x;
        } else {
          bisX /= bisLen;
          bisY /= bisLen;
        }
        entry.label.style.left = `${v.x + bisX * (ARC_RADIUS + LABEL_OFFSET_PX)}px`;
        entry.label.style.top = `${v.y + bisY * (ARC_RADIUS + LABEL_OFFSET_PX)}px`;
      } else {
        entry.arc.style.display = 'none';
        // 端点与顶点重合：标签放在顶点正上方
        entry.label.style.left = `${v.x}px`;
        entry.label.style.top = `${v.y - ARC_RADIUS - LABEL_OFFSET_PX}px`;
      }
    }
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
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _screenA = { x: 0, y: 0 };
const _screenB = { x: 0, y: 0 };
const _screenV = { x: 0, y: 0 };
const _screenR = { x: 0, y: 0 };
