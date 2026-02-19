# Product Vision: Multi-Agent Workspace Manager

## Concept

A multi-agent workspace where users run N parallel Claude agents, each with persistent context, switchable via voice, click, or keyboard. Think "mission control for AI coding agents."

The current `multi-claude.sh` is the proof-of-concept. The full product wraps this in a proper UI with orchestration, cost tracking, and agent coordination.

## Architecture Sketch

```
┌─────────────────────────────────────────────┐
│             Agent Dashboard (UI)            │
│  ┌────────┐ ┌────────┐ ┌────────┐          │
│  │Agent 1 │ │Agent 2 │ │Agent 3 │  ...     │
│  │"auth"  │ │"api"   │ │"tests" │          │
│  │$0.42   │ │$1.08   │ │$0.15   │          │
│  └────────┘ └────────┘ └────────┘          │
├─────────────────────────────────────────────┤
│           Active Agent Terminal              │
│                                             │
│  > Working on auth middleware...            │
│                                             │
└─────────────────────────────────────────────┘
```

**Stack:**
- Web UI or Electron app
- Claude Agent SDK (`@anthropic-ai/claude-code`) for each agent subprocess
- WebSocket for real-time agent output streaming
- SQLite or file-based persistence for agent contexts

## Key Features

- **Agent dashboard** — see all agents at a glance with status, task, and cost
- **Task assignment** — drag a task description onto an agent to start it
- **Cost tracking per agent** — real-time token/dollar counters per agent and total
- **Context persistence** — agents remember their task across restarts
- **Voice routing** — say "agent three, run the tests" to direct commands
- **Agent coordination** — agents can share results (e.g., agent 1 builds API, agent 2 writes tests against it)
- **Snapshot/restore** — save agent state, spin down idle agents, restore on demand

## Cost Considerations

Token usage scales linearly with active agents. Mitigation strategies:

- **Lazy activation** — only spin up agents when they have active tasks
- **Context summarization** — periodically compress agent context to reduce token usage
- **Shared tool results** — if two agents read the same file, cache the result
- **Budget caps** — per-agent and total spending limits with alerts
- **Tiered models** — use Haiku for simple tasks, Opus for complex ones

At current API pricing, running 5 agents actively for an hour might cost $5-25 depending on task complexity. The key insight: parallel agents can compress wall-clock time dramatically, so the dollar-per-feature cost may actually decrease.

## Competitive Landscape

| Tool | Approach | Limitation |
|------|----------|------------|
| Cursor subagents | Background agents in IDE | Tied to Cursor, limited visibility |
| Claude Code `Task` tool | Child agent within single session | No persistent parallel agents |
| OpenAI Codex | Cloud-hosted agent | No local, no multi-agent |
| Various "cleet" frameworks | Multi-agent orchestration | Developer-facing, no UX |

## Differentiation

1. **Voice-first UX** — no other tool lets you say "agent three, refactor the auth module"
2. **Visual agent dashboard** — see what every agent is doing at a glance
3. **Cost transparency** — real-time spending per agent, not a surprise bill
4. **Local-first** — agents run on your machine, your code stays local
5. **Progressive complexity** — starts as a simple tmux wrapper, grows into full orchestration

## Level 0 → Level 1: The Five Pain Points

Level 0 (current tmux script) works but has five real friction points.
Level 1 solves all five. **Status: IMPLEMENTED** via the `cleet` CLI.

### Level 1 Implementation Summary

The `cleet` CLI (`~/.cleet/bin/cleet`) provides:

| Pain Point | Solution | Command |
|------------|----------|---------|
| 1. No visibility | Live dashboard | `cleet dash` |
| 2. No cross-agent messaging | tmux send-keys | `cleet send <N> "msg"` |
| 3. File edit conflicts | Git worktrees per agent | automatic in git repos |
| 4. Forgetting agent tasks | Persistent task labels | `cleet task <N> "desc"` |
| 5. No cost tracking | Stop hook + token parsing | `cleet dash` (token column) |

---

### Pain 1: Can't see what an agent is doing without switching to it

**The problem:** You have 4 agents running. You're looking at agent 1. Agents 2-4 could be done, stuck, or burning tokens — you have no idea without manually switching to each.

**Solution: Status file + dashboard pane**

