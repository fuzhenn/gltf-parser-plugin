import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { TilesRenderer } from "3d-tiles-renderer";
import type { Object3D } from "three";
import { applyFetchOptionsToLoader, resolveFetchOptions } from "../utils";

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

export async function loadPmiModel(
  url: string,
  loader: GLTFLoader,
  tilesRenderer: TilesRenderer,
  fetchOptions?: RequestInit,
): Promise<PmiModel> {
  const tilesFetchOptions = (tilesRenderer as { fetchOptions?: RequestInit })
    .fetchOptions;
  applyFetchOptionsToLoader(
    loader,
    resolveFetchOptions(tilesFetchOptions, fetchOptions),
  );
  const result = await loader.loadAsync(url);

  let nextNodeId = 0;

  const mapNodeObject3D = new Map<number, Object3D>();
  const assoc = result.parser.associations;
  result.scene.traverse((obj) => {
    const ref = assoc.get(obj);
    if (ref?.nodes !== undefined) {
      // XXX: multi objects -> one node
      mapNodeObject3D.set(ref.nodes, obj);
    }
  });

  function buildPmiNode(
    gltf: GLTF,
    nodeIndex: number,
    isRoot: boolean,
  ): PmiNode {
    const sourceNode = gltf.nodes[nodeIndex];

    const nodeId = nextNodeId++;

    const pmiNode: PmiNode = {
      id: nodeId,
      name: sourceNode.name || (isRoot ? "Root" : undefined),
      mesh: mapNodeObject3D.get(nodeIndex),
      featureIds: sourceNode.extras?.featureIds,
    };

    if (sourceNode.children && sourceNode.children.length > 0) {
      pmiNode.children = [];
      for (const childIndex of sourceNode.children) {
        const childPmiNode = buildPmiNode(gltf, childIndex, false);
        pmiNode.children!.push(childPmiNode);
      }
    }

    return pmiNode;
  }

  const gltf: GLTF = result.parser.json;
  const sceneIdx = gltf.scene || 0;
  const rootIndices = gltf.scenes[sceneIdx].nodes;
  const rootPmiNodes: PmiNode[] = rootIndices.map((nodeIndex) =>
    buildPmiNode(gltf, nodeIndex, true),
  );

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
