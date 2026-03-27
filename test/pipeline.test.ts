import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { executePipeline } from "../src/pipeline/pipeline.ts";
import type { CodeExecutor } from "../src/pipeline/executor.ts";
import type { Logger } from "../src/logger.ts";
import type { Ticket } from "../src/providers/types.ts";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ticket: Ticket = {
  id: "uuid-1",
  identifier: "ENG-100",
  title: "Test ticket",
  description: "Do something",
};

function mockExecutor(overrides?: Partial<CodeExecutor>): CodeExecutor {
  return {
    name: "mock",
    needsWorktree: true,
    run: async () => ({
      success: true,
      output: "mock output",
      timedOut: false,
      exitCode: 0,
    }),
    ...overrides,
  };
}

function failingExecutor(): CodeExecutor {
  return {
    name: "mock",
    needsWorktree: true,
    run: async () => ({
      success: false,
      output: "error output",
      timedOut: false,
      exitCode: 1,
    }),
  };
}

function createTempGitRepo(): string {
  const rootDir = mkdtempSync(join(tmpdir(), "agent-worker-test-"));
  const remoteDir = join(rootDir, "remote.git");
  const repoDir = join(rootDir, "repo");

  execSync(`git init --bare ${remoteDir}`);
  execSync(`git clone ${remoteDir} ${repoDir}`);
  execSync("git checkout -b main", { cwd: repoDir });
  execSync("git commit --allow-empty -m 'init'", { cwd: repoDir });
  execSync("git push -u origin main", { cwd: repoDir });
  execSync("git symbolic-ref HEAD refs/heads/main", { cwd: remoteDir });

  return rootDir;
}

function advanceRemoteMain(rootDir: string): string {
  const remoteDir = join(rootDir, "remote.git");
  const updaterDir = join(rootDir, "updater");

  execSync(`git clone ${remoteDir} ${updaterDir}`);
  execSync("git checkout main", { cwd: updaterDir });
  execSync("git commit --allow-empty -m 'remote advance'", { cwd: updaterDir });
  execSync("git push origin main", { cwd: updaterDir });

  return execSync("git rev-parse HEAD", { cwd: updaterDir }).toString().trim();
}

