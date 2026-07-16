import { Socket } from "node:net";
import { PrivateCredentialChannel } from "./credential-channel.js";
import { IpcCredentialStore } from "./credential-store.js";
import { projectRuntimeFailure } from "./errors.js";
import { KoniPiHost } from "./host.js";
import { SecretRedactor } from "./redaction.js";

export function formatFatalError(error: unknown, _redactor = new SecretRedactor()): string {
  const failure = projectRuntimeFailure(error);
  return `Koni Pi host failed (${failure.code}): ${failure.message}\n`;
}

function assertSupportedNode(): void {
  const [majorText = "0", minorText = "0"] = process.versions.node.split(".");
  const major = Number(majorText);
  const minor = Number(minorText);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Koni Pi host requires Node >=22.19.0; found ${process.versions.node}`);
  }
}

export async function runKoniPiHost(redactor = new SecretRedactor()): Promise<void> {
  assertSupportedNode();
  const credentialSocket = new Socket({ fd: 3, readable: true, writable: true });
  const credentialChannel = new PrivateCredentialChannel(credentialSocket, redactor);
  const credentialStore = new IpcCredentialStore(credentialChannel, redactor);
  const host = new KoniPiHost(process.stdin, process.stdout, {
    credentialStore,
    redactor,
    protocol: {
      onFatal: (error) => {
        const failure = projectRuntimeFailure(error);
        process.stderr.write(
          `Koni Pi protocol failure (${failure.code}): ${failure.message}\n`,
        );
      },
    },
  });

  const stop = () => {
    const cleanup = () => {
      credentialSocket.destroy();
      process.stdin.destroy();
    };
    void host.shutdown().then(cleanup, cleanup);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const credentialRun = credentialChannel.run().then(() => {
    throw new Error("private credential channel closed while the Pi host was running");
  });
  try {
    await Promise.race([host.run(), credentialRun]);
  } finally {
    try {
      await host.shutdown();
    } finally {
      credentialChannel.close();
      credentialSocket.destroy();
    }
  }
}
