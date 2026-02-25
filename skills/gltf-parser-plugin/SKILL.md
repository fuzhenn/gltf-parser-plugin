---
name: gltf-parser-plugin
description: High-performance GLTF/GLB loader plugin for 3d-tiles-renderer using Web Workers. Use when integrating 3D Tiles with Three.js, configuring tile loading, enabling metadata extensions, customizing materials, or setting up IndexedDB caching.
---

# GLTF Parser Plugin

基于 Web Worker 的高性能 GLTF/GLB 加载器插件，专为 `3d-tiles-renderer` + `Three.js` 设计。
在 Worker 线程完成 GLTF 解析和 Draco 解压，主线程零阻塞构建 Three.js 场景。

## Quick Start

```typescript
import { TilesRenderer } from "3d-tiles-renderer";
import { GLTFParserPlugin } from "gltf-parser-plugin";

const tiles = new TilesRenderer("https://example.com/tileset.json");

// 注册插件（替换默认的 GLTFLoader）
tiles.registerPlugin(new GLTFParserPlugin());

// 添加到 Three.js 场景
scene.add(tiles.group);

// 渲染循环中更新
function animate() {
  tiles.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
```

## 配置选项

```typescript
new GLTFParserPlugin({
  metadata: true,            // 启用 3D Tiles 元数据扩展（默认 true）
  maxWorkers: 4,             // Worker 池大小（默认 navigator.hardwareConcurrency）
  materialBuilder: myBuilder, // 自定义材质构建函数
  useIndexedDB: false,       // IndexedDB 瓦片缓存（默认 false）
});
```

## 自定义材质

通过 `materialBuilder` 替换默认的 `MeshStandardMaterial` 构建逻辑，
适用于自定义 shader、特殊渲染效果或 GLTF 材质扩展处理。

```typescript
import { Material, Texture, MeshPhysicalMaterial } from "three";

const materialBuilder = (
  matData: any,
  textureMap: Map<number, Texture>,
): Material => {
  const pbr = matData.pbrMetallicRoughness || {};

  const material = new MeshPhysicalMaterial({
    color: pbr.baseColorFactor
      ? new THREE.Color().fromArray(pbr.baseColorFactor)
      : 0xffffff,
    metalness: pbr.metallicFactor ?? 1.0,
    roughness: pbr.roughnessFactor ?? 1.0,
    clearcoat: 1.0,
  });

  // 应用贴图
  if (pbr.baseColorTexture) {
    material.map = textureMap.get(pbr.baseColorTexture.index) ?? null;
  }
  if (matData.normalTexture) {
    material.normalMap = textureMap.get(matData.normalTexture.index) ?? null;
  }

  material.side = matData.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  return material;
};

tiles.registerPlugin(new GLTFParserPlugin({ materialBuilder }));
```

## IndexedDB 瓦片缓存

启用后，已加载的 GLB 瓦片数据会缓存到 IndexedDB，再次访问时跳过网络请求。
仅缓存二进制文件（`.glb`），JSON 文件始终走网络。

```typescript
const plugin = new GLTFParserPlugin({ useIndexedDB: true });
tiles.registerPlugin(plugin);

// 手动清除缓存
await plugin.clearCache();
```

## 3D Tiles 元数据

插件默认启用对 3D Tiles 元数据扩展的支持，解析后的元数据附加到 Three.js 对象的 `userData` 上。

### 支持的扩展

| 扩展 | 说明 | 存储位置 |
|---|---|---|
| `EXT_structural_metadata` | 结构化属性表、属性纹理 | `scene.userData.structuralMetadata` / `mesh.userData.structuralMetadata` |
| `EXT_mesh_features` | 要素 ID（属性/纹理） | `mesh.userData.meshFeatures` |
| `EXT_mesh_gpu_instancing` | GPU 实例化渲染 | 自动构建为 `THREE.InstancedMesh` |

### 读取元数据

```typescript
import { StructuralMetadata } from "3d-tiles-renderer/src/three/plugins/gltf/metadata/classes/StructuralMetadata.js";
import { MeshFeatures } from "3d-tiles-renderer/src/three/plugins/gltf/metadata/classes/MeshFeatures.js";

// 场景级结构化元数据
tiles.group.traverse((child) => {
  if (child.isScene) {
    const metadata: StructuralMetadata = child.userData.structuralMetadata;
    if (metadata) {
      // 访问属性表
      const table = metadata.getPropertyTable(0);
      const value = table.getPropertyValue(featureId, "propertyName");
    }
  }
});

// Mesh 级要素数据
tiles.group.traverse((child) => {
  if (child.isMesh) {
    const features: MeshFeatures = child.userData.meshFeatures;
    if (features) {
      // 获取要素 ID
      const featureId = features.getFeatureId(faceIndex);
    }

    // Mesh 级结构化元数据
    const meshMetadata: StructuralMetadata = child.userData.structuralMetadata;
  }
});
```

