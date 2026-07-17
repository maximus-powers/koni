import { register } from "node:module";

const piPackageRoot = process.env.KONI_PI_PACKAGE_ROOT;
if (!piPackageRoot) {
  throw new Error("KONI_PI_PACKAGE_ROOT is required before loading Koni's Pi peer bridge");
}

register(new URL("./pi-peer-loader.js", import.meta.url), {
  parentURL: import.meta.url,
  data: { piPackageRoot },
});
