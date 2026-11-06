import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { UpAxis } from './ViewerControls';

export interface SectionBoxOptions {
  /** 边框线颜色，默认橙色 0xff9f43 */
  borderColor?: number;
  /** TransformControls gizmo 大小，默认 0.8 */
  gizmoSize?: number;
  /**
   * 拖拽 gizmo 开始 / 结束时的回调（开始为 true，结束为 false）。
   * 外部通常在其中暂停 / 恢复 OrbitControls，避免拖拽剖切框时相机跟着转。
   */
  onDraggingChange?: (dragging: boolean) => void;
    /**
   * 世界坐标的上方向轴。
   * - 'Y_UP'：Y 轴向上（three.js 默认习惯），相机 up = (0,1,0)；
   * - 'Z_UP'：Z 轴向上（CAD 常用习惯），相机 up = (0,0,1)；
   * 默认 'Z_UP'。仅构造时生效，不支持运行时切换。
   */
  upAxis?: UpAxis;
}

/**
 * SectionBox - Revit 风格的剖切框（渲染与交互逻辑独立成类）。
 *
 * - 初始大小与位置由场景包围盒（ViewerControls.sceneBBox）决定，为一个与包围盒重合的长方体；
 * - 由 6 个朝内的裁剪平面围成：框外的模型部分被裁掉（可直接用于 renderer.clippingPlanes）；
 * - 内置 TransformControls（translate 模式），拖拽 gizmo 的坐标轴箭头即可平移剖切框，
 *   6 个裁剪平面随之同步移动；中心手柄仅允许在 ZX 平面内移动（Y 固定）；
 * - +X / +Y / +Z 面中心各有一个尺寸箭头，沿轴拖拽箭头可调整剖切框在该轴上的宽度
 *   （负方向的面保持不动）；
 * - object3d 为可视化的框线（需由外部加入场景渲染），
 *   gizmoHelper 为 TransformControls 的可视化操作柄（同样需由外部加入场景）；
 *   gizmoHelper 默认隐藏，鼠标悬停到剖切框上时才出现，移开后再次隐藏；
 *   尺寸箭头优先：悬停在箭头上时隐藏并禁用 gizmo，避免两者同时响应；
 * - 框线比裁剪边界向内收缩了一个极小量，避免被自己的裁剪平面裁掉。
 */
export class SectionBox {
  /** 可视化框线（中心即剖切框中心），由外部加入场景渲染 */
  public readonly object3d: THREE.Group;
  /** TransformControls（translate 模式），拖拽其 gizmo 平移剖切框 */
  public readonly transformControls: TransformControls;
  /** TransformControls 的可视化操作柄，由外部加入场景渲染 */
  public readonly gizmoHelper: THREE.Object3D;
  /** 世界坐标上方向轴（构造时确定，不可变更） */
  public readonly upAxis: UpAxis;

  /** 剖切框尺寸（平移不变；拖拽尺寸箭头时变化） */
  private size: THREE.Vector3;
  /** 尺寸下限，防止把剖切框拖成零 / 负尺寸导致裁剪退化 */
  private readonly minSize: number;
  /** 框线相对裁剪边界向内收缩的量，避免被自己的裁剪平面裁掉 */
  private readonly epsilon: number;
  /** 6 个裁剪平面（法线均朝向框内），可直接用于 renderer.clippingPlanes */
  private readonly planes: THREE.Plane[] = [];
  private readonly lines: THREE.LineSegments;
  /** 拖拽开始时记录的 Y 坐标与手柄轴，用于把中心手柄（XYZ）的移动约束在 ZX 平面内 */
  private dragStartY = 0;
  private dragStartZ = 0;
  private dragAxis: string | null = null;
  /** 相机与监听元素引用，用于悬停射线检测 */
  private readonly camera: THREE.Camera;
  private readonly domElement: HTMLElement;
  /** 悬停检测：用不可见实体盒（比线框射线检测稳定）作为拾取体 */
  private readonly hitBox: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  /** gizmo 当前是否可见（悬停 / 拖拽中） */
  private gizmoVisible = false;
  /** 最近一次指针的客户端坐标（悬停检测用） */
  private lastClientX = -1;
  private lastClientY = -1;
  /** 拖拽开始 / 结束回调（外部用于暂停 OrbitControls） */
  private readonly onDraggingChange?: (dragging: boolean) => void;
  /** +X / +Y / +Z 面中心各一个尺寸箭头（含杆与锥头），沿轴拖拽调整该轴宽度 */
  private readonly arrowRoot = new THREE.Group();
  private readonly arrows: THREE.Group[] = [];
  /** 当前箭头拖拽状态（null 表示未在拖拽箭头） */
  private arrowDrag: {
    axis: 'x' | 'y' | 'z';
    plane: THREE.Plane;
    startPoint: THREE.Vector3;
    startSize: number;
    startCenter: number;
  } | null = null;
  /** 当前悬停的尺寸箭头（用于高亮与光标反馈） */
  private hoveredArrow: THREE.Group | null = null;

