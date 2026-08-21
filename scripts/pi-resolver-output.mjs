export const PI_RESOLVED_SKILLS_MARKER = "__KONI_PI_RESOLVED_SKILLS__=";

export function encodePiResolvedSkills(paths) {
  return `${PI_RESOLVED_SKILLS_MARKER}${JSON.stringify(paths)}`;
}

export function parsePiResolvedSkills(output) {
  const first = output.indexOf(PI_RESOLVED_SKILLS_MARKER);
  const last = output.lastIndexOf(PI_RESOLVED_SKILLS_MARKER);
  if (first < 0 || first !== last) {
    throw new Error("Pi resolver output must contain exactly one skills marker");
  }
  const payload = output.slice(first + PI_RESOLVED_SKILLS_MARKER.length).trim();
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new Error("Pi resolver output marker has an invalid JSON payload", { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("Pi resolver output marker payload must be an array of skill paths");
  }
  return parsed;
}