Each Claude agent writes a one-line status to a shared file:
```
~/.cleet/status/agent-1.status  →  "Working: refactoring auth middleware (2m ago)"
~/.cleet/status/agent-2.status  →  "Waiting: needs user input"
~/.cleet/status/agent-3.status  →  "Done: tests passing (30s ago)"
```

A dedicated tmux pane (or window) runs a `watch`-style dashboard that reads all status files and renders a live overview:
```
┌─ Agent Dashboard ──────────────────────────────────┐
│  1 │ auth-refactor  │ ● Working  │ 2m   │ $0.42  │
│  2 │ api-endpoints  │ ○ Waiting  │ 5m   │ $1.08  │
│  3 │ test-suite     │ ✓ Done     │ 30s  │ $0.15  │
│  4 │ docs           │ ● Working  │ 1m   │ $0.31  │
└────────────────────────────────────────────────────┘
```

**How it works technically:**
- Claude Code supports hooks (`~/.claude/hooks.json`) — shell commands triggered on events
- A hook on `assistant_response` writes the last line of output to the status file
- Dashboard script uses `watch` + reads status files every 2s
- Alternatively: use `tmux capture-pane` to grab the last visible line from each window

---

### Pain 2: No way to say "agent 2, do X" from agent 1's window

**The problem:** You're in agent 1, and you realize agent 3 should run the tests. You have to switch to agent 3, type the message, switch back. Breaks flow.

**Solution: Message queue via filesystem**

A simple command — `cleet send 3 "run the test suite"` — drops a message:
```
~/.cleet/inbox/agent-3.msg  →  "run the test suite"
```

Each agent has a watcher (or Claude Code hook) that picks up messages from its inbox and injects them as the next prompt. This could be:

- A background process per agent watching the inbox file
- A Claude Code hook that checks the inbox on each turn
- A tmux `send-keys` to the target window (simplest, most reliable):
  ```bash
  cleet send 3 "run the test suite"
  # → tmux send-keys -t cleet:3 "run the test suite" Enter
  ```

The `tmux send-keys` approach works today with zero infrastructure. We just need a `cleet` CLI wrapper.

---

### Pain 3: Agents can step on each other (edit the same file)

**The problem:** Agent 1 is refactoring `auth.ts`. Agent 2 starts editing `auth.ts` too. One overwrites the other. Silent data loss.

**Solution: Git worktrees — each agent gets an isolated copy**

```bash
# Main repo
~/project/
  ├── .git/

# Agent worktrees (created by multi-claude.sh)
~/project/.worktrees/
  ├── agent-1/    ← full working copy, own branch
  ├── agent-2/    ← full working copy, own branch
  └── agent-3/    ← full working copy, own branch
```

Each agent works on its own branch in its own worktree. No conflicts possible during work. Merging happens explicitly when the user says "merge agent 2's work."

**Implementation:**
- `multi-claude.sh` creates worktrees with `git worktree add`
- Each agent's tmux window `cd`s into its worktree
- New `cleet merge <agent>` command merges an agent's branch back
- Agent branches named `cleet/agent-1`, `cleet/agent-2`, etc.

**Tradeoff:** Uses more disk space (one working copy per agent). Worth it for isolation. Git worktrees use hardlinks for the object store so it's not a full clone.

---

### Pain 4: You forget which agent is doing what

**The problem:** You spun up 5 agents an hour ago. Agent 3 was doing... something? You named them `agent-3` which tells you nothing.

**Solution: Task assignment with persistent labels**

When you assign work, it sticks:
```bash
cleet task 1 "refactor auth middleware"
cleet task 2 "build REST endpoints for users API"
cleet task 3 "write integration tests"
```

This does two things:
1. Renames the tmux window: `agent-1` → `1:auth-refactor`
2. Writes to `~/.cleet/tasks/agent-1.task` for persistence

The tmux status bar always shows what each agent is doing:
```
[ 1:auth-refactor | 2:api-endpoints | 3:tests | 4:docs ]
```

If you reattach later, the task names are still there. The dashboard (Pain 1) also reads these task files.

Optionally: when you assign a task, the message is also sent to the agent as a prompt (combines with Pain 2).

---

### Pain 5: No cost visibility

