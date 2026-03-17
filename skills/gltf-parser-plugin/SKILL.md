---
name: gltf-parser-plugin
description: High-performance GLTF/GLB loader plugin for 3d-tiles-renderer with Web Worker parsing, feature-level operations (query, hide, split by OID), and MeshCollector. Use when integrating 3D Tiles with Three.js, configuring tile loading, enabling metadata extensions, customizing materials, setting up IndexedDB caching, querying features from raycaster hits, hiding/showing features by OID, or extracting individual meshes by OID.
---

# GLTF Parser Plugin

基于 Web Worker 的高性能 GLTF/GLB 加载器插件，专为 `3d-tiles-renderer` + `Three.js` 设计。
在 Worker 线程完成 GLTF 解析和 Draco 解压，主线程零阻塞构建 Three.js 场景。
同时集成了要素级操作能力：通过 OID 查询、隐藏、拆分单体化 Mesh。

## Quick Start

```typescript
import { TilesRenderer } from "3d-tiles-renderer";
import { GLTFParserPlugin } from "gltf-parser-plugin";

const tiles = new TilesRenderer("https://example.com/tileset.json");

// 注册插件（替换默认的 GLTFLoader）
// 传入 renderer 以启用要素操作功能（hidePartsByOids、getMeshCollectorByOid 等）
const plugin = new GLTFParserPlugin({ renderer });
tiles.registerPlugin(plugin);

scene.add(tiles.group);

function animate() {
  tiles.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
```

## 配置选项

```typescript
new GLTFParserPlugin({
  renderer,                  // WebGLRenderer 实例，启用要素操作功能时必传
  metadata: true,            // 启用 3D Tiles 元数据扩展（默认 true）
  maxWorkers: 4,             // Worker 池大小（默认 navigator.hardwareConcurrency）
  materialBuilder: myBuilder, // 自定义材质构建函数
  useIndexedDB: false,       // IndexedDB 瓦片缓存（默认 false）
  beforeParseTile: async (buffer, tile, ext, uri, signal) => buffer, // 解析前预处理回调
});
```

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `renderer` | `WebGLRenderer` | — | 启用 hidePartsByOids 等要素操作功能时必须传入 |
| `metadata` | `boolean` | `true` | 启用 EXT_mesh_features / EXT_structural_metadata 解析 |
| `maxWorkers` | `number` | `hardwareConcurrency` | Worker 池大小 |
| `materialBuilder` | `MaterialBuilder` | — | 自定义材质构建函数 |
| `beforeParseTile` | `Function` | — | 解析前 buffer 预处理回调 |
| `useIndexedDB` | `boolean` | `false` | 启用 IndexedDB 瓦片缓存 |

## 要素查询

通过射线拾取获取要素信息（OID、featureId、属性数据）。

```typescript
import { GLTFParserPlugin, FeatureInfo } from "gltf-parser-plugin";

const raycaster = new THREE.Raycaster();

function onMouseClick(event: MouseEvent) {
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(tiles.group, true);

  if (intersects.length > 0) {
    const result: FeatureInfo = plugin.queryFeatureFromIntersection(intersects[0]);

    if (result.isValid) {
      console.log("OID:", result.oid);
      console.log("Feature ID:", result.featureId);
      console.log("属性数据:", result.propertyData);
    }
  }
}
```

### FeatureInfo 结构

```typescript
interface FeatureInfo {
  oid?: number;          // 对象标识符
  featureId?: number;    // 要素 ID
  features?: number[];   // 要素 ID 数组
  propertyData?: object; // 结构化属性数据
  isValid: boolean;      // 查询是否成功
  error?: string;        // 失败时的错误信息
}
```

## 要素隐藏 / 显示

通过 OID 控制要素的可见性，基于 shader 注入实现（fragment discard），不修改几何体。
需要在构造时传入 `renderer` 参数。

```typescript
const plugin = new GLTFParserPlugin({ renderer });
tiles.registerPlugin(plugin);

// 隐藏指定 OID 对应的要素
plugin.hidePartsByOids([1001, 1002, 1003]);

// 恢复部分 OID 的显示
plugin.showPartsByOids([1002]);

// 恢复全部显示
plugin.showAllParts();
```

### 实现原理

- 插件在模型加载时自动构建 OID → FeatureId 映射表（存储在 `mesh.userData.idMap`）
- 通过 `material.onBeforeCompile` 注入自定义 shader 代码
- 顶点着色器传递 `_feature_id_0` 属性到 fragment
- 片段着色器根据 `hiddenFeatureIds` uniform 数组执行 `discard`
- `FEATURE_ID_COUNT` 根据隐藏数量动态调整（2 的幂次，最小 32），受 WebGL `MAX_FRAGMENT_UNIFORM_VECTORS` 限制

## MeshCollector

按 OID 获取独立的单体化 Mesh，随瓦片加载/卸载自动更新。
适用于对特定要素进行独立渲染（高亮、替换材质、包围盒计算等）。