  constructor(
    camera: THREE.Camera,
    domElement: HTMLElement,
    sceneBBox: THREE.Box3,
    options: SectionBoxOptions = {},
  ) {
    this.camera = camera;
    this.domElement = domElement;
    this.onDraggingChange = options.onDraggingChange;
    this.upAxis = options.upAxis ?? 'Z_UP';

    // 剖切框尺寸：取场景包围盒大小，防止零尺寸导致裁剪退化
    const raw = sceneBBox.getSize(new THREE.Vector3());
    const minSize = 1e-3;
    this.minSize = minSize;
    this.size = new THREE.Vector3(
      Math.max(raw.x, minSize),
      Math.max(raw.y, minSize),
      Math.max(raw.z, minSize),
    );
    this.epsilon = Math.max(this.size.x, this.size.y, this.size.z) * 1e-3;

    // 可视化框线：比裁剪边界向内收缩 epsilon
    const boxGeometry = new THREE.BoxGeometry(
      this.size.x - this.epsilon * 2,
      this.size.y - this.epsilon * 2,
      this.size.z - this.epsilon * 2,
    );
    this.lines = new THREE.LineSegments(
      new THREE.EdgesGeometry(boxGeometry),
      new THREE.LineBasicMaterial({ color: options.borderColor ?? 0x444444 }),
    );
    boxGeometry.dispose();

    this.object3d = new THREE.Group();
    this.object3d.add(this.lines);
    this.object3d.position.copy(sceneBBox.getCenter(new THREE.Vector3()));

    // 6 个裁剪平面：法线朝向框内，框内一侧（distance >= 0）保留，框外被裁掉。
    // 顺序：X 最小面 / X 最大面 / Y 最小面 / Y 最大面 / Z 最小面 / Z 最大面
    this.planes = [
      new THREE.Plane(new THREE.Vector3(1, 0, 0), 0),
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0),
      new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      new THREE.Plane(new THREE.Vector3(0, -1, 0), 0),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
      new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
    ];
    this.updatePlanes();

    // TransformControls（translate 模式）：拖拽 gizmo 平移剖切框
    this.transformControls = new TransformControls(camera, domElement);
    this.transformControls.showYZ = false;
    this.transformControls.showXY = false;
    this.transformControls.showXZ = false;
    this.transformControls.setMode('translate');
    this.transformControls.setSize(options.gizmoSize ?? 0.8);
    this.transformControls.attach(this.object3d);
    this.gizmoHelper = this.transformControls.getHelper();

    // 隐藏 XY / YZ 平面手柄：TransformControls 未提供 showXY / showYZ 属性，
    // 且每帧 updateMatrixWorld 会强制 handle.visible = true，
    // 故直接把名字为 XY / YZ 的渲染 gizmo 与拾取体从场景图移除（保留 XZ 平面手柄）
    const hiddenHandles: THREE.Object3D[] = [];
    this.gizmoHelper.traverse((obj) => {
      if (obj.name === 'XY' || obj.name === 'YZ' || obj.name === 'XZ') hiddenHandles.push(obj);
    });
    for (const obj of hiddenHandles) obj.removeFromParent();

