import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readAutoCompactWindow(path: string): number | undefined {
  try {
    const v = (JSON.parse(readFileSync(path, "utf8")) as { autoCompactWindow?: unknown }).autoCompactWindow;
    return typeof v === "number" && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 状态栏 ctx% 的分母。与终端状态栏、/context 对齐：设置了 autoCompactWindow 且小于
 * 模型原生窗口时，以它为准。设置合并顺序是用户级 ~/.claude/settings.json，再被
 * --settings 指定的文件覆盖。
 */
export function effectiveContextWindow(
  nativeWindow: number | undefined,
  settingsPath?: string,
  home: string = homedir(),
): number | undefined {
  const compact =
    (settingsPath ? readAutoCompactWindow(settingsPath) : undefined) ??
    readAutoCompactWindow(join(home, ".claude", "settings.json"));
  if (!compact) return nativeWindow;
  return nativeWindow && nativeWindow > 0 ? Math.min(compact, nativeWindow) : compact;
}
