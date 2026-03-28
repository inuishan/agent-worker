import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";

const StatusesSchema = z.object({
  ready: z.string(),
  in_progress: z.string(),
  done: z.string(),
  failed: z.string(),
});

const LinearFiltersSchema = z.object({
  assignee_name: z.string().optional(),
  assignee_is_app: z.boolean().optional(),
  unblocked_only: z.boolean().default(false),
}).default({ unblocked_only: false });

const LinearSchema = z.object({
  project_id: z.string(),
  poll_interval_seconds: z.number().positive().default(60),
  statuses: StatusesSchema,
  filters: LinearFiltersSchema,
});

const RepoSchema = z.object({
  path: z.string(),
});

const HooksSchema = z.object({
  pre: z.array(z.string()).default([]),
  post: z.array(z.string()).default([]),
  post_optional: z.array(z.string()).default([]),
}).default({ pre: [], post: [], post_optional: [] });

const ExecutorSchema = z.object({
  type: z.enum(["claude", "codex"]).default("claude"),
  timeout_seconds: z.number().positive().default(300),
  retries: z.number().int().min(0).max(3).default(0),
}).default({ type: "claude", timeout_seconds: 300, retries: 0 });

const LogSchema = z.object({
  file: z.string().optional(),
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
}).default({ level: "info" });

const ConfigFileSchema = z.object({
  linear: LinearSchema,
  repo: RepoSchema,
  hooks: HooksSchema,
  executor: ExecutorSchema,
  log: LogSchema,
});

type ConfigFile = z.infer<typeof ConfigFileSchema>;

export type Config = ConfigFile & {
  apiKey: string;
};

export function loadConfig(filePath: string): Config {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY environment variable is required");
  }

  const text = readFileSync(filePath, "utf-8");
  const raw = parseYaml(text) as Record<string, unknown>;

  // Backward compat: map `claude` key to `executor` with type "claude"
  if (raw.claude && !raw.executor) {
    raw.executor = { ...(raw.claude as Record<string, unknown>), type: "claude" };
    delete raw.claude;
  }

  const parsed = ConfigFileSchema.parse(raw);

  return { ...parsed, apiKey };
}
