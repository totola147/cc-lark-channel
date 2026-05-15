import { z } from "zod";
import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { homedir } from "node:os";
import { resolve } from "node:path";

const LarkSchema = z.object({
  app_id: z.string().min(1, "lark.app_id is required"),
  app_secret: z.string().min(1, "lark.app_secret is required"),
});

const AccessSchema = z.object({
  allowed_open_ids: z.array(z.string()).optional().default([]),
  unauthorized_behavior: z.enum(["ignore", "reject"]).optional().default("ignore"),
}).optional().default({
  allowed_open_ids: [],
  unauthorized_behavior: "ignore" as const,
});

const ClaudeSchema = z.object({
  cli_path: z.string().optional().default("claude"),
  default_model: z.string().optional().default(""),
  default_cwd: z.string().optional().default(process.cwd()),
  permission_mode: z.enum(["default", "acceptEdits", "bypassPermissions"]).optional().default("default"),
  permission_timeout_seconds: z.number().int().positive().optional().default(120),
  max_queue_size: z.number().int().positive().optional().default(5),
}).optional().default({
  cli_path: "claude",
  default_model: "",
  default_cwd: process.cwd(),
  permission_mode: "default" as const,
  permission_timeout_seconds: 120,
  max_queue_size: 5,
});

const RenderSchema = z.object({
  hide_thinking: z.boolean().optional().default(false),
  show_turn_stats: z.boolean().optional().default(true),
  inline_max_bytes: z.number().int().positive().optional().default(1500),
  card_update_interval_ms: z.number().int().positive().optional().default(500),
}).optional().default({
  hide_thinking: false,
  show_turn_stats: true,
  inline_max_bytes: 1500,
  card_update_interval_ms: 500,
});

const PersistenceSchema = z.object({
  state_dir: z.string().optional().default("~/.cc-lark-channel"),
}).optional().default({
  state_dir: "~/.cc-lark-channel",
});

const LoggingSchema = z.object({
  level: z.enum(["trace", "debug", "info", "warn", "error"]).optional().default("info"),
}).optional().default({
  level: "info" as const,
});

const ConfigSchema = z.object({
  lark: LarkSchema,
  access: AccessSchema,
  claude: ClaudeSchema,
  render: RenderSchema,
  persistence: PersistenceSchema,
  logging: LoggingSchema,
});

export type AppConfig = z.infer<typeof ConfigSchema>;

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const raw = await readFile(configPath, "utf-8");
  const parsed = parse(raw);
  const config = ConfigSchema.parse(parsed);

  config.persistence.state_dir = expandHome(config.persistence.state_dir);
  config.claude.default_cwd = expandHome(config.claude.default_cwd);

  return config;
}
