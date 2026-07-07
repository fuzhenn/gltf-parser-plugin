import {
  Group,
  InstancedMesh,
  LoadingManager,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Scene,
  Texture,
  Vector3,
  Loader,
} from "three";
import {
  acquireWorker,
  buildTextures,
  buildMaterials,
  buildMeshPrimitives,
  type PrimitiveData,
  getWorkers,
} from "./utils";
import type { GLTFNodeData, GLTFWorkerData, MaterialBuilder } from "./types";
import { StructuralMetadata, MeshFeatures } from "3d-tiles-renderer/plugins";
import {
  buildStructuralMetadataFromInstanceData,
  buildInstanceOidMap,
} from "./mesh";

// Extension names
const EXT_STRUCTURAL_METADATA = "EXT_structural_metadata";
const EXT_MESH_FEATURES = "EXT_mesh_features";

/**
 * GLTFWorkerLoader configuration options
 */
export interface GLTFWorkerLoaderOptions {
  /** Whether to enable metadata support (EXT_mesh_features, EXT_structural_metadata) */
  metadata?: boolean;
  /** Custom material builder function */
  materialBuilder?: MaterialBuilder;
}

let uuid = 0;

/**
 * Custom Loader using Worker for GLTF parsing
 */
export class GLTFWorkerLoader extends Loader {
  private _metadata: boolean = true;
  private _materialBuilder?: MaterialBuilder;
  private _loaderId = uuid++;
  private _callbacks = new Map<
    number,
    { resolve: (data: any) => void; reject: (err: Error) => void }
  >();
  private _nextRequestId = 1;

  constructor(manager?: LoadingManager, options?: GLTFWorkerLoaderOptions) {
    super(manager);
    this._metadata = options?.metadata ?? true;
    this._materialBuilder = options?.materialBuilder;

    this.addListeners();
  }

  addListeners() {
    const workers = getWorkers();
    workers.forEach((worker) => {
      worker.addEventListener("message", this._onMessage);
    });
  }

