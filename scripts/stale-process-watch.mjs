import fs from "node:fs";
import path from "node:path";

export function readConfiguredDataDir(projectRoot, env = process.env) {
  const configured = env.CABINET_DATA_DIR?.trim();
  if (configured) return path.resolve(projectRoot, configured);

  try {
    const configPath = path.join(projectRoot, ".cabinet-install.json");
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const persisted = parsed?.dataDir?.trim();
    if (persisted) return path.resolve(projectRoot, persisted);
  } catch {
    // Missing and temporarily-invalid config files both mean "use default".
  }

  return path.join(projectRoot, "data");
}

/**
 * Return a deterministic poll callback. Launchers provide the side effect, so
 * tests can verify transitions without spawning or signalling real processes.
 */
export function createDataDirChangeDetector(initialDataDir, onChange) {
  let current = path.resolve(initialDataDir);
  return (nextDataDir) => {
    const next = path.resolve(nextDataDir);
    if (next === current) return false;
    const previous = current;
    current = next;
    onChange(next, previous);
    return true;
  };
}
