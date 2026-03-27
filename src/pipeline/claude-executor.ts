import type { Logger } from "../logger.ts";
import type { CodeExecutor, ExecutorResult } from "./executor.ts";
import { streamToLines } from "./executor.ts";

export function createClaudeExecutor(): CodeExecutor {
  return {
    name: "claude",
    needsWorktree: true,
    async run(prompt: string, cwd: string, timeoutMs: number, logger: Logger): Promise<ExecutorResult> {
      logger.info("Claude Code started", { timeoutMs });

      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(["claude", "--print", "--dangerously-skip-permissions", "-p", prompt], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Claude Code failed to start", { error: message });
        return { success: false, output: message, timedOut: false, exitCode: null };
      }

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);

      const [stdout, stderr] = await Promise.all([
        streamToLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
          logger.info("claude", { stream: "stdout", line });
        }),
        streamToLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
          logger.info("claude", { stream: "stderr", line });
        }),
      ]);

      const exitCode = await proc.exited;
      clearTimeout(timer);

      const output = (stdout + "\n" + stderr).trim();

      if (timedOut) {
        logger.error("Claude Code timed out", { timeoutMs });
        return { success: false, output, timedOut: true, exitCode: null };
      }

      if (exitCode !== 0) {
        logger.error("Claude Code failed", { exitCode });
      } else {
        logger.info("Claude Code completed successfully");
      }

      return { success: exitCode === 0, output, timedOut: false, exitCode };
    },
  };
}
