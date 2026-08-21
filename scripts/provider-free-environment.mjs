export function providerFreeEnvironment(overrides, ambient = process.env) {
  const environment = { ...ambient };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_") || environment[name] === undefined) {
      delete environment[name];
      continue;
    }
    if (/(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|SECRET[_-]?KEY)$/iu.test(name))
      delete environment[name];
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  for (const name of Object.keys(environment)) {
    if (/(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|SECRET[_-]?KEY)$/iu.test(name))
      delete environment[name];
  }
  return environment;
}