**The problem:** You're running 5 agents. Are you spending $1/hour or $20/hour? No way to know until you check your Anthropic dashboard after the fact.

**Solution: Parse Claude Code's cost output**

Claude Code shows cost info in its output. We capture it:

- Claude Code hook on `stop` event extracts the session cost
- Writes to `~/.cleet/cost/agent-1.cost`
- Dashboard (Pain 1) aggregates and displays per-agent and total cost
- Optionally: set a budget cap in `cleet config` — if total exceeds $X, alert or pause agents

```
┌─ Cost Tracker ─────────────┐
│  Agent 1:  $0.42           │
│  Agent 2:  $1.08           │
│  Agent 3:  $0.15           │
│  Agent 4:  $0.31           │
│  ─────────────────         │
│  Total:    $1.96           │
│  Budget:   $10.00 (19.6%)  │
└────────────────────────────┘
```

---

## Level 1 Build Order

Prioritized by impact and feasibility:

| # | What | Why first | Effort |
|---|------|-----------|--------|
| 1 | `cleet` CLI + task assignment (Pain 4) | Solves "which agent is doing what" immediately | Small — tmux rename + file |
| 2 | Git worktrees (Pain 3) | Prevents silent data loss, must exist before real parallel work | Medium — script changes |
| 3 | Cross-agent messaging via `tmux send-keys` (Pain 2) | Unblocks directing agents without switching | Small — wrapper command |
| 4 | Dashboard pane (Pain 1) | Shows everything at a glance | Medium — watch script + status parsing |
| 5 | Cost tracking (Pain 5) | Important but not blocking usage | Medium — hook + parsing |

All five fit into a single `cleet` CLI tool that wraps tmux.

---

## Level 2: The Orchestration Layer — **IMPLEMENTED**

Level 2 closes every gap between "agents are running" and "code is merged to main."

### Level 2 Implementation Summary

| Feature | Command | What it does |
|---------|---------|-------------|
| Brain-dump tasks | `cleet plan "t1" "t2" ...` | Batch-dispatch to all agents at once |
| Code review | `cleet diff N [--stat\|--files]` | Review agent's changes vs main |
| Commit history | `cleet log N` | Show agent's commits |
| Quality checks | `cleet check N [--fix]` | Run lint/test/typecheck in worktree |
| Auto-commit | `cleet commit N [-m "msg"]` | Commit with conventional message |
| Full pipeline | `cleet ship N` | check → commit → merge → push |
| Batch ship | `cleet ship all` | Ship non-conflicting, report overlaps |
| Enhanced dashboard | `cleet dash` | Changes, Tests, Health, summary line |
| Agent awareness | CLAUDE.md per worktree | File ownership context, conflict prevention |
| Auto-check on idle | Stop hook | Runs checks automatically, plays notification |
| Health signals | Dashboard | Green/yellow/red based on tokens vs output |

### Key Design Decisions
- **Check config**: Auto-detect from package.json/Cargo.toml/etc., `.cleet.json` overrides
- **Automation**: Auto-check + notify on idle. Ship is manual (intentional).
- **Conflict prevention**: Agents are aware of each other via CLAUDE.md. File ownership tracked live. Conflicts detected at ship time.

---

## Level 3+: Beyond Developers

Level 2 is still a terminal tool for developers. The path to non-developers:

**Level 3 — Web/Desktop UI:** Electron or web app wrapping Claude Agent SDK. Same concepts (dashboard, tasks, cost) but visual. Users never see a terminal. Target: technical non-devs, PMs, designers.

**Level 4 — Task-first, not agent-first:** User describes outcomes ("build me a landing page"), system decides how many agents to use and what each does. The orchestration is invisible. Target: anyone.

**Key insight:** Each level is a wrapper around the previous one. Level 1 (`cleet` CLI) becomes the backend for Level 2 (orchestration). Level 2's task engine becomes the core of Level 3 (GUI). Nothing gets thrown away.

## Open Questions

- How to handle agent-to-agent communication? Shared filesystem vs message passing?
- Should agents be able to spawn sub-agents? (Recursive cleets)
- What's the right default number of agents? (Hypothesis: 3-5 for most workflows)
- Should the `cleet` CLI be a separate binary or stay as shell scripts?
- How to detect when an agent is truly idle vs thinking?
