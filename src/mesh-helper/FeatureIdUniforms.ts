import type { GLTFParserPlugin } from "../GLTFParserPlugin";
import { Mesh } from "three";

export class FeatureIdUniforms {
  mesh: Mesh;
  plugin: GLTFParserPlugin;

  constructor(mesh: Mesh, plugin: GLTFParserPlugin) {
    this.mesh = mesh;
    this.plugin = plugin;
  }

  get value() {
    const idMap = this.mesh.userData.idMap;

    if (!idMap) {
      return new Array(this.plugin.getFeatureIdCount()).fill(-1);
    }

    const result = new Array(this.plugin.getFeatureIdCount()).fill(-1);
    for (let i = 0; i < this.plugin.oids.length; i++) {
      const oid = this.plugin.oids[i];
      const featureId = idMap[oid];
      result[i] = featureId !== undefined ? featureId : -1;
    }

    return result;
  }
}
