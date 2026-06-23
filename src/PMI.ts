import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { TilesRenderer } from "3d-tiles-renderer";
import { Object3D } from "three";

export interface FeatureIds {
  direct?: number[];
  indirect?: number[];
}

export interface PmiNode {
  id: number;
  name?: string;
  mesh?: Object3D;
  featureIds?: FeatureIds;
  children?: PmiNode[];
}

export interface PmiModel {
  rootNodes: PmiNode[];
}

const globalNodeIds = new WeakMap<String, number>();

export async function loadPmiModel(url: string, tilesRenderer: TilesRenderer): Promise<PmiModel> {
  const loader = new GLTFLoader(tilesRenderer.manager);
  const result = await loader.loadAsync(url);

  globalNodeIds.set(url, 0);

  const mapNodeObject3D = new Map<number, Object3D>();
  const assoc = result.parser.associations;
  result.scene.traverse((obj) => {
    const ref = assoc.get(obj);
    if (ref?.nodes !== undefined) {
      // XXX: multi objects -> one node
      mapNodeObject3D.set(ref.nodes, obj);
    }
  });

  function buildPmiNode(gltf: GLTF, nodeIndex: number, isRoot: boolean): PmiNode {
    const sourceNode = gltf.nodes[nodeIndex];

    const nodeId = globalNodeIds.get(url)!;
    globalNodeIds.set(url, nodeId + 1);

    const pmiNode: PmiNode = {
      id: nodeId,
      name: sourceNode.name || (isRoot ? "Root" : undefined),
      mesh: mapNodeObject3D.get(nodeIndex),
      featureIds: sourceNode.extras?.featureIds,
      children: [],
    };

    const childIndices = sourceNode.children || [];
    for (const childIndex of childIndices) {
      const childPmiNode = buildPmiNode(gltf, childIndex, false);
      pmiNode.children!.push(childPmiNode);
    }

    return pmiNode;
  }

  const rootPmiNodes: PmiNode[] = [];

  const gltf: GLTF = result.parser.json;
  const sceneIdx = gltf.scene || 0;
  const rootIndices = gltf.scenes[sceneIdx].nodes;
  rootIndices.forEach(nodeIndex => {
    rootPmiNodes.push(buildPmiNode(gltf, nodeIndex, true));
  });

  tilesRenderer.group.add(result.scene);

  return {
    rootNodes: rootPmiNodes,
  };
}

interface GLTFScene {
  name?: string;
  nodes: number[];
}

interface GLTFNodeExtra {
  featureIds?: FeatureIds;
}

interface GLTFNode {
  name?: string;
  children?: number[];
  extras?: GLTFNodeExtra;
}

interface GLTF {
  nodes: GLTFNode[];
  scene?: number;
  scenes: GLTFScene[];
}
