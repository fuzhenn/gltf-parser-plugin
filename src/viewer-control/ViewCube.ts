import * as THREE from 'three';

export interface ViewCubeOptions {
  /** ViewCube 显示区域的边长（像素），默认 120 */
  size?: number;
  /** 距容器右上角的边距（像素），默认 10 */
  margin?: number;
  /**
   * 世界坐标的上方向轴：'y'（默认）或 'z'。
   * 决定各面标签/世界方向的对应关系及立方体的对齐旋转，需与主相机 up 向量一致。
   */
  upAxis?: 'y' | 'z';
  /** 点击某个面时回调：direction 为相机应处于目标点的世界方向，label 为面的中文标识 */
  onFaceClick?: (direction: THREE.Vector3, label: string) => void;
  /**
   * 拖拽旋转回调：在 ViewCube 上按下并拖动超过阈值后触发。
   * rotY 为水平拖拽对应的旋转弧度（绕视口竖直轴，右拖为正），
   * rotX 为垂直拖拽对应的旋转弧度（绕视口水平轴，下拖为正）。
   */
  onDragRotate?: (rotY: number, rotX: number) => void;
}

interface FaceDef {
  /** 面的本地法线（与世界坐标轴一一对应） */
  normal: THREE.Vector3;
  label: string;
  material: THREE.MeshBasicMaterial;
  texNormal: THREE.CanvasTexture;
  texHover: THREE.CanvasTexture;
}

/**
 * ViewCube - 独立的视角立方体组件，供 Viewer 调用。
 *
 * - 用 Three.js 生成一个六面立方体，六个面分别用中文标注：上、下、前、后、左、右。
 * - 立方体姿态跟随主相机同步旋转（局部坐标系与世界坐标系对齐）。
 * - 叠加渲染在主画布右上角的 scissor 视口中（需在主场景渲染完成之后调用 render）。
 * - 点击某个面可触发回调，将主相机重置到对应方向。
 * - 按住拖拽可旋转视角：拖拽增量通过 onDragRotate 回调交由外部旋转主相机，
 *   立方体姿态随主相机同步，表现为立方体与场景一起被拖动旋转。
 */
export class ViewCube {
  public readonly size: number;
  public readonly margin: number;

  private canvas: HTMLCanvasElement;
  private overlay: HTMLDivElement;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private cube: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial[]>;
  private faces: FaceDef[] = [];
  private raycaster = new THREE.Raycaster();
  private hoverIndex: number | null = null;
  private downPos: { x: number; y: number } | null = null;
  private dragging = false;
  private lastDragPos: { x: number; y: number } | null = null;
  /** 拖拽角速度：拖过一个 ViewCube 宽度约旋转 180° */
  private readonly rotateSpeed: number;
  private visible = true;
  private disposed = false;
  /** 世界坐标上方向轴（构造时确定） */
  private upAxis: 'y' | 'z';
  /** Z-UP 时把立方体从 Y-UP 惯例对齐到 Z-UP 的旋转（绕 X 轴 +90°），Y-UP 时为单位旋转 */
  private upAlignQuat = new THREE.Quaternion();

  private options: ViewCubeOptions;

