import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readSwarmState, watchState } from "./state.js";
import * as actions from "./actions.js";

const PORT = 7777;
const HOST = "127.0.0.1";
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
};

// --- SSE ---

type SSEClient = ServerResponse;
const sseClients = new Set<SSEClient>();

function broadcastState(stateJson: string) {
  for (const client of sseClients) {
    client.write(`data: ${stateJson}\n\n`);
  }
}

// --- Body parser ---

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((done) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => {
      try {
        done(JSON.parse(data));
      } catch {
        done({});
      }
    });
  });
}

// --- Static files ---

async function serveStatic(res: ServerResponse, urlPath: string) {
  const filePath = resolve(PUBLIC_DIR, urlPath === "/" ? "index.html" : "." + urlPath);
  // Prevent path traversal — resolved path must be inside PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR + "/") && filePath !== PUBLIC_DIR) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }
  try {
    const content = await readFile(filePath);
    const mime = MIME_TYPES[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

// --- JSON response helpers ---

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

// --- Routes ---

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, `http://${HOST}`);
  const path = url.pathname;
  const method = req.method!;

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // SSE endpoint
  if (path === "/api/events" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));

    // Send initial state immediately
    try {
      const state = await readSwarmState();
      res.write(`data: ${JSON.stringify(state)}\n\n`);
    } catch {}
    return;
  }

  // State snapshot
  if (path === "/api/state" && method === "GET") {
    try {
      const state = await readSwarmState();
      json(res, 200, state);
    } catch (e) {
      json(res, 500, { ok: false, output: String(e) });
    }
    return;
  }

  // POST actions
  if (method === "POST") {
    const body = await readBody(req);

    let result: actions.ActionResult | undefined;

    switch (path) {
      case "/api/send":
        result = await actions.send(body.agent as number, body.message as string);
        break;
      case "/api/task":
        result = await actions.task(body.agent as number, body.description as string);
        break;
      case "/api/plan":
        result = await actions.plan(body.tasks as string[]);
        break;
      case "/api/check":
        result = await actions.check(body.agent as number);
        break;
      case "/api/check-all":
        result = await actions.checkAll();
        break;
      case "/api/check-fix":
        result = await actions.checkFix(body.agent as number);
        break;
      case "/api/commit":
        result = await actions.commit(body.agent as number, body.message as string | undefined);
        break;
      case "/api/ship":
        result = await actions.ship(body.agent as number);
        break;
      case "/api/ship-all":
        result = await actions.shipAll();
        break;
      case "/api/merge":
        result = await actions.merge(body.agent as number);
        break;
      default:
        break;
    }

    if (result) {
      json(res, result.ok ? 200 : 500, result);
      return;
    }
  }

  // GET read-only endpoints
  if (method === "GET") {
    const diffMatch = path.match(/^\/api\/diff\/(\d+)$/);
    if (diffMatch) {
      const agent = parseInt(diffMatch[1], 10);
      const mode = (url.searchParams.get("mode") as "stat" | "files" | "full") || undefined;
      const result = await actions.diff(agent, mode);
      json(res, result.ok ? 200 : 500, result);
      return;
    }

    const logMatch = path.match(/^\/api\/log\/(\d+)$/);
    if (logMatch) {
      const agent = parseInt(logMatch[1], 10);
      const result = await actions.log(agent);
      json(res, result.ok ? 200 : 500, result);
      return;
    }
  }

  // Static files
  if (method === "GET" && !path.startsWith("/api/")) {
    await serveStatic(res, path);
    return;
  }

  json(res, 404, { ok: false, output: "Not found" });
}

// --- Start ---

const server = createServer(handleRequest);

// Watch state and broadcast
const stopWatch = watchState((state) => {
  broadcastState(JSON.stringify(state));
});

server.listen(PORT, HOST, () => {
  console.log(`Swarm dashboard: http://${HOST}:${PORT}`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  stopWatch();
  server.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopWatch();
  server.close();
  process.exit(0);
});
