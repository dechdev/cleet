#!/usr/bin/env bash
# swarm-hook.sh — Claude Code Stop hook for status, cost, progress, and auto-check
# Triggered async on every Stop event. Receives JSON on stdin.
# Writes agent status, token usage, git diff stats, file ownership, and check results.

SWARM_DIR="$HOME/.claude-swarm"
STATUS_DIR="$SWARM_DIR/status"
COST_DIR="$SWARM_DIR/cost"
TASKS_DIR="$SWARM_DIR/tasks"
PROGRESS_DIR="$SWARM_DIR/progress"
CHECKS_DIR="$SWARM_DIR/checks"

# Read hook input from stdin
input=$(cat)

# Determine agent number
agent_num="${SWARM_AGENT_NUM:-}"

# Fallback: parse from cwd path if using worktrees
if [[ -z "$agent_num" ]]; then
    cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null || true)
    if [[ "$cwd" == *"/agent-"* ]]; then
        agent_num=$(echo "$cwd" | grep -o 'agent-[0-9]*' | tail -1 | sed 's/agent-//')
    fi
fi

# If we can't identify the agent, exit silently
[[ -n "$agent_num" ]] || exit 0

# Ensure directories exist
mkdir -p "$STATUS_DIR" "$COST_DIR" "$PROGRESS_DIR" "$CHECKS_DIR"

# 1. Write idle status
echo "idle" > "$STATUS_DIR/agent-$agent_num.status"