### 基于要素的拾取与高亮

```typescript
const raycaster = new THREE.Raycaster();

function onMouseClick(event: MouseEvent) {
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(tiles.group, true);

  if (intersects.length > 0) {
    const hit = intersects[0];
    const mesh = hit.object as THREE.Mesh;

    // 获取 MeshFeatures
    const features: MeshFeatures = mesh.userData.meshFeatures;
    if (features) {
      const featureId = features.getFeatureId(hit.faceIndex!);
      console.log("Feature ID:", featureId);

      // 通过 StructuralMetadata 查询属性
      const metadata: StructuralMetadata = mesh.userData.structuralMetadata;
      if (metadata) {
        const table = metadata.getPropertyTable(0);
        const name = table.getPropertyValue(featureId, "name");
        const height = table.getPropertyValue(featureId, "height");
        console.log(`${name}: ${height}m`);
      }
    }
  }
}
```

## GPU 实例化

包含 `EXT_mesh_gpu_instancing` 扩展的节点会自动构建为 `THREE.InstancedMesh`，无需额外配置。

```typescript
// 遍历场景中的 InstancedMesh
tiles.group.traverse((child) => {
  if (child instanceof THREE.InstancedMesh) {
    console.log(`实例数量: ${child.count}`);

    // 读取单个实例的变换矩阵
    const matrix = new THREE.Matrix4();
    child.getMatrixAt(0, matrix);

    // Raycasting 返回 instanceId
    const intersects = raycaster.intersectObject(child);
    if (intersects.length > 0) {
      console.log("Instance ID:", intersects[0].instanceId);
    }
  }
});
```

## 与 3d-tiles-renderer 的集成

### 插件生命周期

插件通过 `tiles.registerPlugin()` 注册，自动接管 GLTF/GLB 文件的加载流程：

```
TilesRenderer 请求瓦片
  → GLTFParserPlugin.fetchData()     // 可选 IndexedDB 缓存
  → GLTFWorkerLoader.parseAsync()    // Worker 解析 + 主线程构建场景
  → 返回与 GLTFLoader 兼容的结果格式  // { scene, scenes, animations, ... }
```

### 搭配其他插件

```typescript
import { TilesRenderer } from "3d-tiles-renderer";
import { CesiumIonAuthPlugin } from "3d-tiles-renderer";
import { GLTFParserPlugin } from "gltf-parser-plugin";

const tiles = new TilesRenderer();

// GLTFParserPlugin 与其他 3d-tiles-renderer 插件兼容
tiles.registerPlugin(new CesiumIonAuthPlugin({ assetId: 12345, accessToken: "..." }));
tiles.registerPlugin(new GLTFParserPlugin({ metadata: true }));
```

### 销毁清理

```typescript
// 插件会在 TilesRenderer 销毁时自动清理
tiles.dispose();

// 或手动调用
plugin.dispose();
```

## 与 Three.js 的关系

### 依赖版本

| 包 | 版本要求 | 关系 |
|---|---|---|
| `three` | `^0.183.1` | peerDependency，需项目自行安装 |
| `3d-tiles-renderer` | `^0.4.21` | 运行时依赖 |

### 构建产物映射

插件在 Worker 中解析 GLTF 二进制数据，在主线程构建为标准 Three.js 对象：

| GLTF 概念 | Three.js 对象 |
|---|---|
| Scene / Node | `THREE.Scene` / `THREE.Group` |
| Mesh | `THREE.Mesh` |
| Instanced Mesh | `THREE.InstancedMesh` |
| Material (PBR) | `THREE.MeshStandardMaterial` |
| Texture (pixel data) | `THREE.DataTexture` |
| Geometry (vertices) | `THREE.BufferGeometry` |

### 与 Three.js GLTFLoader 的区别

| 特性 | GLTFLoader | GLTFParserPlugin |
|---|---|---|
| 解析线程 | 主线程 | Web Worker |
| Draco 解压 | 需手动配置 DRACOLoader | 内置 Worker 端 Draco |
| 3D Tiles 元数据 | 不支持 | 原生支持 |
| 瓦片缓存 | 无 | 可选 IndexedDB |
| 适用场景 | 通用 GLTF 加载 | 3D Tiles 大规模瓦片场景 |

## 性能建议

1. **Worker 数量**：默认使用 `navigator.hardwareConcurrency`，移动端建议设为 2-4
2. **IndexedDB 缓存**：对重复访问的瓦片场景开启，减少网络请求
3. **自定义材质**：复杂 shader 应在 `materialBuilder` 中统一构建，避免运行时修改
4. **元数据**：如不需要属性查询，设置 `metadata: false` 可减少解析开销

## See Also

- `3d-tiles-renderer` — 3D Tiles 渲染引擎
- `threejs-fundamentals` — Three.js 场景基础
- `threejs-materials` — Three.js 材质类型
- `threejs-geometry` — Three.js 几何体构建
