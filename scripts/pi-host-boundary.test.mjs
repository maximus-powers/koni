import assert from "node:assert/strict";
import test from "node:test";

import {
  EXACT_PI_VERSION,
  EXACT_TYPEBOX_VERSION,
  verifyPiHostBoundary,
  verifyRepositoryPiHostBoundary,
} from "./check-pi-host-boundary.mjs";

function fixture() {
  const codingPath = "node_modules/@earendil-works/pi-coding-agent";
  const manifests = [
    {
      name: "koni",
      devDependencies: {
        "@earendil-works/pi-coding-agent": EXACT_PI_VERSION,
        typebox: EXACT_TYPEBOX_VERSION,
      },
    },
    {
      name: "@koni/core",
      version: "1.0.0",
      peerDependencies: {
        "@earendil-works/pi-agent-core": "*",
        "@earendil-works/pi-ai": "*",
        "@earendil-works/pi-coding-agent": "*",
        "@earendil-works/pi-tui": "*",
        typebox: "*",
      },
      peerDependenciesMeta: Object.fromEntries(
        [
          "@earendil-works/pi-agent-core",
          "@earendil-works/pi-ai",
          "@earendil-works/pi-coding-agent",
          "@earendil-works/pi-tui",
          "typebox",
        ].map((name) => [name, { optional: true }]),
      ),
    },
    { name: "@koni/coding-profile" },
    { name: "@koni/research-profile" },
  ];
  const dependencies = {
    "@earendil-works/pi-agent-core": "^0.80.10",
    "@earendil-works/pi-ai": "^0.80.10",
    "@earendil-works/pi-tui": "^0.80.10",
    typebox: EXACT_TYPEBOX_VERSION,
  };
  const packages = {
    [codingPath]: { version: EXACT_PI_VERSION, dependencies },
  };
  for (const name of Object.keys(dependencies)) {
    packages[`${codingPath}/node_modules/${name}`] = {
      version: name === "typebox" ? EXACT_TYPEBOX_VERSION : EXACT_PI_VERSION,
    };
  }
  return { lock: { lockfileVersion: 3, packages }, manifests };
}

test("the workflow validator resolves Pi's actual nested lock closure", () => {
  const boundary = verifyPiHostBoundary(fixture());
  assert.equal(boundary.pi, EXACT_PI_VERSION);
  assert.equal(
    boundary.tested_lock_closure["@earendil-works/pi-agent-core"].lock_path,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core",
  );
  assert.equal(
    boundary.tested_lock_closure.typebox.lock_path,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/typebox",
  );
});

test("the workflow validator fails closed on a drifted nested Pi package", () => {
  const value = fixture();
  value.lock.packages[
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai"
  ].version = "0.80.11";
  assert.throws(() => verifyPiHostBoundary(value), /pi-ai lock is 0\.80\.11/u);
});

test("the checked-in npm compatibility fixture satisfies the provider-free release boundary", async () => {
  const boundary = await verifyRepositoryPiHostBoundary();
  assert.equal(boundary.pi, EXACT_PI_VERSION);
  assert.equal(boundary.typebox, EXACT_TYPEBOX_VERSION);
  assert.equal(
    boundary.tested_lock_closure["@earendil-works/pi-coding-agent"].version,
    EXACT_PI_VERSION,
  );
  assert.equal(boundary.tested_lock_closure.typebox.version, EXACT_TYPEBOX_VERSION);
});
