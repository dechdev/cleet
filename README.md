# Cleet

Run multiple Claude Code agents in parallel. Each agent gets its own git worktree, its own task, and you can merge completed work back to main with one command.

```
── [1] build-auth ─────────┬── [2] api-endpoints ────────┬── [3] write-tests ──────
│                           │                              │
│  Editing auth.ts...       │  Creating routes.ts...       │  All 12 tests passing
│  Added JWT validation     │  POST /users endpoint done   │
│                           │                              │
└───────────────────────────┴──────────────────────────────┴────────────────────────
```

## Install

```bash
git clone https://github.com/AKhaliq-dev/cleet.
brew install tmux jq
git ~/cleet
cd ~/cleet
./bin/cleet setup
```

That's it. `setup` copies files to `~/.cleet/`, installs a Claude Code hook, and symlinks `cleet` into your PATH.

**Requirements:** `tmux`, `jq`, `claude` CLI.

```bash
brew install tmux jq  # if needed
```

## Usage

```bash
# Launch 4 agents
cleet up -n 4

# Give them all tasks at once
cleet plan \
  "Build JWT auth middleware" \
  "Create user CRUD API endpoints" \
  "Write integration tests" \
  "Add rate limiting"

# Or assign individually
cleet task 1 "build auth" --send

# Review and ship
cleet diff 1 --stat
cleet check 1
cleet ship 1          # check → commit → merge → push

# Ship everything that passes
cleet ship all

# Done
cleet down
```

## Commands

| Command | Description |
|---------|-------------|
| `cleet setup` | Install (hooks, PATH symlink) |
| `cleet up [-n NUM] [-d DIR] [--tabs]` | Launch N agents |
| `cleet down` | Kill the session |
| `cleet status` | Quick status of all agents |
| `cleet plan "<t1>" "<t2>" ...` | Assign all tasks at once |
| `cleet task <N> "<desc>" [--send]` | Assign task to one agent |
| `cleet send <N> "<message>"` | Send message to agent N |
| `cleet diff <N> [--stat\|--files]` | Review agent's changes |
| `cleet diff all` | Summary of all agents |
| `cleet log <N>` | Agent's commit history |
| `cleet check <N> [--fix]` | Run lint/test/typecheck |
| `cleet check all` | Check all agents |
| `cleet commit <N> [-m "msg"]` | Commit agent's work |
| `cleet ship <N>` | Full pipeline: check → commit → merge → push |
| `cleet ship all` | Ship non-conflicting, report overlaps |
| `cleet dash` | Live dashboard |

## Layout

**Grid (default)** — all agents visible in a tiled tmux grid. Best for 2-6 agents.

```bash
cleet up -n 6
```

**Tabs** — each agent in its own tmux window. Better for 7+ agents.

```bash
cleet up -n 8 --tabs
```

## How It Works

- Each agent gets its own **git worktree** (isolated branch `cleet/agent-N`). No file conflicts during work.
- A **Stop hook** fires every time an agent finishes a turn — it tracks status, tokens, git stats, and runs checks automatically.
- Agents get a **CLAUDE.md** with context about what other agents are working on and which files they own, updated live.
- `cleet ship all` detects file overlaps between agents and ships non-conflicting ones first.

## Dashboard

`cleet dash` shows a live table with status, changes, test results, token usage, and health signals.

- **Green**: agent is productive
- **Yellow**: done but tests fail, or high cost with no output
- **Red**: burning tokens with zero file changes (stuck)

## Configuration

Create `.cleet.json` in your project root to customize check commands:

```json
{
  "checks": ["npm run lint", "npm test", "npm run typecheck"],
  "commit_prefix": "feat",
  "push_remote": "origin",
  "push_branch": "main"
}
```

Without this, checks are auto-detected from `package.json`, `Cargo.toml`, `pyproject.toml`, etc.

## Updating

```bash
cd ~/cleet
git pull
./bin/cleet setup
```
