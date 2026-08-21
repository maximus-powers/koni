/** Build the detached authority environment without forwarding ambient Node injection. */
export function authorityDaemonEnvironment(
  piEnvironment: Readonly<Record<string, string>>,
  providerFreeAdmissionProbe = false,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...piEnvironment,
    KONI_AUTHORITY_DAEMON: "1",
    ...(providerFreeAdmissionProbe
      ? {
          KONI_PROVIDER_FREE_RELEASE_PROBE: "1",
          NODE_ENV: "test",
          PI_OFFLINE: "1",
        }
      : {}),
  };
  // The exact peer bridge is an argv preload. Never forward ambient Node injection into the
  // authority process, even when the interactive launcher itself was started through NODE_OPTIONS.
  for (const name of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "NPM_CONFIG_NODE_OPTIONS",
    "NODE_INSPECT_RESUME_ON_START",
  ]) {
    delete environment[name];
  }
  return environment;
}