# 2. Update pane title in grid mode
session=$(cat "$SWARM_DIR/session" 2>/dev/null || true)
layout=$(cat "$SWARM_DIR/layout" 2>/dev/null || true)
if [[ "$layout" == "grid" ]] && [[ -n "$session" ]]; then
    task_slug="Agent $agent_num"
    if [[ -f "$TASKS_DIR/agent-$agent_num.task" ]]; then
        raw=$(head -c 20 "$TASKS_DIR/agent-$agent_num.task")
        slug=$(echo "$raw" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')
        task_slug="[$agent_num] $slug"
    fi
    pane_base=$(cat "$SWARM_DIR/pane_base" 2>/dev/null || echo 0)
    tmux select-pane -t "$session:swarm.$((agent_num - 1 + pane_base))" -T "$task_slug" 2>/dev/null || true
fi

# 3. Parse transcript for token usage (single jq pass over entire file)
transcript_path=$(echo "$input" | jq -r '.transcript_path // empty' 2>/dev/null || true)

if [[ -n "$transcript_path" ]] && [[ -f "$transcript_path" ]]; then
    # Stream JSONL line-by-line without loading entire file into memory
    result=$(jq -n '
        reduce inputs as $line ({input_tokens: 0, output_tokens: 0};
            .input_tokens += ($line.message.usage.input_tokens // 0) |
            .output_tokens += ($line.message.usage.output_tokens // 0)
        )
    ' "$transcript_path" 2>/dev/null || true)

    if [[ -n "$result" ]]; then
        echo "$result" > "$COST_DIR/agent-$agent_num.cost"
    fi
fi

# 4. Git diff stats + file ownership tracking
work_dir=$(cat "$SWARM_DIR/workdir" 2>/dev/null || true)
wt_dir="$work_dir/.worktrees/agent-$agent_num"

if [[ -n "$work_dir" ]] && [[ -d "$wt_dir" ]]; then
    # Write modified file list (for conflict detection / agent awareness)
    git -C "$wt_dir" diff --name-only main 2>/dev/null > "$PROGRESS_DIR/agent-$agent_num.files" || true

    # Write diff stats as JSON
    stat_line=$(git -C "$wt_dir" diff --stat main 2>/dev/null | tail -1 || true)
    files_changed=0
    insertions=0
    deletions=0
    if [[ -n "$stat_line" ]]; then
        files_changed=$(echo "$stat_line" | grep -o '[0-9]* file' | grep -o '[0-9]*' || echo 0)
        insertions=$(echo "$stat_line" | grep -o '[0-9]* insertion' | grep -o '[0-9]*' || echo 0)
        deletions=$(echo "$stat_line" | grep -o '[0-9]* deletion' | grep -o '[0-9]*' || echo 0)
    fi
    jq -n --argjson fc "${files_changed:-0}" --argjson ins "${insertions:-0}" --argjson del "${deletions:-0}" \
        '{files_changed: $fc, insertions: $ins, deletions: $del}' \
        > "$PROGRESS_DIR/agent-$agent_num.json"
fi

# 5. Capture last 3 lines of tmux pane output
if [[ -n "$session" ]]; then
    target=""
    if [[ "$layout" == "grid" ]]; then
        pane_base=$(cat "$SWARM_DIR/pane_base" 2>/dev/null || echo 0)
        target="$session:swarm.$((agent_num - 1 + pane_base))"
    else
        target="$session:agent-$agent_num"
    fi
    tmux capture-pane -p -t "$target" 2>/dev/null | tail -3 > "$PROGRESS_DIR/agent-$agent_num.lastlines" || true
fi

# 6. Auto-check on idle — detect and run checks in background
if [[ -n "$work_dir" ]] && [[ -d "$wt_dir" ]]; then
    # Detect check commands
    checks=""

    # .swarm.json override (check in main work_dir)
    if [[ -f "$work_dir/.swarm.json" ]]; then
        checks=$(jq -r '.checks[]? // empty' "$work_dir/.swarm.json" 2>/dev/null || true)
    fi

    # Auto-detect if no override
    if [[ -z "$checks" ]]; then
        if [[ -f "$wt_dir/package.json" ]]; then
            if jq -e '.scripts.lint' "$wt_dir/package.json" &>/dev/null; then
                checks="npm run lint"
            fi
            if jq -e '.scripts.test' "$wt_dir/package.json" &>/dev/null; then
                checks="${checks:+$checks
}npm test"
            fi
        elif [[ -f "$wt_dir/Cargo.toml" ]]; then
            checks="cargo test"
        elif [[ -f "$wt_dir/pyproject.toml" ]] || [[ -f "$wt_dir/setup.py" ]]; then
            checks="pytest"
        elif [[ -f "$wt_dir/Makefile" ]] && grep -q '^test:' "$wt_dir/Makefile"; then
            checks="make test"
        elif [[ -f "$wt_dir/go.mod" ]]; then
            checks="go test ./..."
        fi
    fi

    # Run checks if any detected
    if [[ -n "$checks" ]]; then
        (
            overall="pass"
            results=()
            timestamp=$(date +%s)

            while IFS= read -r cmd; do
                [[ -n "$cmd" ]] || continue
                start_s=$(date +%s)
                output=""
                status="pass"
                if output=$(cd "$wt_dir" && eval "$cmd" 2>&1); then
                    status="pass"
                else
                    status="fail"
                    overall="fail"
                fi
                end_s=$(date +%s)
                duration_ms=$(( (end_s - start_s) * 1000 ))
                short_output=$(echo "$output" | tail -5)
                results+=("{\"command\":$(echo "$cmd" | jq -Rs .),\"status\":\"$status\",\"output\":$(echo "$short_output" | jq -Rs .),\"duration_ms\":$duration_ms}")
            done <<< "$checks"

            results_json=$(printf '%s\n' "${results[@]}" | jq -s '.')
            jq -n --argjson ts "$timestamp" --argjson results "$results_json" --arg overall "$overall" \
                '{timestamp: $ts, results: $results, overall: $overall}' > "$CHECKS_DIR/agent-$agent_num.json"

            # Play notification sound
            if command -v afplay &>/dev/null; then
                if [[ "$overall" == "pass" ]]; then
                    afplay /System/Library/Sounds/Glass.aiff &>/dev/null || true
                else
                    afplay /System/Library/Sounds/Basso.aiff &>/dev/null || true
                fi
            elif command -v paplay &>/dev/null; then
                paplay /usr/share/sounds/freedesktop/stereo/complete.oga &>/dev/null || true
            fi
        ) &
    fi
fi

# 7. Regenerate CLAUDE.md for all agents with updated file ownership
if [[ -n "$work_dir" ]] && [[ -d "$work_dir/.worktrees" ]]; then
    num_agents=$(cat "$SWARM_DIR/num_agents" 2>/dev/null || echo 0)

    for i in $(seq 1 "$num_agents"); do
        iwt="$work_dir/.worktrees/agent-$i"
        [[ -d "$iwt" ]] || continue

        task="-"
        [[ -f "$TASKS_DIR/agent-$i.task" ]] && task=$(head -1 "$TASKS_DIR/agent-$i.task")

        mkdir -p "$iwt/.claude"

        {
            echo "# Swarm Context"
            echo ""
            echo "You are Agent $i. Your task: \"$task\""
            echo ""
            echo "## Other agents are working on:"

            for j in $(seq 1 "$num_agents"); do
                [[ "$j" -eq "$i" ]] && continue
                other_task="-"
                [[ -f "$TASKS_DIR/agent-$j.task" ]] && other_task=$(head -1 "$TASKS_DIR/agent-$j.task")

                files_info=""
                if [[ -f "$PROGRESS_DIR/agent-$j.files" ]]; then
                    file_list=$(head -20 "$PROGRESS_DIR/agent-$j.files" | tr '\n' ', ' | sed 's/,$//')
                    [[ -n "$file_list" ]] && files_info=" — modifying: $file_list"
                fi
                echo "- Agent $j: \"$other_task\"$files_info"
            done

            echo ""
            echo "## Rules"
            echo "- Do NOT modify files listed above unless absolutely necessary"
            echo "- If you need changes to another agent's files, note it as a TODO instead"
            echo "- Create new files rather than editing shared ones when possible"
        } > "$iwt/.claude/CLAUDE.md"
    done
fi

exit 0
