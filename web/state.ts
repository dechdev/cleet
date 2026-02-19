import { readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";

const CLEET_DIR = join(process.env.HOME!, ".cleet");

export interface CheckResult {
  command: string;
  status: "pass" | "fail";
  output: string;
  duration_ms: number;
}

export interface AgentState {
  id: number;
  task: string;
  status: "idle" | "working";
  statusAge: number;
  tokens: { input: number; output: number };
  changes: { files: number; insertions: number; deletions: number };
  modifiedFiles: string[];
  lastLines: string[];
  checks: {
    overall: "pass" | "fail" | null;
    results: CheckResult[];
  } | null;
  health: "green" | "yellow" | "red";
  paneOutput: string[];
}

export interface CleetState {
  session: string;
  workdir: string;
  layout: string;
  numAgents: number;
  agents: AgentState[];
  summary: {
    readyToShip: number[];
    needsFixing: number[];
    stuck: number[];
    totalTokens: number;
  };
}

async function readText(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf-8")).trim();
  } catch {
    return "";
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, "utf-8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function computeHealth(
  tokens: { input: number; output: number },
  changes: { files: number },
  status: "idle" | "working",
  statusAge: number,
  checks: { overall: "pass" | "fail" | null } | null
): "green" | "yellow" | "red" {
  const totalTokens = tokens.input + tokens.output;

  // Red: high tokens with no file changes, or checks failing
  if (totalTokens > 5000 && changes.files === 0) return "red";
  if (checks?.overall === "fail") return "red";

  // Yellow: working for a long time, or moderate tokens with no changes
  if (status === "working" && statusAge > 120) return "yellow";
  if (totalTokens > 2000 && changes.files === 0) return "yellow";

  return "green";
}

function capturePaneOutput(
  session: string,
  layout: string,
  paneBase: number,
  agentId: number
): Promise<string[]> {
  return new Promise((resolve) => {
    let target: string;
    if (layout === "grid") {
      target = `${session}:cleet.${paneBase + agentId - 1}`;
    } else {
      target = `${session}:agent-${agentId}`;
    }
    execFile("tmux", ["capture-pane", "-t", target, "-p"], (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      // Take last 30 non-empty lines
      const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
      resolve(lines.slice(-30));
    });
  });
}

async function readAgentState(
  id: number,
  session: string,
  layout: string,
  paneBase: number
): Promise<AgentState> {
  const statusText = await readText(join(CLEET_DIR, "status", `agent-${id}.status`));
  const status: "idle" | "working" = statusText === "idle" ? "idle" : "working";

  let statusAge = 0;
  try {
    const s = await stat(join(CLEET_DIR, "status", `agent-${id}.status`));
    statusAge = Math.floor((Date.now() - s.mtimeMs) / 1000);
  } catch {}

  const task = await readText(join(CLEET_DIR, "tasks", `agent-${id}.task`));

  const costData = await readJson<{ input_tokens: number; output_tokens: number }>(
    join(CLEET_DIR, "cost", `agent-${id}.cost`)
  );
  const tokens = {
    input: costData?.input_tokens ?? 0,
    output: costData?.output_tokens ?? 0,
  };

  const progressData = await readJson<{
    files_changed: number;
    insertions: number;
    deletions: number;
  }>(join(CLEET_DIR, "progress", `agent-${id}.json`));
  const changes = {
    files: progressData?.files_changed ?? 0,
    insertions: progressData?.insertions ?? 0,
    deletions: progressData?.deletions ?? 0,
  };

  const filesText = await readText(join(CLEET_DIR, "progress", `agent-${id}.files`));
  const modifiedFiles = filesText ? filesText.split("\n").filter(Boolean) : [];

  const lastLinesText = await readText(join(CLEET_DIR, "progress", `agent-${id}.lastlines`));
  const lastLines = lastLinesText ? lastLinesText.split("\n").filter(Boolean) : [];

  const checksData = await readJson<{
    overall: "pass" | "fail";
    results: CheckResult[];
  }>(join(CLEET_DIR, "checks", `agent-${id}.json`));
  const checks = checksData
    ? { overall: checksData.overall, results: checksData.results ?? [] }
    : null;

  const health = computeHealth(tokens, changes, status, statusAge, checks);

  const paneOutput = await capturePaneOutput(session, layout, paneBase, id);

  return {
    id,
    task,
    status,
    statusAge,
    tokens,
    changes,
    modifiedFiles,
    lastLines,
    checks,
    health,
    paneOutput,
  };
}

export async function readCleetState(): Promise<CleetState> {
  const session = await readText(join(CLEET_DIR, "session"));
  const workdir = await readText(join(CLEET_DIR, "workdir"));
  const layout = await readText(join(CLEET_DIR, "layout"));
  const numAgentsStr = await readText(join(CLEET_DIR, "num_agents"));
  const numAgents = parseInt(numAgentsStr, 10) || 0;
  const paneBaseStr = await readText(join(CLEET_DIR, "pane_base"));
  const paneBase = parseInt(paneBaseStr, 10) || 0;

  const agents: AgentState[] = [];
  for (let i = 1; i <= numAgents; i++) {
    agents.push(await readAgentState(i, session, layout, paneBase));
  }

  const readyToShip: number[] = [];
  const needsFixing: number[] = [];
  const stuck: number[] = [];
  let totalTokens = 0;

  for (const a of agents) {
    totalTokens += a.tokens.input + a.tokens.output;
    if (a.health === "green" && a.status === "idle" && a.changes.files > 0) {
      readyToShip.push(a.id);
    } else if (a.health === "red") {
      if (a.checks?.overall === "fail") {
        needsFixing.push(a.id);
      } else {
        stuck.push(a.id);
      }
    }
  }

  return {
    session,
    workdir,
    layout,
    numAgents,
    agents,
    summary: { readyToShip, needsFixing, stuck, totalTokens },
  };
}

export type StateChangeCallback = (state: CleetState) => void;

export function watchState(callback: StateChangeCallback): () => void {
  const watchers: FSWatcher[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const notify = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const state = await readCleetState();
        callback(state);
      } catch {}
    }, 200);
  };

  // Watch each state directory
  const dirs = ["status", "cost", "tasks", "checks", "progress"];
  for (const dir of dirs) {
    const dirPath = join(CLEET_DIR, dir);
    try {
      const w = watch(dirPath, { persistent: false }, () => notify());
      watchers.push(w);
    } catch {}
  }

  // Also watch top-level config files
  try {
    const w = watch(CLEET_DIR, { persistent: false }, (_event, filename) => {
      if (
        filename &&
        ["session", "workdir", "layout", "num_agents"].includes(filename)
      ) {
        notify();
      }
    });
    watchers.push(w);
  } catch {}

  // Fallback poll every 2s in case fs.watch misses events
  pollTimer = setInterval(notify, 2000);

  return () => {
    for (const w of watchers) w.close();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (pollTimer) clearInterval(pollTimer);
  };
}
