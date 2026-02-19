import { execFile } from "node:child_process";
import { join } from "node:path";

const SWARM_BIN = join(process.env.HOME!, ".claude-swarm", "bin", "swarm");

export interface ActionResult {
  ok: boolean;
  output: string;
}

function run(args: string[]): Promise<ActionResult> {
  return new Promise((resolve) => {
    execFile(SWARM_BIN, args, { timeout: 30000 }, (error, stdout, stderr) => {
      const output = (stdout || "") + (stderr || "");
      resolve({ ok: !error, output: output.trim() });
    });
  });
}

// Long-running actions (diff, log, ship) get more time
function runLong(args: string[]): Promise<ActionResult> {
  return new Promise((resolve) => {
    execFile(SWARM_BIN, args, { timeout: 120000 }, (error, stdout, stderr) => {
      const output = (stdout || "") + (stderr || "");
      resolve({ ok: !error, output: output.trim() });
    });
  });
}

export function send(agent: number, message: string): Promise<ActionResult> {
  return run(["send", String(agent), message]);
}

export function task(agent: number, description: string): Promise<ActionResult> {
  return run(["task", String(agent), description, "--send"]);
}

export function plan(tasks: string[]): Promise<ActionResult> {
  return run(["plan", ...tasks]);
}

export function check(agent: number): Promise<ActionResult> {
  return runLong(["check", String(agent)]);
}

export function checkAll(): Promise<ActionResult> {
  return runLong(["check", "all"]);
}

export function checkFix(agent: number): Promise<ActionResult> {
  return run(["check", String(agent), "--fix"]);
}

export function commit(agent: number, message?: string): Promise<ActionResult> {
  const args = ["commit", String(agent)];
  if (message) args.push("-m", message);
  return runLong(args);
}

export function ship(agent: number): Promise<ActionResult> {
  return runLong(["ship", String(agent)]);
}

export function shipAll(): Promise<ActionResult> {
  return runLong(["ship", "all"]);
}

export function merge(agent: number): Promise<ActionResult> {
  return runLong(["merge", String(agent)]);
}

export function diff(
  agent: number,
  mode?: "stat" | "files" | "full"
): Promise<ActionResult> {
  const args = ["diff", String(agent)];
  if (mode === "stat") args.push("--stat");
  else if (mode === "files") args.push("--files");
  return runLong(args);
}

export function log(agent: number): Promise<ActionResult> {
  return runLong(["log", String(agent)]);
}