    // gizmo 默认隐藏并禁用交互，悬停到剖切框上时再显示 / 启用
    this.gizmoHelper.visible = false;
    this.transformControls.enabled = false;
    this.hitBox = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1), // 单位盒，尺寸变化时通过 scale 同步
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.hitBox.scale.copy(this.size);
    this.object3d.add(this.hitBox);
    this.object3d.add(this.arrowRoot);
    this.buildArrows();

    // 平移过程中实时同步裁剪平面；中心手柄仅允许在 ZX 平面内移动，Y 轴手柄可单独拖拽
    this.transformControls.addEventListener('objectChange', this.onObjectChange);

    // 拖拽开始 / 结束回调（r170+ 已不再派发 dragging-changed，用 mouseDown / mouseUp 代替）
    const dragging = this.onDraggingChange;
    this.transformControls.addEventListener('mouseDown', () => {
      // mouseDown 时 axis 已在 hover 阶段确定，记录本次拖拽的操作手柄
      this.dragAxis = this.transformControls.axis;
      this.dragStartY = this.object3d.position.y;
      this.dragStartZ = this.object3d.position.z;
      dragging?.(true);
    });
    this.transformControls.addEventListener('mouseUp', () => {
      dragging?.(false);
      // 拖拽结束后若指针不在剖切框上，立即隐藏 gizmo
      this.evaluateHover();
    });

    // 自定义尺寸箭头的按下 / 抬起（拖拽过程在 onPointerMove 中处理）
    domElement.addEventListener('pointerdown', this.onPointerDown);
    domElement.addEventListener('pointerup', this.onPointerUp);

    // 悬停检测：鼠标移到剖切框上（或拖拽 gizmo 中）时显示 gizmo，移开后隐藏
    domElement.addEventListener('pointermove', this.onPointerMove);
    domElement.addEventListener('pointerleave', this.onPointerLeave);
  }

  /** 返回 6 个裁剪平面（可直接用于 renderer.clippingPlanes / material.clippingPlanes） */
  public getPlanes(): THREE.Plane[] {
    return this.planes;
  }

  /** 依据剖切框当前位置同步 6 个裁剪平面（每帧调用一次即可保持同步） */
  public updatePlanes(): void {
    const c = this.object3d.position;
    const hx = this.size.x / 2;
    const hy = this.size.y / 2;
    const hz = this.size.z / 2;
    // 面方程：n·p + constant = 0。法线朝内，constant 取该面在法线方向上的相反数
    this.planes[0].constant = -(c.x - hx); // x = min 面，法线 +X
    this.planes[1].constant = c.x + hx; // x = max 面，法线 -X
    this.planes[2].constant = -(c.y - hy); // y = min 面，法线 +Y
    this.planes[3].constant = c.y + hy; // y = max 面，法线 -Y
    this.planes[4].constant = -(c.z - hz); // z = min 面，法线 +Z
    this.planes[5].constant = c.z + hz; // z = max 面，法线 -Z
  }

  /** 当前是否正在拖拽 gizmo */
  public isDragging(): boolean {
    return this.transformControls.dragging;
  }

  /** 释放可视化资源并解绑事件 */
  public dispose(): void {
    this.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.domElement.removeEventListener('pointerleave', this.onPointerLeave);
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.transformControls.removeEventListener('objectChange', this.onObjectChange);
    this.transformControls.dispose();
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.hitBox.geometry.dispose();
    (this.hitBox.material as THREE.Material).dispose();
    for (const arrow of this.arrows) {
      for (const child of arrow.children) (child as THREE.Mesh).geometry.dispose();
      (arrow.userData.material as THREE.Material).dispose();
    }
    this.arrows.length = 0;
    this.object3d.removeFromParent();
    this.gizmoHelper.removeFromParent();
  }

  private onObjectChange = (): void => {
    // 仅中心手柄（XYZ）约束在 ZX 平面内移动；Y 轴手柄（及含 Y 的平面手柄）可正常沿 Y 移动
    if (this.dragAxis === 'XYZ') {
      if (this.upAxis === 'Y_UP') {
        this.object3d.position.y = this.dragStartY;
      } else if (this.upAxis === 'Z_UP') {
        this.object3d.position.z = this.dragStartZ;
      }
    }
    this.updatePlanes();
  };

  private onPointerMove = (event: PointerEvent): void => {
    this.lastClientX = event.clientX;
    this.lastClientY = event.clientY;
    this.updatePointerFromEvent(event);
    // 正在拖拽尺寸箭头时走箭头拖拽逻辑，跳过悬停检测
    if (this.arrowDrag) {
      this.updateArrowDrag();
      return;
    }
    this.evaluateHover();
  };

  /** 依据最近一次指针位置判断 gizmo 应显示还是隐藏 */
  private evaluateHover(): void {
    const rect = this.domElement.getBoundingClientRect();
    this.pointer.set(
      ((this.lastClientX - rect.left) / rect.width) * 2 - 1,
      -((this.lastClientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hoverBox = this.raycaster.intersectObject(this.hitBox, false).length > 0;
    const hoverArrow = this.pickArrow();
    this.setHoveredArrow(hoverArrow);
    // 箭头优先：悬停在尺寸箭头上时禁用（隐藏）TransformControls，
    // 避免箭头与 gizmo 手柄重叠时两者同时响应；正在拖拽 gizmo 时除外
    if (hoverArrow !== null && !this.transformControls.dragging) {
      this.setGizmoVisible(false);
      return;
    }
    // 已显示时鼠标悬停在 gizmo 手柄上（axis 非空）或拖拽中均保持可见，
    // 避免移出盒体瞬间 gizmo 消失导致拖拽中断
    const hoverGizmo =
      this.gizmoVisible && (this.transformControls.axis !== null || this.transformControls.dragging);
    this.setGizmoVisible(hoverBox || hoverGizmo);
  }

  // ---------- 尺寸箭头（+X / +Y / +Z 面的宽度调节手柄） ----------

  /** 三个轴方向的单位向量（箭头 userData.axis -> 向量） */
  private static readonly AXIS_VECTORS: Record<'x' | 'y' | 'z', THREE.Vector3> = {
    x: new THREE.Vector3(1, 0, 0),
    y: new THREE.Vector3(0, 1, 0),
    z: new THREE.Vector3(0, 0, 1),
  };

  /** 创建三个轴的尺寸箭头（杆 + 锥头），大小固定，并在 +X / +Y / +Z 面中心定位 */
  private buildArrows(): void {
    const defs: Array<{
      axis: 'x' | 'y' | 'z';
      base: number;
      highlight: number;
      rot: [number, number, number];
    }> = [
      { axis: 'x', base: 0xe05252, highlight: 0xff9a9a, rot: [0, 0, -Math.PI / 2] }, // 局部 +Y 旋到 +X
      { axis: 'y', base: 0x53b353, highlight: 0x9be89b, rot: [0, 0, 0] },
      { axis: 'z', base: 0x5279e0, highlight: 0x9ab8ff, rot: [Math.PI / 2, 0, 0] }, // 局部 +Y 旋到 +Z
    ];
    const maxDim = Math.max(this.size.x, this.size.y, this.size.z);
    const radius = THREE.MathUtils.clamp(maxDim * 0.008, 0.015, 0.05);
    // 箭头总长在创建时按初始场景尺寸确定，之后保持不变（拖拽调宽时不改变箭头大小）
    const total = THREE.MathUtils.clamp(maxDim * 0.18, 0.2, 1.2);
    const coneLen = total * 0.32;
    const shaftLen = total - coneLen;
    for (const def of defs) {
      const material = new THREE.MeshBasicMaterial({ color: def.base });
      // renderer.clippingPlanes 是全局裁剪，会把框外（箭头所在处）逐像素裁掉；
      // 这里从片元着色器中移除裁剪逻辑，让箭头始终完整可见
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <clipping_planes_fragment>',
          '',
        );
      };
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, shaftLen, 12), material);
      shaft.position.y = shaftLen / 2;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(radius * 2.4, coneLen, 20), material);
      cone.position.y = shaftLen + coneLen / 2;
      const arrow = new THREE.Group();
      arrow.add(shaft, cone);
      arrow.rotation.set(...def.rot);
      arrow.userData = {
        axis: def.axis,
        material,
        baseColor: def.base,
        highlightColor: def.highlight,
      };
      this.arrowRoot.add(arrow);
      this.arrows.push(arrow);
    }
    this.layoutArrows();
  }

  /** 按当前尺寸更新箭头位置（对应面中心）；箭头大小不变 */
  private layoutArrows(): void {
    for (const arrow of this.arrows) {
      const axis = arrow.userData.axis as 'x' | 'y' | 'z';
      const s = this.size[axis];
      // 垂直于轴的少量偏移，避免与 TransformControls 的同轴手柄重叠：
      // X 轴箭头沿 Y 偏移，Y 轴箭头沿 X 偏移，Z 轴箭头沿 X 偏移
      const offset = THREE.MathUtils.clamp(
        Math.max(this.size.x, this.size.y, this.size.z) * 0.12,
        0.05,
        0.6,
      );
      const offsetY = axis === 'x' ? offset : 0;
      const offsetX = axis === 'y' || axis === 'z' ? offset : 0;
      arrow.position.set(
        axis === 'x' ? s / 2 : offsetX,
        axis === 'y' ? s / 2 : offsetY,
        axis === 'z' ? s / 2 : 0,
      );
    }
  }

  /** 尺寸变化后重建框线，并同步拾取盒与箭头 */
  private refreshGeometry(): void {
    const box = new THREE.BoxGeometry(
      this.size.x - this.epsilon * 2,
      this.size.y - this.epsilon * 2,
      this.size.z - this.epsilon * 2,
    );
    this.lines.geometry.dispose();
    this.lines.geometry = new THREE.EdgesGeometry(box);
    box.dispose();
    this.hitBox.scale.copy(this.size);
    this.layoutArrows();
  }

  private updatePointerFromEvent(event: PointerEvent): void {
    const rect = this.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /** 射线检测尺寸箭头，命中则返回对应箭头组 */
  private pickArrow(): THREE.Group | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.arrows, true);
    if (hits.length === 0) return null;
    let obj: THREE.Object3D | null = hits[0].object;
    while (obj && obj.userData.axis === undefined) obj = obj.parent;
    return (obj as THREE.Group) ?? null;
  }

  /** 设置悬停箭头的高亮与光标反馈 */
  private setHoveredArrow(arrow: THREE.Group | null): void {
    if (arrow === this.hoveredArrow) return;
    if (this.hoveredArrow) {
      const d = this.hoveredArrow.userData;
      (d.material as THREE.MeshBasicMaterial).color.setHex(d.baseColor as number);
    }
    this.hoveredArrow = arrow;
    if (arrow) {
      const d = arrow.userData;
      (d.material as THREE.MeshBasicMaterial).color.setHex(d.highlightColor as number);
    }
    this.domElement.style.cursor = arrow ? 'grab' : '';
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.arrowDrag) return;
    // TransformControls 的 gizmo 手柄优先（此时悬停在 gizmo 上）
    if (this.transformControls.axis !== null || this.transformControls.dragging) return;
    this.updatePointerFromEvent(event);
    const arrow = this.pickArrow();
    if (!arrow) return;
    const axis = arrow.userData.axis as 'x' | 'y' | 'z';
    const axisVec = SectionBox.AXIS_VECTORS[axis];
    // 拖拽平面：过箭头根部（对应面中心），法线取视线在垂直于轴的平面上的投影，
    // 使指针位移尽量完整地映射到轴向
    const normal = new THREE.Vector3();
    this.camera.getWorldDirection(normal);
    normal.addScaledVector(axisVec, -normal.dot(axisVec));
    if (normal.lengthSq() < 1e-8) {
      // 视线与轴几乎平行时的退化兜底
      normal.crossVectors(
        axisVec,
        Math.abs(axisVec.x) > 0.5 ? SectionBox.AXIS_VECTORS.y : SectionBox.AXIS_VECTORS.x,
      );
    }
    normal.normalize();
    const faceCenter = this.object3d.position
      .clone()
      .addScaledVector(axisVec, this.size[axis] / 2);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, faceCenter);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const startPoint = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, startPoint)) return;
    this.arrowDrag = {
      axis,
      plane,
      startPoint,
      startSize: this.size[axis],
      startCenter: this.object3d.position[axis],
    };
    // 捕获指针，保证指针移出画布时仍能继续接收移动 / 抬起事件
    this.domElement.setPointerCapture(event.pointerId);
    this.domElement.style.cursor = 'grabbing';
    // 通知外部暂停 OrbitControls
    this.onDraggingChange?.(true);
    event.preventDefault();
  };

  /** 箭头拖拽中：把指针在拖拽平面上的轴向位移换算成该轴宽度变化 */
  private updateArrowDrag(): void {
    const drag = this.arrowDrag;
    if (!drag) return;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(drag.plane, p)) return;
    const delta = p[drag.axis] - drag.startPoint[drag.axis];
    const newSize = Math.max(drag.startSize + delta, this.minSize);
    this.size[drag.axis] = newSize;
    // 仅移动被拖拽的正方向面（负方向面不动），中心随之平移半量
    this.object3d.position[drag.axis] = drag.startCenter + (newSize - drag.startSize) / 2;
    this.refreshGeometry();
    this.updatePlanes();
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.arrowDrag) return;
    this.arrowDrag = null;
    this.domElement.style.cursor = '';
    if (this.domElement.hasPointerCapture(event.pointerId)) {
      this.domElement.releasePointerCapture(event.pointerId);
    }
    this.onDraggingChange?.(false);
    this.evaluateHover();
  };

  private onPointerLeave = (): void => {
    // 拖拽过程中指针偶尔会离开画布，此时保持 gizmo 可见，等拖拽结束再隐藏
    if (!this.transformControls.dragging) {
      this.setGizmoVisible(false);
    }
  };

  private setGizmoVisible(visible: boolean): void {
    if (visible === this.gizmoVisible) return;
    this.gizmoVisible = visible;
    this.gizmoHelper.visible = visible;
    this.transformControls.enabled = visible;
  }
}
