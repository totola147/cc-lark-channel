import { readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

export interface ProjectInfo {
  name: string;
  description: string;
  path: string;
}

export function getProjectInfo(projectPath: string): ProjectInfo {
  const fallback: ProjectInfo = { name: basename(projectPath), description: "", path: projectPath };

  // package.json
  try {
    const pkgPath = join(projectPath, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      return {
        name: pkg.name || fallback.name,
        description: pkg.description || "",
        path: projectPath,
      };
    }
  } catch {}

  // pyproject.toml
  try {
    const pyPath = join(projectPath, "pyproject.toml");
    if (existsSync(pyPath)) {
      const content = readFileSync(pyPath, "utf-8");
      const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
      const descMatch = content.match(/^\s*description\s*=\s*"([^"]+)"/m);
      return {
        name: nameMatch?.[1] || fallback.name,
        description: descMatch?.[1] || "",
        path: projectPath,
      };
    }
  } catch {}

  // Cargo.toml
  try {
    const cargoPath = join(projectPath, "Cargo.toml");
    if (existsSync(cargoPath)) {
      const content = readFileSync(cargoPath, "utf-8");
      const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
      const descMatch = content.match(/^\s*description\s*=\s*"([^"]+)"/m);
      return {
        name: nameMatch?.[1] || fallback.name,
        description: descMatch?.[1] || "",
        path: projectPath,
      };
    }
  } catch {}

  // README.md first line
  try {
    const readmePath = join(projectPath, "README.md");
    if (existsSync(readmePath)) {
      const content = readFileSync(readmePath, "utf-8");
      const firstLine = content.split("\n").find(l => l.trim() && !l.startsWith("#"))?.trim()
        || content.split("\n")[0]?.replace(/^#+\s*/, "").trim();
      if (firstLine) {
        return { name: fallback.name, description: firstLine.slice(0, 100), path: projectPath };
      }
    }
  } catch {}

  return fallback;
}
