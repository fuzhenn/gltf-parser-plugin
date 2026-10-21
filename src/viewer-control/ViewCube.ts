import * as THREE from 'three';

export interface ViewCubeOptions {
  /** ViewCube 显示区域的边长（像素），默认 120 */
  size?: number;
  /** 距容器右上角的边距（像素），默认 10 */
  margin?: number;
  /** 点击某个面时回调：direction 为相机应处于目标点的世界方向，label 为面的中文标识 */
  onFaceClick?: (direction: THREE.Vector3, label: string) => void;
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
  private disposed = false;

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

    // 立方体与六个面的标签：右/左/上/下/前/后
    // 注意：顺序必须与 BoxGeometry 的材质索引顺序一致：
    // 0:+X, 1:-X, 2:+Y, 3:-Y, 4:+Z, 5:-Z
    const faceDefs: Array<{ normal: THREE.Vector3; label: string }> = [
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

    this.camera = new THREE.OrthographicCamera(-1.15, 1.15, 1.15, -1.15, 0.1, 10);
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
      cursor: 'default',
      touchAction: 'none',
    } as CSSStyleDeclaration);
    this.overlay.addEventListener('pointermove', this.onPointerMove);
    this.overlay.addEventListener('pointerleave', this.onPointerLeave);
    this.overlay.addEventListener('pointerdown', this.onPointerDown);
    this.overlay.addEventListener('pointerup', this.onPointerUp);
    overlayHost.appendChild(this.overlay);
  }

  /** 每帧调用：让 ViewCube 的姿态与主相机保持同步（反向旋转） */
  public update(camera: THREE.Camera): void {
    if (this.disposed) return;
    this.cube.quaternion.copy(camera.quaternion).invert();
  }

  /** 在主画布右上角以 scissor 视口叠加渲染 ViewCube（需在主场景渲染完成之后调用） */
  public render(renderer: THREE.WebGLRenderer): void {
    if (this.disposed) return;
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

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.overlay.removeEventListener('pointermove', this.onPointerMove);
    this.overlay.removeEventListener('pointerleave', this.onPointerLeave);
    this.overlay.removeEventListener('pointerdown', this.onPointerDown);
    this.overlay.removeEventListener('pointerup', this.onPointerUp);
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
    ctx.fillStyle = hover ? '#ffffff' : '#3c4043';
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
      this.overlay.style.cursor = 'default';
    }
  }

  private onPointerMove = (e: PointerEvent): void => {
    this.setHover(this.raycastFace(e));
  };

  private onPointerLeave = (): void => {
    this.setHover(null);
    this.downPos = null;
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.downPos) return;
    const dx = e.clientX - this.downPos.x;
    const dy = e.clientY - this.downPos.y;
    this.downPos = null;
    if (dx * dx + dy * dy > 25) return; // 视为拖拽，不触发点击

    const index = this.raycastFace(e);
    if (index === null) return;
    const face = this.faces[index];
    // 立方体姿态是主相机姿态的逆，因此面的本地法线即目标世界方向
    this.options.onFaceClick?.(face.normal.clone(), face.label);
  };

  /** 供 Viewer 后续更新点击回调 */
  public setOptions(options: ViewCubeOptions): void {
    this.options = options;
  }
}
