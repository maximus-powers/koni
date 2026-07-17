import path from "node:path";
import { pathToFileURL } from "node:url";

const PI_PEERS = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

let piParentURL;

export function initialize({ piPackageRoot }) {
  piParentURL = pathToFileURL(path.join(piPackageRoot, "package.json")).href;
}

export function resolve(specifier, context, nextResolve) {
  if (PI_PEERS.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
    if (piParentURL === undefined) throw new Error("Koni's Pi peer loader was not initialized");
    return nextResolve(specifier, { ...context, parentURL: piParentURL });
  }
  return nextResolve(specifier, context);
}