```typescript
import { MeshCollector } from "gltf-parser-plugin";

// 创建收集器，监听 OID 为 1001 的 mesh 变化
const collector = plugin.getMeshCollectorByOid(1001);

// 获取当前 meshes
console.log(collector.meshes);

// 监听 mesh 变化（瓦片加载/卸载时触发）
collector.addEventListener("mesh-change", (event) => {
  const meshes = event.meshes;
  // meshes 是按 OID 从瓦片中拆分出的独立 Mesh 数组
  // 每个 mesh 的 userData 包含 featureId、oid、propertyData 等
  meshes.forEach((mesh) => {
    mesh.material = highlightMaterial; // 替换材质实现高亮
    scene.add(mesh);
  });
});

// 不再需要时销毁
collector.dispose();
```

### MeshCollector 特性

- 基于 Three.js `EventDispatcher`，通过 `addEventListener` / `removeEventListener` 管理事件
- 瓦片加载完成时自动触发 `mesh-change` 事件
- 拆分后的 mesh 共享原始几何体的 attribute buffer（仅重建 index），内存占用低
- 拆分后的 mesh `userData` 包含：`featureId`、`oid`、`originalMesh`、`propertyData`、`isSplit: true`

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

### 自动构建的 userData 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `mesh.userData.meshFeatures` | `MeshFeatures` | 要素 ID 访问接口 |
| `mesh.userData.structuralMetadata` | `StructuralMetadata` | 结构化属性查询接口 |
| `mesh.userData.idMap` | `Record<number, number>` | OID → FeatureId 映射表（插件自动构建） |

## 与 3d-tiles-renderer 的集成

### 插件生命周期

```
TilesRenderer 请求瓦片
  → GLTFParserPlugin.fetchData()           // 可选 IndexedDB 缓存
  → GLTFParserPlugin.parseTile()           // 可选 beforeParseTile 预处理
  → GLTFWorkerLoader.parseAsync()          // Worker 解析 + 主线程构建场景
  → load-model 事件 → 构建 idMap + 注入 shader  // 要素操作准备
  → tiles-load-end 事件 → 通知 MeshCollector 更新  // 收集器同步
```

### 搭配其他插件

```typescript
import { TilesRenderer, CesiumIonAuthPlugin } from "3d-tiles-renderer";
import { GLTFParserPlugin } from "gltf-parser-plugin";

const tiles = new TilesRenderer();
tiles.registerPlugin(new CesiumIonAuthPlugin({ assetId: 12345, accessToken: "..." }));
tiles.registerPlugin(new GLTFParserPlugin({ renderer, metadata: true }));
```

### 销毁清理

```typescript
// 插件会在 TilesRenderer 销毁时自动清理
tiles.dispose();

// 或手动调用（会清理 loader、事件监听、collectors、splitMeshCache）
plugin.dispose();
```

## 公开 API 一览

| 方法 | 说明 |
|---|---|
| `queryFeatureFromIntersection(hit)` | 从射线交点查询要素信息（OID、featureId、属性） |
| `hidePartsByOids(oids)` | 通过 shader discard 隐藏指定 OID 的要素 |
| `showPartsByOids(oids)` | 恢复指定 OID 的要素显示 |
| `showAllParts()` | 恢复全部要素显示 |
| `getMeshCollectorByOid(oid)` | 获取 MeshCollector，监听特定 OID 的 mesh 变化 |
| `getFeatureIdCount()` | 获取当前 shader uniform 数组大小 |
| `clearCache()` | 清除 IndexedDB 缓存 |
| `dispose()` | 销毁插件，释放所有资源 |

## 依赖版本

| 包 | 版本要求 | 关系 |
|---|---|---|
| `three` | `^0.183.1` | peerDependency，需项目自行安装 |
| `3d-tiles-renderer` | `^0.4.21` | 运行时依赖 |

## 源码结构

```
src/
├── GLTFParserPlugin.ts        # 主插件（GLTF 加载 + 要素操作）
├── GLTFWorkerLoader.ts        # Worker 加载器
├── MeshCollector.ts           # OID Mesh 收集器
├── mesh-helper/               # 要素操作工具
│   ├── idmap.ts               #   OID → FeatureId 映射构建
│   ├── intersection.ts        #   射线交点要素查询
│   ├── mesh.ts                #   按 OID 拆分 mesh
│   └── FeatureIdUniforms.ts   #   Shader uniform 管理
├── worker/                    # Worker 端 GLTF 解析
├── db/                        # IndexedDB 缓存
├── utils/                     # 材质/纹理/几何体构建
├── types.ts                   # 类型定义
└── index.ts                   # 入口导出
```

## 性能建议

1. **Worker 数量**：默认使用 `navigator.hardwareConcurrency`，移动端建议设为 2-4
2. **IndexedDB 缓存**：对重复访问的瓦片场景开启，减少网络请求
3. **自定义材质**：复杂 shader 应在 `materialBuilder` 中统一构建，避免运行时修改
4. **元数据**：如不需要属性查询和要素操作，设置 `metadata: false` 可减少解析开销
5. **要素隐藏数量**：受 WebGL `MAX_FRAGMENT_UNIFORM_VECTORS` 限制，数组大小自动按 2 的幂次递增
6. **MeshCollector**：拆分 mesh 共享原始 attribute buffer，但每次瓦片更新会重建 index，频繁创建应注意性能
