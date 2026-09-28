import {
  Group,
  InstancedMesh,
  LoadingManager,
  Matrix4,
  Mesh,
  Quaternion,
  Scene,
  Texture,
  Vector3,
  Loader,
} from "three";

import { acquireWorker, getWorkers } from "../utils";
import type {
  FeatureIdIndexData,
  GLTFNodeData,
  GLTFWorkerData,
  InstanceData,
  MaterialBuilder,
} from "../types";
import { StructuralMetadata, MeshFeatures } from "3d-tiles-renderer/plugins";
import {
  buildInstanceOidMap,
  buildInstanceStructuralMetadata,
  buildInstanceFeatures,
} from "../features";
import { buildTextures } from "./build-textures";
import { buildMaterials } from "./build-materials";
import {
  buildMeshPrimitives,
  type PrimitiveData,
} from "./build-mesh-primitives";

// Extension names
const EXT_STRUCTURAL_METADATA = "EXT_structural_metadata";
const EXT_MESH_FEATURES = "EXT_mesh_features";

// 实例矩阵组装的模块级复用对象，避免每 primitive/每实例重复分配
const tmpInstanceMatrix = new Matrix4();
const tmpInstancePos = new Vector3();
const tmpInstanceQuat = new Quaternion();
const tmpInstanceScale = new Vector3(1, 1, 1);

/** 由第 i 个实例的 TRS 分量组装局部矩阵，结果写入 tmpInstanceMatrix */
function composeInstanceMatrix(
  TRANSLATION: Float32Array | undefined,
  ROTATION: Float32Array | undefined,
  SCALE: Float32Array | undefined,
  i: number,
): void {
  if (TRANSLATION) {
    tmpInstancePos.set(
      TRANSLATION[i * 3],
      TRANSLATION[i * 3 + 1],
      TRANSLATION[i * 3 + 2],
    );
  } else {
    tmpInstancePos.set(0, 0, 0);
  }

  if (ROTATION) {
    tmpInstanceQuat.set(
      ROTATION[i * 4],
      ROTATION[i * 4 + 1],
      ROTATION[i * 4 + 2],
      ROTATION[i * 4 + 3],
    );
  } else {
    tmpInstanceQuat.identity();
  }

  if (SCALE) {
    tmpInstanceScale.set(SCALE[i * 3], SCALE[i * 3 + 1], SCALE[i * 3 + 2]);
  } else {
    tmpInstanceScale.set(1, 1, 1);
  }

  tmpInstanceMatrix.compose(tmpInstancePos, tmpInstanceQuat, tmpInstanceScale);
}

/**
 * GLTFWorkerLoader configuration options
 */
export interface GLTFWorkerLoaderOptions {
  /** Whether to enable metadata support (EXT_mesh_features, EXT_structural_metadata) */
  metadata?: boolean;
  /** Custom material builder function */
  materialBuilder: MaterialBuilder;
  /** Network request options passed to Worker parsing */
  fetchOptions?: RequestInit;
}

let nextLoaderId = 0;

/**
 * Custom Loader using Worker for GLTF parsing
 */
export class GLTFWorkerLoader extends Loader {
  private _metadata: boolean = true;
  private _materialBuilder: MaterialBuilder;
  private _fetchOptions: RequestInit = {};
  private _loaderId = nextLoaderId++;
  private _callbacks = new Map<
    number,
    { resolve: (data: any) => void; reject: (err: Error) => void }
  >();
  private _nextRequestId = 1;

  constructor(manager: LoadingManager, options: GLTFWorkerLoaderOptions) {
    super(manager);
    this._metadata = options.metadata ?? true;
    this._materialBuilder = options.materialBuilder;
    this._fetchOptions = options.fetchOptions ?? {};

    this.addListeners();
  }

  addListeners() {
    for (const worker of getWorkers()) {
      worker.addEventListener("message", this._onMessage);
    }
  }

  removeListeners() {
    for (const worker of getWorkers()) {
      worker.removeEventListener("message", this._onMessage);
    }
  }

  /**
   * Asynchronously parse GLTF buffer
   */
  async parseAsync(buffer: ArrayBuffer, path: string): Promise<any> {
    // Acquire available Worker
    const worker = acquireWorker();

    // Parse using worker
    const data = await this.parseWithWorker(worker, buffer, path);

    // Build Three.js scene
    const scene = this.buildSceneFromGLTFData(data);

    // Return format identical to GLTFLoader
    return {
      scene: scene,
      scenes: [scene],
      animations: [],
      cameras: [],
      asset: {
        generator: "GLTFWorkerLoader",
        version: "2.0",
      },
      parser: null as any,
      userData: {},
    };
  }

