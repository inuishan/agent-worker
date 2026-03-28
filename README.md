# agent-worker

An autonomous worker agent that picks up tasks from your issue tracker and completes them — without you in the loop.

![Agent Worker Demo](assets/demo.png)

## Thesis

The way to scale with AI agents is to get out of the loop. Stop babysitting. Stop copy-pasting tickets into chat windows. Define the work, assign it to the agent, and walk away.

**agent-worker** is a polling-based worker that watches your issue tracker for assigned tasks, claims them, executes an agent harness to do the work, and reports results back. You stay out of the loop entirely.

### Why polling?

Webhook-based agent orchestrators like OpenClaw require you to expose ports and endpoints to the internet. That's a security surface you don't need. The polling pattern is simpler and more secure — your agent reaches out on its own schedule, nothing reaches in. This scales from a single agent on your laptop to hundreds of workers across many repos and projects without any additional infrastructure.

### Hooks: deterministic guardrails around non-deterministic agents

Agents are powerful but non-deterministic. Pre and post hooks let you wrap agent execution with deterministic, auditable steps — checking out a branch, running tests, linting, pushing code. The agent does the creative work; hooks enforce the process.

### Agent-harness agnostic

agent-worker is not tied to a single agent. It supports any agent harness that can accept a prompt and return a result. Currently supported:

- **Claude Code** — Anthropic's CLI agent
- **Codex** — OpenAI's CLI agent

Adding a new harness is a single file implementing the executor interface.

## Prerequisites