describe("executePipeline", () => {
  let rootDir: string;
  let repoDir: string;

  beforeEach(() => {
    rootDir = createTempGitRepo();
    repoDir = join(rootDir, "repo");
  });

  afterEach(() => {
    // Clean up any worktrees and the temp repo
    try {
      execSync("git worktree prune", { cwd: repoDir });
    } catch {}
    rmSync(rootDir, { recursive: true, force: true });
  });

  test("fails on pre-hook failure before reaching executor", async () => {
    const result = await executePipeline({
      ticket,
      preHooks: ["exit 1"],
      postHooks: [],
      optionalPostHooks: [],
      repoCwd: repoDir,
      executor: mockExecutor(),
      timeoutMs: 5000,
      logger: noopLogger,
    });
    expect(result.success).toBe(false);
    expect(result.stage).toBe("pre-hook");
  });

  test("returns error details from failed pre-hook", async () => {
    const result = await executePipeline({
      ticket,
      preHooks: ["echo 'setup ok'", "sh -c 'echo bad >&2; exit 2'"],
      postHooks: [],
      optionalPostHooks: [],
      repoCwd: repoDir,
      executor: mockExecutor(),
      timeoutMs: 5000,
      logger: noopLogger,
    });
    expect(result.success).toBe(false);
    expect(result.stage).toBe("pre-hook");
    expect(result.error).toContain("exited with code 2");
  });

  test("succeeds when all hooks pass and executor succeeds", async () => {
    const result = await executePipeline({
      ticket,
      preHooks: ["echo pre"],
      postHooks: ['test -f changed.txt'],
      optionalPostHooks: [],
      repoCwd: repoDir,
      executor: mockExecutor({
        run: async (_prompt, cwd) => {
          execSync("touch changed.txt", { cwd });
          return {
            success: true,
            output: "mock output",
            timedOut: false,
            exitCode: 0,
          };
        },
      }),
      timeoutMs: 5000,
      logger: noopLogger,
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe("mock output");
  });

  test("runs post-hooks on the ticket branch when worktree isolation is enabled", async () => {
    const result = await executePipeline({
      ticket,
      preHooks: [],
      postHooks: ['test "$(git rev-parse --abbrev-ref HEAD)" = "agent/task-ENG-100"'],
      optionalPostHooks: [],
      repoCwd: repoDir,
      executor: mockExecutor(),
      timeoutMs: 5000,
      logger: noopLogger,
    });

    expect(result.success).toBe(true);
  });

  test("creates the worktree from the latest origin/main", async () => {
    const remoteCommit = advanceRemoteMain(rootDir);

    const result = await executePipeline({
      ticket,
      preHooks: [],
      postHooks: [`test "$(git rev-parse HEAD)" = "${remoteCommit}"`],
      optionalPostHooks: [],
      repoCwd: repoDir,
      executor: mockExecutor(),
      timeoutMs: 5000,
      logger: noopLogger,
    });

    expect(result.success).toBe(true);
  });

  test("fails at executor stage when executor fails", async () => {
    const result = await executePipeline({
      ticket,
      preHooks: [],
      postHooks: [],
      optionalPostHooks: [],
      repoCwd: repoDir,
      executor: failingExecutor(),
      timeoutMs: 5000,
      logger: noopLogger,
    });
    expect(result.success).toBe(false);
    expect(result.stage).toBe("executor");
  });

  test("does not run post-hooks when executor fails", async () => {
    const result = await executePipeline({
      ticket,
      preHooks: [],
      postHooks: ["echo post"],
      optionalPostHooks: [],
      repoCwd: repoDir,
      executor: failingExecutor(),
      timeoutMs: 5000,
      logger: noopLogger,
    });
    expect(result.success).toBe(false);
    expect(result.stage).toBe("executor");
  });

  test("cleans up worktree after success", async () => {
    await executePipeline({
      ticket,
      preHooks: [],
      postHooks: [],
      optionalPostHooks: [],
      repoCwd: repoDir,
      executor: mockExecutor(),
      timeoutMs: 5000,
      logger: noopLogger,
    });
    // Worktree should be cleaned up — only the main working tree remains
    const output = execSync("git worktree list", { cwd: repoDir }).toString();
    const lines = output.trim().split("\n");
    expect(lines.length).toBe(1);
  });

  test("cleans up worktree after failure", async () => {
    await executePipeline({
      ticket,
      preHooks: ["exit 1"],
      postHooks: [],
      optionalPostHooks: [],
      repoCwd: repoDir,
      executor: mockExecutor(),
      timeoutMs: 5000,
      logger: noopLogger,
    });
    const output = execSync("git worktree list", { cwd: repoDir }).toString();
    const lines = output.trim().split("\n");
    expect(lines.length).toBe(1);
  });

  test("skips post-hooks when the executor makes no repository changes", async () => {
    const result = await executePipeline({
      ticket,
      preHooks: [],
      postHooks: ["exit 1"],
      optionalPostHooks: ["exit 1"],
      repoCwd: repoDir,
      executor: mockExecutor(),
      timeoutMs: 5000,
      logger: noopLogger,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("No repository changes detected; skipped post-hooks.");
  });

  test("does not fail when optional post-hooks fail", async () => {
    const result = await executePipeline({
      ticket,
      preHooks: [],
      postHooks: ['test -f changed.txt'],
      optionalPostHooks: ["exit 1"],
      repoCwd: repoDir,
      executor: mockExecutor({
        run: async (_prompt, cwd) => {
          execSync("touch changed.txt", { cwd });
          return {
            success: true,
            output: "changed file",
            timedOut: false,
            exitCode: 0,
          };
        },
      }),
      timeoutMs: 5000,
      logger: noopLogger,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Optional post-hooks failed but the task was kept successful:");
  });
});