  /**
   * Parse GLTF data using Worker
   */
  private parseWithWorker(
    worker: Worker,
    buffer: ArrayBuffer,
    workingPath: string,
  ): Promise<GLTFWorkerData> {
    return new Promise((resolve, reject) => {
      const requestId = this._nextRequestId++;
      this._callbacks.set(requestId, { resolve, reject });

      // Send buffer and working path to worker
      worker.postMessage(
        {
          method: "parseTile",
          buffer: buffer,
          root: workingPath,
          loaderId: this._loaderId,
          requestId,
          fetchOptions: this._fetchOptions,
        },
        [buffer],
      );
    });
  }

  private _onMessage = (event: MessageEvent) => {
    const { type, data, error, loaderId, requestId } = event.data;

    // 多 loader 共享 worker 池，只处理回给本 loader 的消息
    if (loaderId !== this._loaderId) return;
    const callback = this._callbacks.get(requestId);
    if (!callback) return;

    this._callbacks.delete(requestId);

    if (type === "success") {
      callback.resolve(data);
    } else if (type === "error") {
      callback.reject(new Error(error));
    }
  };

  /**
   * Convert GLTF data returned by Worker to Three.js Scene
   */
  private buildSceneFromGLTFData(data: GLTFWorkerData): Scene {
    const scene = new Scene();

    // Build textures / materials / mesh primitives
    const { textureMap, textureArray } = buildTextures(data);
    const materialMap = buildMaterials(data, textureMap, this._materialBuilder);
    const defaultMaterial = this._materialBuilder({
      pbrMetallicRoughness: { baseColorFactor: [0.75, 0.75, 0.75, 1] },
    });
    const meshMap = buildMeshPrimitives(data, materialMap, defaultMaterial);

    const parseNodeData = (nodeData: GLTFNodeData): Group => {
      const node = new Group();

      const primitiveDataList = meshMap.get(nodeData.mesh);
      if (primitiveDataList) {
        const meshes = nodeData.instanceData
          ? this.createInstancedMeshes(
              nodeData,
              nodeData.instanceData,
              primitiveDataList,
              data,
              textureArray,
            )
          : this.createMeshes(nodeData, primitiveDataList);
        for (const mesh of meshes) {
          node.add(mesh);
        }
      }

      if (nodeData.name) {
        node.name = nodeData.name;
      }

      this.applyNodeTransform(node, nodeData);

      if (nodeData.children && Array.isArray(nodeData.children)) {
        for (const child of nodeData.children) {
          node.add(parseNodeData(child));
        }
      }

      return node;
    };

    for (const nodeData of data.scenes[0]?.nodes ?? []) {
      scene.add(parseNodeData(nodeData));
    }

    // Process metadata (if enabled)
    if (this._metadata) {
      this.processMetadata(scene, data, textureArray, meshMap);
    }

    return scene;
  }

  /** 普通（非实例化）primitive → Mesh */
  private createMeshes(
    nodeData: GLTFNodeData,
    primitiveDataList: PrimitiveData[],
  ): Mesh[] {
    const meshes: Mesh[] = [];
    for (const {
      geometry,
      material,
      primitiveIndex,
      featureIdIndices,
    } of primitiveDataList) {
      const mesh = new Mesh(geometry, material);
      this.applyPrimitiveTag(mesh, nodeData, primitiveIndex, featureIdIndices);
      meshes.push(mesh);
    }
    return meshes;
  }

  /** EXT_mesh_gpu_instancing：每个 primitive 一个 InstancedMesh */
  private createInstancedMeshes(
    nodeData: GLTFNodeData,
    instanceData: InstanceData,
    primitiveDataList: PrimitiveData[],
    data: GLTFWorkerData,
    textureArray: Texture[],
  ): InstancedMesh[] {
    const { count, TRANSLATION, ROTATION, SCALE } = instanceData;
    const instanceFeatures = buildInstanceFeatures(nodeData);
    const instanceStructuralMetadata = this._metadata
      ? buildInstanceStructuralMetadata(data, textureArray)
      : null;
    const instanceOidMap =
      instanceStructuralMetadata && instanceFeatures
        ? buildInstanceOidMap(nodeData, instanceStructuralMetadata, 0)
        : null;

    const meshes: InstancedMesh[] = [];
    for (const {
      geometry,
      material,
      primitiveIndex,
      featureIdIndices,
    } of primitiveDataList) {
      const instancedMesh = new InstancedMesh(geometry, material, count);

      for (let i = 0; i < count; i++) {
        composeInstanceMatrix(TRANSLATION, ROTATION, SCALE, i);
        instancedMesh.setMatrixAt(i, tmpInstanceMatrix);
      }
      instancedMesh.instanceMatrix.needsUpdate = true;

      this.applyPrimitiveTag(
        instancedMesh,
        nodeData,
        primitiveIndex,
        featureIdIndices,
      );
      if (instanceStructuralMetadata) {
        instancedMesh.userData.structuralMetadata = instanceStructuralMetadata;
      }
      if (instanceFeatures) {
        instancedMesh.userData.instanceFeatures = instanceFeatures;
      }
      if (instanceOidMap) {
        instancedMesh.userData._tile_oidMap = instanceOidMap;
      }
      meshes.push(instancedMesh);
    }
    return meshes;
  }