  constructor(
    canvas: HTMLCanvasElement,
    overlayHost: HTMLElement,
    options: ViewCubeOptions = {},
  ) {
    this.canvas = canvas;
    this.options = options;
    this.size = options.size ?? 120;
    this.margin = options.margin ?? 10;
    this.rotateSpeed = Math.PI / this.size;

    // 上方向轴：Z-UP 时用绕 X 轴 +90° 的对齐旋转，使立方体局部 +Y 对齐世界 +Z，
    // 保证各侧面文字在对应正视方向下保持直立（与 Y-UP 时的表现一致）
    this.upAxis = options.upAxis ?? 'y';
    if (this.upAxis === 'z') {
      this.upAlignQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    }

    // 立方体与六个面的标签：右/左/上/下/前/后
    // 注意：顺序必须与 BoxGeometry 的材质索引顺序一致：
    // 0:+X, 1:-X, 2:+Y, 3:-Y, 4:+Z, 5:-Z；
    // normal 为该面对应的世界方向（随 upAxis 变化），点击时作为目标相机方向回调
    const faceDefs: Array<{ normal: THREE.Vector3; label: string }> =
      this.upAxis === 'z'
        ? [
            { normal: new THREE.Vector3(1, 0, 0), label: '右' }, // +X
            { normal: new THREE.Vector3(-1, 0, 0), label: '左' }, // -X
            { normal: new THREE.Vector3(0, 0, 1), label: '上' }, // +Z
            { normal: new THREE.Vector3(0, 0, -1), label: '下' }, // -Z
            { normal: new THREE.Vector3(0, -1, 0), label: '前' }, // -Y（Z-UP 惯例：-Y 朝前）
            { normal: new THREE.Vector3(0, 1, 0), label: '后' }, // +Y
          ]
        : [
            { normal: new THREE.Vector3(1, 0, 0), label: '右' }, // +X
            { normal: new THREE.Vector3(-1, 0, 0), label: '左' }, // -X
            { normal: new THREE.Vector3(0, 1, 0), label: '上' }, // +Y
            { normal: new THREE.Vector3(0, -1, 0), label: '下' }, // -Y
            { normal: new THREE.Vector3(0, 0, 1), label: '前' }, // +Z
            { normal: new THREE.Vector3(0, 0, -1), label: '后' }, // -Z
          ];
    const materials = faceDefs.map((def) => {
      const texNormal = this.createFaceTexture(def.label, false);
      const texHover = this.createFaceTexture(def.label, true);
      const material = new THREE.MeshBasicMaterial({ map: texNormal });
      this.faces.push({ ...def, material, texNormal, texHover });
      return material;
    });

    const geometry = new THREE.BoxGeometry(1.6, 1.6, 1.6);
    this.cube = new THREE.Mesh(geometry, materials);
    this.scene.add(this.cube);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0x333333 }),
    );
    this.cube.add(edges);

    // 立方体半对角线 ≈ 1.386（BoxGeometry 边长 1.6），
    // 视口范围需覆盖完整对角线并留少许边距，否则旋转后顶点会被裁掉
    this.camera = new THREE.OrthographicCamera(-1.45, 1.45, 1.45, -1.45, 0.1, 10);
    this.camera.position.set(0, 0, 4);
    this.camera.lookAt(0, 0, 0);

    // 覆盖在 ViewCube 区域上的透明交互层，避免与 OrbitControls 抢事件
    this.overlay = document.createElement('div');
    Object.assign(this.overlay.style, {
      position: 'absolute',
      top: `${this.margin}px`,
      right: `${this.margin}px`,
      width: `${this.size}px`,
      height: `${this.size}px`,
      zIndex: '15',
      cursor: 'grab',
      touchAction: 'none',
    } as CSSStyleDeclaration);
    this.overlay.addEventListener('pointermove', this.onPointerMove);
    this.overlay.addEventListener('pointerleave', this.onPointerLeave);
    this.overlay.addEventListener('pointerdown', this.onPointerDown);
    this.overlay.addEventListener('pointerup', this.onPointerUp);
    this.overlay.addEventListener('pointercancel', this.onPointerCancel);
    overlayHost.appendChild(this.overlay);
  }

  /** 每帧调用：让 ViewCube 的姿态与主相机保持同步（反向旋转） */
  public update(camera: THREE.Camera): void {
    if (this.disposed || !this.visible) return;
    // 立方体姿态 = 相机姿态的逆；Z-UP 时再左乘对齐旋转（绕 X 轴 +90°），
    // 使立方体局部 +Y 对齐世界 +Z
    this.cube.quaternion.copy(camera.quaternion).invert();
    if (this.upAxis === 'z') this.cube.quaternion.multiply(this.upAlignQuat);
  }

  /** 在主画布右上角以 scissor 视口叠加渲染 ViewCube（需在主场景渲染完成之后调用） */
  public render(renderer: THREE.WebGLRenderer): void {
    if (this.disposed || !this.visible) return;
    const w = renderer.domElement.clientWidth;
    const h = renderer.domElement.clientHeight;
    const x = w - this.size - this.margin;
    const y = h - this.size - this.margin; // viewport 的 y 从底部算起

    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, this.size, this.size);
    renderer.setViewport(x, y, this.size, this.size);
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.autoClear = true;
  }

  /** 设置 ViewCube 的显示/隐藏（隐藏时同步隐藏交互层，不再响应事件与渲染） */
  public setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    this.overlay.style.display = visible ? '' : 'none';
    if (!visible) {
      this.setHover(null);
      this.downPos = null;
      this.dragging = false;
      this.lastDragPos = null;
    }
  }

  /** 当前是否可见 */
  public isVisible(): boolean {
    return this.visible;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.overlay.removeEventListener('pointermove', this.onPointerMove);
    this.overlay.removeEventListener('pointerleave', this.onPointerLeave);
    this.overlay.removeEventListener('pointerdown', this.onPointerDown);
    this.overlay.removeEventListener('pointerup', this.onPointerUp);
    this.overlay.removeEventListener('pointercancel', this.onPointerCancel);
    this.overlay.remove();
    for (const face of this.faces) {
      face.texNormal.dispose();
      face.texHover.dispose();
      face.material.dispose();
    }
    this.cube.geometry.dispose();
    this.scene.clear();
  }

  private createFaceTexture(label: string, hover: boolean): THREE.CanvasTexture {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = hover ? '#2f7bd9' : '#f5f6f7';
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = hover ? '#ffffff' : '#9aa0a6';
    ctx.lineWidth = 6;
    ctx.strokeRect(4, 4, 120, 120);
    ctx.fillStyle = hover ? '#ffffff' : '#9aa0a6';
    ctx.font = 'bold 64px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 64, 68);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** 将 overlay 上的鼠标事件坐标换算为 ViewCube 视口内的 NDC 坐标 */
  private toNdc(e: PointerEvent): THREE.Vector2 | null {
    const rect = this.canvas.getBoundingClientRect();
    const cubeLeft = rect.width - this.size - this.margin;
    const cubeTop = this.margin;
    const x = e.clientX - rect.left - cubeLeft;
    const y = e.clientY - rect.top - cubeTop;
    if (x < 0 || y < 0 || x > this.size || y > this.size) return null;
    return new THREE.Vector2((x / this.size) * 2 - 1, -(y / this.size) * 2 + 1);
  }

  private raycastFace(e: PointerEvent): number | null {
    const ndc = this.toNdc(e);
    if (!ndc) return null;
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.cube, false);
    const hit = hits[0];
    if (!hit || !hit.face) return null;
    return hit.face.materialIndex;
  }

  private setHover(index: number | null): void {
    if (this.hoverIndex === index) return;
    if (this.hoverIndex !== null) {
      const f = this.faces[this.hoverIndex];
      f.material.map = f.texNormal;
      f.material.needsUpdate = true;
    }
    this.hoverIndex = index;
    if (index !== null) {
      const f = this.faces[index];
      f.material.map = f.texHover;
      f.material.needsUpdate = true;
      this.overlay.style.cursor = 'pointer';
    } else {
      this.overlay.style.cursor = 'grab';
    }
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (this.downPos) {
      // 按下状态：超过阈值后进入拖拽旋转
      if (!this.dragging) {
        const dx = e.clientX - this.downPos.x;
        const dy = e.clientY - this.downPos.y;
        if (dx * dx + dy * dy > 25) {
          this.dragging = true;
          this.lastDragPos = { x: e.clientX, y: e.clientY };
          this.setHover(null);
          this.overlay.style.cursor = 'grabbing';
        }
      } else {
        const last = this.lastDragPos;
        if (!last) return;
        const ldx = e.clientX - last.x;
        const ldy = e.clientY - last.y;
        this.lastDragPos = { x: e.clientX, y: e.clientY };
        const rotY = ldx * this.rotateSpeed;
        const rotX = ldy * this.rotateSpeed;
        if (rotY !== 0 || rotX !== 0) this.options.onDragRotate?.(rotY, rotX);
      }
      return;
    }
    this.setHover(this.raycastFace(e));
  };

  private onPointerLeave = (): void => {
    if (this.dragging) return;
    this.setHover(null);
    this.downPos = null;
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    // 捕获指针，拖出 ViewCube 区域时仍能继续接收 move/up 事件
    this.overlay.setPointerCapture(e.pointerId);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    if (this.overlay.hasPointerCapture(e.pointerId)) {
      this.overlay.releasePointerCapture(e.pointerId);
    }
    const wasDragging = this.dragging;
    this.dragging = false;
    this.lastDragPos = null;
    const start = this.downPos;
    this.downPos = null;
    this.overlay.style.cursor = 'grab';
    if (wasDragging || !start) return; // 拖拽结束不触发点击

    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (dx * dx + dy * dy > 25) return;

    const index = this.raycastFace(e);
    if (index === null) return;
    const face = this.faces[index];
    // 立方体姿态是主相机姿态的逆，因此面的本地法线即目标世界方向
    this.options.onFaceClick?.(face.normal.clone(), face.label);
  };

  private onPointerCancel = (): void => {
    this.dragging = false;
    this.lastDragPos = null;
    this.downPos = null;
    this.overlay.style.cursor = 'grab';
  };

  /** 供 Viewer 后续更新点击回调 */
  public setOptions(options: ViewCubeOptions): void {
    this.options = options;
  }
}
