declare module "@maptalks/gltf-loader";
declare module "@maptalks/transcoders.draco";

// Vite inline worker
declare module "*?worker&inline" {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}

declare module "*?worker" {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}