- [Bun](https://bun.sh) 1.0+
- An agent harness installed and authenticated (Claude Code or Codex)
- A Linear account with a personal API key

## Installation

Download a pre-built binary from the releases page, or build from source:

```bash
git clone https://github.com/owainlewis/agent-worker
cd agent-worker
bun install
bun run build
```

The compiled binary is written to `dist/agent-worker`.

## Configuration

Copy the example config and edit it:

```bash
cp agent-worker.example.yaml agent-worker.yaml
```

Set your Linear API key as an environment variable:

```bash
export LINEAR_API_KEY=lin_api_...
```

### Configuration reference

```yaml
linear:
  project_id: "your-project-uuid"     # Linear project UUID (required)
  poll_interval_seconds: 60           # How often to check for new tickets

  statuses:
    ready: "Todo"                     # Status that marks a ticket ready for pickup
    in_progress: "In Progress"        # Status set when the agent claims a ticket
    done: "Done"                      # Status set on success
    failed: "Canceled"                # Status set on failure
  filters:
    assignee_name: "Ishan Jain"       # Optional: only pick tickets assigned to this Linear user/app
    subscriber_name: "Codex"          # Optional: only pick tickets subscribed by this Linear user/app
    subscriber_is_app: true           # Optional: require the subscriber to be a Linear app user
    unblocked_only: true              # Optional: only pick tickets with no blocking issue

repo:
  path: "/path/to/your/repo"          # Absolute path to the working repository

hooks:
  # The built-in executors create a git worktree automatically, so you
  # don't need branch/checkout commands here.
  pre: []                             # Commands to run before the agent (optional)

  post:                               # Commands to run after the agent succeeds (optional)
    - "git add -A"
    - "git commit -m '{id}: {raw_title}'"
    - "git push origin {branch}"
  post_optional:                      # Best-effort commands; failures do not fail the task
    - "gh pr create --title '{id}: {raw_title}' --body 'Fixes {id}. Implemented by Agent Worker.' --base main"
    - "gh pr merge --auto --squash --delete-branch"

executor:
  type: claude                        # Agent harness: "claude" or "codex"
  timeout_seconds: 300                # Max time for the agent to complete
  retries: 0                          # Retry attempts on failure (0–3)

log:
  file: "./agent-worker.log"          # Log file path (omit for stdout only)
```

Hook commands support variable interpolation:

| Variable | Value |
|---|---|
| `{id}` | Linear ticket identifier (e.g. `ENG-42`) |
| `{title}` | Slugified ticket title (e.g. `add-login-page`) |
| `{raw_title}` | Original ticket title, sanitized for shell safety (e.g. `Add login page`) |
| `{branch}` | Generated branch name (`agent/task-{id}`) |

Ticket selection can also be narrowed with `linear.filters`:

- `assignee_name` limits pickup to issues assigned to a matching Linear user or app name.
- `assignee_is_app: true` ensures the assignee is a Linear app user.
- `subscriber_name` limits pickup to issues where a matching Linear user or app is subscribed.
- `subscriber_is_app: true` ensures the matching subscriber is a Linear app user, which is useful for the Codex app case.
- `unblocked_only: true` excludes issues that currently have blocking relations.

## Usage

```bash
agent-worker --config ./agent-worker.yaml
```

The worker runs as a foreground process and handles SIGINT/SIGTERM for graceful shutdown.

## How it works

1. **Poll** — Watch Linear for tickets in the `ready` status on a configurable interval.
2. **Claim** — Transition the ticket to `in_progress` so no other worker picks it up.
3. **Worktree isolation** — For executors that set `needsWorktree: true`, the pipeline refreshes `origin/main` and creates an isolated git worktree for the ticket on a fresh branch (`agent/task-{id}`). This keeps each ticket's work fully isolated from the main repo and from other in-flight tickets while starting from the latest remote mainline.
4. **Pre-hooks** — Run deterministic setup commands in the worktree directory (optional).
5. **Agent execution** — Hand the ticket to your configured agent harness. The agent reads the task description and does the work autonomously.
6. **Post-hooks** — Run required post-processing commands (e.g. commit, push), then optional best-effort hooks such as PR creation.
7. **Report** — On success, mark the ticket `done`. On failure, mark it `failed` and post a comment with the failure details.

One ticket is processed at a time. After completion, the worker returns to polling.

## Git worktree isolation

When using the **Claude** executor, the pipeline automatically creates a dedicated git worktree for each ticket before invoking the agent:

- `origin/main` is refreshed before branch creation.
- A new branch `agent/task-{id}` is created from the latest `origin/main`.
- The agent runs inside that worktree, so its changes are fully isolated.
- Multiple agent-worker processes can run against the same repository in parallel without conflicting — each works in its own branch and directory.

Because branch creation is handled automatically, **pre-hooks no longer need `git checkout` or branch commands** when using Claude:

```yaml
# Claude executor — worktree is created automatically
hooks:
  pre: []
  post:
    - "git add -A"
    - "git commit -m '{id}: {raw_title}'"
    - "git push origin {branch}"
  post_optional:
    - "gh pr create --title '{id}: {raw_title}' --body 'Fixes {id}.' --base main"
    - "gh pr merge --auto --squash --delete-branch"
```

If the agent produces no repository changes, agent-worker skips post-hooks and still marks the task successful. This is useful for review-only or reporting tasks such as checking test coverage.

**Codex** uses the same agent-worker-managed worktree flow as Claude, so post-hooks run in the ticket branch worktree and `{branch}` resolves to a real local branch.

This behaviour is controlled by the `needsWorktree` flag on the `CodeExecutor` interface (`src/pipeline/executor.ts`). Set it to `true` in a custom executor to opt in to automatic worktree isolation, or `false` to manage isolation yourself.

### Running multiple agents in parallel

Because each ticket gets its own isolated worktree and branch, you can safely run multiple agent-worker processes pointing at the same repository:

```bash
# Terminal 1
agent-worker --config ./agent-worker.yaml

# Terminal 2
agent-worker --config ./agent-worker.yaml
```

Each process claims different tickets (the `in_progress` status transition acts as a distributed lock) and works in a separate worktree, so there are no conflicts.

## Claude executor

The Claude executor invokes [Claude Code](https://docs.anthropic.com/claude/docs/claude-code) as a headless subprocess:

```
claude --print --dangerously-skip-permissions -p "<ticket prompt>"
```

- `--print` — non-interactive mode; Claude reads the prompt, does the work, and exits.
- `--dangerously-skip-permissions` — suppresses interactive permission prompts so the agent can run fully autonomously.
- `-p` — passes the ticket title and description as the initial prompt.

The executor streams stdout and stderr to the agent-worker log in real time and returns success if the process exits with code `0`.

### Worktree isolation

When `executor.type` is `claude`, the pipeline automatically creates an isolated git worktree before invoking the agent (see [Git worktree isolation](#git-worktree-isolation)). The agent runs inside that worktree so its changes are fully isolated from `main` and from other in-flight tickets.

### CLAUDE.md — project-specific instructions

Claude Code reads a `CLAUDE.md` file from the root of the worktree if one exists. Use this file to give the agent project-specific context it needs to do the work correctly:

```markdown
# My Project

## Stack
- Runtime: Bun
- Language: TypeScript
- Testing: `bun test`

## Conventions
- No classes — use plain functions and interfaces
- All API routes under /api/v1/
```

Place `CLAUDE.md` in the root of your repository. It is checked in alongside your code and is inherited by every worktree the agent runs in. The agent reads it on startup and follows its instructions throughout the task.

### Timeout and retry configuration

Control how long the agent is allowed to run and how many times to retry on failure:

```yaml
executor:
  type: claude
  timeout_seconds: 300   # Kill the agent if it hasn't finished within this many seconds (default: 300)
  retries: 0             # Retry attempts on non-zero exit or timeout (0–3, default: 0)
```

If `timeout_seconds` is exceeded the process is killed and the ticket is marked failed. If `retries` is greater than `0`, the full pipeline (pre-hooks → agent → post-hooks) is retried up to that many times before giving up.

### Full example config

```yaml
linear:
  project_id: "your-project-uuid"
  poll_interval_seconds: 60
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "Done"
    failed: "Canceled"
  filters:
    assignee_name: "Ishan Jain"
    subscriber_name: "Codex"
    subscriber_is_app: true
    unblocked_only: true

repo:
  path: "/path/to/your/repo"

hooks:
  pre: []                             # Worktree + branch are created automatically
  post:
    - "git add -A"
    - "git commit -m '{id}: {raw_title}'"
    - "git push origin {branch}"
  post_optional:
    - "gh pr create --title '{id}: {raw_title}' --body 'Fixes {id}.' --base main"
    - "gh pr merge --auto --squash --delete-branch"

executor:
  type: claude
  timeout_seconds: 300
  retries: 0

log:
  file: "./agent-worker.log"
```

## Development

```bash
bun install       # Install dependencies
bun test          # Run tests
bun run build     # Compile binary to dist/agent-worker
```

Cross-platform builds:

```bash
bun run build:darwin-arm64
bun run build:darwin-x64
bun run build:linux-x64
```

## License

MIT
