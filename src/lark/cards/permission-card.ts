import type { FeishuCardV2, FeishuElement, FeishuColumn } from "./types.js";
import type { PermissionChoice } from "../../types.js";

const INPUT_PREVIEW_MAX = 1500;

interface BuildPendingArgs {
  requestId: string;
  toolName: string;
  input: unknown;
}

export function buildPermissionCard(args: BuildPendingArgs): FeishuCardV2 {
  const preview = formatInputPreview(args.input);
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: `🔐 Permission: ${args.toolName}` },
      template: "yellow",
    },
    body: {
      elements: [
        { tag: "markdown", content: `Tool **${esc(args.toolName)}** wants to execute:` },
        { tag: "markdown", content: "```json\n" + preview + "\n```" },
        {
          tag: "column_set",
          flex_mode: "bisect",
          horizontal_spacing: "8px",
          columns: [
            col(makeBtn("✅ Allow", "allow", args.requestId, "primary")),
            col(makeBtn("❌ Deny", "deny", args.requestId, "danger")),
          ],
        },
        {
          tag: "column_set",
          flex_mode: "bisect",
          horizontal_spacing: "8px",
          columns: [
            col(makeBtn("✅ Allow this turn", "allow_turn", args.requestId, "default")),
            col(makeBtn("✅ Allow this session", "allow_session", args.requestId, "default")),
          ],
        },
        { tag: "markdown", content: `<font color="grey">Auto-deny on timeout</font>` },
      ],
    },
  };
}

export function buildPermissionCardResolved(args: {
  toolName: string;
  choice: PermissionChoice;
}): FeishuCardV2 {
  const labels: Record<PermissionChoice, string> = {
    allow: "Allowed (once)",
    deny: "Denied",
    allow_turn: "Allowed (this turn)",
    allow_session: "Allowed (this session)",
  };
  const icon = args.choice === "deny" ? "❌" : "✅";
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        { tag: "markdown", content: `${icon} ${labels[args.choice]} · \`${esc(args.toolName)}\`` },
      ],
    },
  };
}

export function buildPermissionCardTimedOut(args: { toolName: string }): FeishuCardV2 {
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        { tag: "markdown", content: `⏰ Timed out · \`${esc(args.toolName)}\` — auto-denied` },
      ],
    },
  };
}

function makeBtn(
  label: string,
  choice: PermissionChoice,
  requestId: string,
  type: "primary" | "danger" | "default",
): FeishuElement {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    width: "fill",
    value: { kind: "permission", request_id: requestId, choice },
  };
}

function col(element: FeishuElement): FeishuColumn {
  return { tag: "column", width: "weighted", weight: 1, elements: [element] };
}

function formatInputPreview(input: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(input, null, 2);
  } catch {
    json = String(input);
  }
  if (json.length > INPUT_PREVIEW_MAX) {
    return json.slice(0, INPUT_PREVIEW_MAX) + "\n... (truncated)";
  }
  return json;
}

function esc(text: string): string {
  return text.replace(/[*_`~[\]]/g, "\\$&");
}