  removeListeners() {
    const workers = getWorkers();
    workers.forEach((worker) => {
      worker.removeEventListener("message", this._onMessage);
    });
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
          fetchOptions: {
            referrer: window.location.href,
            referrerPolicy: "origin",
          },
        },
        [buffer],
      );
    });
  }

  private _onMessage = (event: MessageEvent) => {
    const { type, data, error, loaderId, requestId } = event.data;

    // loaderId here is our requestId
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

    // Build textures
    const { textureMap, textureArray } = buildTextures(data);

    // Build materials
    const materialMap = buildMaterials(data, textureMap, this._materialBuilder);

    // Create default material
    const defaultMaterial = new MeshStandardMaterial({ color: 0xcccccc });

    // Build mesh primitives
    const meshMap = buildMeshPrimitives(data, materialMap, defaultMaterial);

    // Parse node
    const parseNodeData = (nodeData: GLTFNodeData): Group => {
      const node = new Group();

      const primitiveDataList = meshMap.get(nodeData.mesh);
      if (primitiveDataList) {
        if (nodeData.instanceData) {
          // EXT_mesh_gpu_instancing: create InstancedMesh per primitive
          const { count, TRANSLATION, ROTATION, SCALE } = nodeData.instanceData;
          const instanceStructuralMetadata =
            buildStructuralMetadataFromInstanceData(nodeData.instanceData);
          const instanceOidMap = instanceStructuralMetadata
            ? buildInstanceOidMap(instanceStructuralMetadata, count)
            : null;

          for (const {
            geometry,
            material,
            primitiveIndex,
          } of primitiveDataList) {
            const instancedMesh = new InstancedMesh(geometry, material, count);

            const tmpMatrix = new Matrix4();
            const tmpPos = new Vector3();
            const tmpQuat = new Quaternion();
            const tmpScale = new Vector3(1, 1, 1);

            for (let i = 0; i < count; i++) {
              if (TRANSLATION) {
                tmpPos.set(
                  TRANSLATION[i * 3],
                  TRANSLATION[i * 3 + 1],
                  TRANSLATION[i * 3 + 2],
                );
              } else {
                tmpPos.set(0, 0, 0);
              }

              if (ROTATION) {
                tmpQuat.set(
                  ROTATION[i * 4],
                  ROTATION[i * 4 + 1],
                  ROTATION[i * 4 + 2],
                  ROTATION[i * 4 + 3],
                );
              } else {
                tmpQuat.identity();
              }

              if (SCALE) {
                tmpScale.set(SCALE[i * 3], SCALE[i * 3 + 1], SCALE[i * 3 + 2]);
              } else {
                tmpScale.set(1, 1, 1);
              }

              tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
              instancedMesh.setMatrixAt(i, tmpMatrix);
            }

            instancedMesh.instanceMatrix.needsUpdate = true;
            instancedMesh.userData._gltfMeshIndex = nodeData.mesh;
            instancedMesh.userData._gltfPrimitiveIndex = primitiveIndex;
            if (instanceStructuralMetadata) {
              instancedMesh.userData.structuralMetadata =
                instanceStructuralMetadata;
            }
            if (instanceOidMap) {
              instancedMesh.userData._tile_oidMap = instanceOidMap;
            }
            node.add(instancedMesh);
          }
        } else {
          for (const {
            geometry,
            material,
            primitiveIndex,
          } of primitiveDataList) {
            const mesh = new Mesh(geometry, material);
            mesh.userData._gltfMeshIndex = nodeData.mesh;
            mesh.userData._gltfPrimitiveIndex = primitiveIndex;
            node.add(mesh);
          }
        }
      }

      // Set node name
      if (nodeData.name) {
        node.name = nodeData.name;
      }

      // Apply transformation
      if (nodeData.matrix) {
        const m = new Matrix4();
        m.fromArray(nodeData.matrix);
        node.applyMatrix4(m);
      } else {
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
          node.scale.set(
            nodeData.scale[0],
            nodeData.scale[1],
            nodeData.scale[2],
          );
        }
      }

      // Recursively process child nodes
      if (nodeData.children && Array.isArray(nodeData.children)) {
        for (const child of nodeData.children) {
          const childNode = parseNodeData(child);
          node.add(childNode);
        }
      }

      return node;
    };

    // Add scene nodes
    const sceneData = data.scenes[0];
    for (const nodeData of sceneData.nodes) {
      const node = parseNodeData(nodeData);
      scene.add(node);
    }

    // Process metadata (if enabled)
    if (this._metadata) {
      this.processMetadata(scene, data, textureArray, meshMap);
    }

    return scene;
  }

  /**
   * Process and attach metadata to scene and mesh objects
   */
  private processMetadata(
    scene: Scene,
    data: GLTFWorkerData,
    textures: (Texture | null)[],
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

    // Process EXT_structural_metadata
    let rootMetadata: any = null;
    if (hasStructuralMetadata && data.structuralMetadata) {
      const rootExtension = data.json?.extensions?.[EXT_STRUCTURAL_METADATA];
      if (rootExtension) {
        const definition = {
          schema: data.structuralMetadata.schema,
          propertyTables: data.structuralMetadata.propertyTables || [],
          propertyTextures: rootExtension.propertyTextures || [],
          propertyAttributes: rootExtension.propertyAttributes || [],
        };

        const buffers = data.structuralMetadata.buffers || [];
        rootMetadata = new StructuralMetadata(definition, textures, buffers);
        scene.userData.structuralMetadata = rootMetadata;
      }
    }

    // Traverse all meshes in the scene, process mesh-level metadata
    scene.traverse((child) => {
      if (!(child instanceof Mesh)) return;

      const meshIndex = child.userData._gltfMeshIndex as number | undefined;
      const primitiveIndex = child.userData._gltfPrimitiveIndex as
        | number
        | undefined;
      if (meshIndex === undefined || primitiveIndex === undefined) return;

      const primitiveDataList = meshMap.get(meshIndex);
      if (!primitiveDataList) return;

      const primitiveData = primitiveDataList.find(
        (p) => p.primitiveIndex === primitiveIndex,
      );
      if (!primitiveData) return;

      const extensions = primitiveData.extensions;

      // Process EXT_structural_metadata (primitive level)
      if (hasStructuralMetadata && rootMetadata) {
        const primMetadataExt = extensions?.[EXT_STRUCTURAL_METADATA];
        if (primMetadataExt) {
          const rootExtension =
            data.json?.extensions?.[EXT_STRUCTURAL_METADATA];
          if (rootExtension) {
            const definition = {
              schema: data.structuralMetadata!.schema,
              propertyTables: data.structuralMetadata!.propertyTables || [],
              propertyTextures: rootExtension.propertyTextures || [],
              propertyAttributes: rootExtension.propertyAttributes || [],
            };
            const buffers = data.structuralMetadata!.buffers || [];

            child.userData.structuralMetadata = new StructuralMetadata(
              definition,
              textures,
              buffers,
              primMetadataExt,
              child,
            );
          }
        } else {
          child.userData.structuralMetadata = rootMetadata;
        }
      }

      // Process EXT_mesh_features
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