  /** 标记 mesh 来源（mesh/primitive 定位用），供 metadata 与样式系统寻址 */
  private applyPrimitiveTag(
    mesh: Mesh,
    nodeData: GLTFNodeData,
    primitiveIndex: number,
    featureIdIndices?: Record<string, FeatureIdIndexData>,
  ): void {
    mesh.userData._gltfMeshIndex = nodeData.mesh;
    mesh.userData._gltfPrimitiveIndex = primitiveIndex;
    if (featureIdIndices) {
      mesh.userData._featureIdIndexCaches = featureIdIndices;
    }
  }

  /** 应用节点 TRS：优先 matrix，否则分量为 translation / rotation / scale */
  private applyNodeTransform(node: Group, nodeData: GLTFNodeData): void {
    if (nodeData.matrix) {
      const m = new Matrix4();
      m.fromArray(nodeData.matrix);
      node.applyMatrix4(m);
      return;
    }
    if (nodeData.translation) {
      node.position.set(
        nodeData.translation[0],
        nodeData.translation[1],
        nodeData.translation[2],
      );
    }
    if (nodeData.rotation) {
      node.quaternion.set(
        nodeData.rotation[0],
        nodeData.rotation[1],
        nodeData.rotation[2],
        nodeData.rotation[3],
      );
    }
    if (nodeData.scale) {
      node.scale.set(nodeData.scale[0], nodeData.scale[1], nodeData.scale[2]);
    }
  }

  /**
   * 组装 EXT_structural_metadata 的定义与 buffers；schema 或根扩展缺失时返回 null
   */
  private buildStructuralMetadata(data: GLTFWorkerData) {
    const loaded = data.structuralMetadata;
    const rootExtension = data.json?.extensions?.[EXT_STRUCTURAL_METADATA];
    if (!loaded?.schema || !rootExtension) {
      return null;
    }
    return {
      definition: {
        schema: loaded.schema,
        propertyTables: loaded.propertyTables || [],
        propertyTextures: rootExtension.propertyTextures || [],
        propertyAttributes: rootExtension.propertyAttributes || [],
      },
      buffers: loaded.buffers || [],
    };
  }

  /**
   * Process and attach metadata to scene and mesh objects
   */
  private processMetadata(
    scene: Scene,
    data: GLTFWorkerData,
    textures: Texture[],
    meshMap: Map<number, PrimitiveData[]>,
  ): void {
    const extensionsUsed = data.json?.extensionsUsed || [];
    const hasStructuralMetadata = extensionsUsed.includes(
      EXT_STRUCTURAL_METADATA,
    );
    const hasMeshFeatures = extensionsUsed.includes(EXT_MESH_FEATURES);

    if (!hasStructuralMetadata && !hasMeshFeatures) {
      return;
    }

    // 根级 EXT_structural_metadata
    let rootMetadata: StructuralMetadata | null = null;
    if (hasStructuralMetadata) {
      const meta = this.buildStructuralMetadata(data);
      if (meta) {
        rootMetadata = new StructuralMetadata(
          meta.definition,
          textures,
          meta.buffers,
        );
        scene.userData.structuralMetadata = rootMetadata;
      }
    }

    // primitive 级 metadata：meshFeatures / structuralMetadata
    scene.traverse((child) => {
      if (!(child instanceof Mesh) || child instanceof InstancedMesh) return;

      const { _gltfMeshIndex: meshIndex, _gltfPrimitiveIndex: primitiveIndex } =
        child.userData;
      if (meshIndex === undefined || primitiveIndex === undefined) return;

      // primitiveIndex 即其在 primitiveDataList 中的下标（构建时顺序 push）
      const primitiveData = meshMap.get(meshIndex)?.[primitiveIndex];
      if (!primitiveData) return;

      const extensions = primitiveData.extensions;

      if (hasStructuralMetadata && rootMetadata) {
        const primMetadataExt = extensions?.[EXT_STRUCTURAL_METADATA];
        if (primMetadataExt) {
          const meta = this.buildStructuralMetadata(data);
          if (meta) {
            child.userData.structuralMetadata = new StructuralMetadata(
              meta.definition,
              textures,
              meta.buffers,
              primMetadataExt,
              child,
            );
          }
        } else {
          child.userData.structuralMetadata = rootMetadata;
        }
      }

      if (hasMeshFeatures) {
        const meshFeaturesExt = extensions?.[EXT_MESH_FEATURES];
        if (meshFeaturesExt) {
          child.userData.meshFeatures = new MeshFeatures(
            child.geometry,
            textures,
            meshFeaturesExt,
          );
        }
      }
    });
  }
}
