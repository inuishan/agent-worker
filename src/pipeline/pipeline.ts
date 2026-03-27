import { join } from "path";
import { tmpdir } from "os";
import type { Logger } from "../logger.ts";
import type { Ticket } from "../providers/types.ts";
import type { CodeExecutor } from "./executor.ts";
import { buildTaskVars } from "./interpolate.ts";
import { runHooks } from "./hook-runner.ts";

export type PipelineResult = {
  success: boolean;
  stage?: "pre-hook" | "executor" | "post-hook";
  error?: string;
  output?: string;
};

async function runGit(
  args: string[],
  cwd: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

async function refreshBaseBranch(repoPath: string, logger: Logger): Promise<void> {
  logger.info("Refreshing base branch", { remote: "origin", branch: "main" });

  const { exitCode, stdout, stderr } = await runGit(["fetch", "origin", "main"], repoPath);
  if (exitCode !== 0) {
    throw new Error(`Failed to fetch origin/main: ${(stderr || stdout).trim()}`);
  }
}

async function createWorktree(
  repoPath: string,
  branch: string,
  logger: Logger
): Promise<string> {
  await refreshBaseBranch(repoPath, logger);

  const worktreeDirName = `agent-worker-${branch.replaceAll("/", "-")}`;
  const worktreePath = join(tmpdir(), worktreeDirName);
  logger.info("Creating worktree", { worktreePath, branch });

  const { exitCode, stdout, stderr } = await runGit(
    ["worktree", "add", "-B", branch, worktreePath, "origin/main"],
    repoPath
  );
  if (exitCode !== 0) {
    throw new Error(`Failed to create worktree: ${(stderr || stdout).trim()}`);
  }

  return worktreePath;
}

async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  logger: Logger
): Promise<void> {
  logger.info("Removing worktree", { worktreePath });

  const { exitCode, stderr } = await runGit(["worktree", "remove", "--force", worktreePath], repoPath);

  if (exitCode !== 0) {
    logger.warn("Failed to remove worktree", { worktreePath, error: stderr.trim() });
  }
}

export async function executePipeline(options: {
  ticket: Ticket;
  preHooks: string[];
  postHooks: string[];
  repoCwd: string;
  executor: CodeExecutor;
  timeoutMs: number;
  logger: Logger;
}): Promise<PipelineResult> {
  const { ticket, preHooks, postHooks, repoCwd, executor, timeoutMs, logger } = options;
  const vars = buildTaskVars(ticket);

  const useWorktree = executor.needsWorktree;
  let effectiveCwd = repoCwd;
  let worktreePath: string | null = null;

  // Create an isolated worktree when the executor opts into branch isolation.
  if (useWorktree) {
    try {
      worktreePath = await createWorktree(repoCwd, vars.branch, logger);
      effectiveCwd = worktreePath;
    } catch (err) {
      return {
        success: false,
        stage: "pre-hook",
        error: `Worktree creation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  vars.worktree = effectiveCwd;

  try {
    // Pre-hooks
    if (preHooks.length > 0) {
      const preResult = await runHooks(preHooks, effectiveCwd, vars, logger);
      if (!preResult.success) {
        return {
          success: false,
          stage: "pre-hook",
          error: `Command "${preResult.failedCommand}" exited with code ${preResult.exitCode}: ${preResult.output}`,
        };
      }
    }

    // Code executor
    const prompt = `Linear ticket: ${ticket.title}\n\n${ticket.description || "No description provided."}`;
    const execResult = await executor.run(prompt, effectiveCwd, timeoutMs, logger);
    if (!execResult.success) {
      const reason = execResult.timedOut
        ? `Timed out after ${timeoutMs}ms`
        : `Exited with code ${execResult.exitCode}`;
      return {
        success: false,
        stage: "executor",
        error: `${reason}: ${execResult.output.slice(-2000)}`,
      };
    }

    // Post-hooks
    if (postHooks.length > 0) {
      const postResult = await runHooks(postHooks, effectiveCwd, vars, logger);
      if (!postResult.success) {
        return {
          success: false,
          stage: "post-hook",
          error: `Command "${postResult.failedCommand}" exited with code ${postResult.exitCode}: ${postResult.output}`,
        };
      }
    }

    return { success: true, output: execResult.output };
  } finally {
    if (worktreePath) {
      await removeWorktree(repoCwd, worktreePath, logger);
    }
  }
}
