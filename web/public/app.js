// --- State ---

let currentState = null;
const agentInputValues = {}; // { agentId: string } — preserve typed text per agent across re-renders

// --- SSE ---

function connectSSE() {
  const source = new EventSource("/api/events");
  source.onmessage = (event) => {
    try {
      currentState = JSON.parse(event.data);
      render(currentState);
    } catch {}
  };
  source.onerror = () => {
    source.close();
    setTimeout(connectSSE, 3000);
  };
}

connectSSE();

// --- API helpers ---

async function api(endpoint, body) {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) {
      toast(data.output || "Done", "success");
    } else {
      toast(data.output || "Failed", "error");
    }
    if (data.output && data.output.length > 100) {
      showOutputModal(endpoint.split("/").pop(), data.output);
    }
    return data;
  } catch (e) {
    toast("Request failed: " + e.message, "error");
  }
}

async function apiGet(endpoint) {
  try {
    const res = await fetch(endpoint);
    const data = await res.json();
    if (!data.ok) {
      toast(data.output || "Request failed", "error");
    }
    return data;
  } catch (e) {
    toast("Request failed: " + e.message, "error");
    return { ok: false, output: e.message };
  }
}

// --- Rendering ---

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function renderAgent(agent) {
  const totalTokens = agent.tokens.input + agent.tokens.output;
  const task = agent.task || "(no task)";

  let checksHtml;
  if (agent.checks) {
    if (agent.checks.overall === "pass") {
      checksHtml = `<span class="checks-pass">&#10003; pass</span>`;
    } else {
      checksHtml = `<span class="checks-fail">&#10007; fail</span>`;
    }
  } else {
    checksHtml = `<span class="checks-none">&ndash; &ndash;</span>`;
  }

  const outputLines = (agent.paneOutput || []).map((l) => escapeHtml(l)).join("\n");
  const inputVal = escapeAttr(agentInputValues[agent.id] || "");

  return `
    <div class="agent-card" data-health="${agent.health}" data-agent="${agent.id}">
      <div class="agent-header">
        <div class="agent-title">
          <span class="status-dot ${agent.status}"></span>
          <span class="agent-num">#${agent.id}</span>
          <span>${escapeHtml(truncate(task, 30))}</span>
        </div>
      </div>
      <div class="agent-stats">
        <span>${agent.status}</span>
        <span class="stat-changes">${agent.changes.files}f <span class="insertions">+${agent.changes.insertions}</span><span class="deletions">-${agent.changes.deletions}</span></span>
        <span>${checksHtml}</span>
        <span>${formatTokens(totalTokens)} tok</span>
      </div>
      <div class="agent-output" id="output-${agent.id}"><pre>${outputLines}</pre></div>
      <div class="agent-input">
        <input type="text" placeholder="Message to agent ${agent.id}..." value="${inputVal}" oninput="agentInputValues[${agent.id}]=this.value" onkeydown="if(event.key==='Enter'){sendMessage(${agent.id}, this.value); this.value=''; agentInputValues[${agent.id}]='';}" id="send-input-${agent.id}">
      </div>
      <div class="agent-actions">
        <button class="btn btn-sm" onclick="runCheck(${agent.id})">Check</button>
        <button class="btn btn-sm" onclick="showDiff(${agent.id})">Diff</button>
        <button class="btn btn-sm" onclick="showLog(${agent.id})">Log</button>
        <button class="btn btn-sm" onclick="confirmAction('Ship agent ${agent.id}?', () => api('/api/ship', {agent: ${agent.id}}))">Ship</button>
        <button class="btn btn-sm" onclick="runCommit(${agent.id})">Commit</button>
      </div>
    </div>
  `;
}

function render(state) {
  const grid = document.getElementById("agent-grid");
  const sessionInfo = document.getElementById("session-info");
  const summaryText = document.getElementById("summary-text");

  if (!state || state.numAgents === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <h2>No active swarm</h2>
        <p>Run <code>swarm up -n N</code> to start agents, then <code>swarm dash</code></p>
      </div>
    `;
    sessionInfo.textContent = "";
    summaryText.textContent = "";
    return;
  }

  sessionInfo.textContent = `session: ${state.session}  \u00b7  ${state.layout}  \u00b7  ${state.numAgents} agents`;

  // Save focused input id + cursor position before re-render
  const activeEl = document.activeElement;
  const focusedId = activeEl && activeEl.id && activeEl.id.startsWith("send-input-") ? activeEl.id : null;
  const cursorPos = focusedId ? activeEl.selectionStart : null;

  grid.innerHTML = state.agents.map(renderAgent).join("");

  // Auto-scroll terminal output areas to bottom
  for (const agent of state.agents) {
    const outputEl = document.getElementById(`output-${agent.id}`);
    if (outputEl) outputEl.scrollTop = outputEl.scrollHeight;
  }

  // Restore focus to the input that was active before re-render
  if (focusedId) {
    const input = document.getElementById(focusedId);
    if (input) {
      input.focus();
      if (cursorPos !== null) input.setSelectionRange(cursorPos, cursorPos);
    }
  }

  // Summary bar
  const parts = [];
  if (state.summary.readyToShip.length > 0)
    parts.push(`Ready: ${state.summary.readyToShip.join(",")}`);
  if (state.summary.needsFixing.length > 0)
    parts.push(`Needs fix: ${state.summary.needsFixing.join(",")}`);
  if (state.summary.stuck.length > 0)
    parts.push(`Stuck: ${state.summary.stuck.join(",")}`);
  parts.push(`Total: ${formatTokens(state.summary.totalTokens)} tokens`);
  summaryText.textContent = parts.join("  \u00b7  ");
}

// --- Actions ---

function sendMessage(agentId, message) {
  if (!message || !message.trim()) return;
  api("/api/send", { agent: agentId, message: message.trim() });
}

async function runCheck(agentId) {
  toast(`Running checks on agent ${agentId}...`, "success");
  await api("/api/check", { agent: agentId });
}

async function runCommit(agentId) {
  const msg = prompt(`Commit message for agent ${agentId} (optional):`);
  if (msg === null) return; // cancelled
  await api("/api/commit", { agent: agentId, message: msg || undefined });
}

async function showDiff(agentId) {
  const data = await apiGet(`/api/diff/${agentId}`);
  showOutputModal(`Diff \u2014 Agent ${agentId}`, data.output || "(no changes)");
}

async function showLog(agentId) {
  const data = await apiGet(`/api/log/${agentId}`);
  showOutputModal(`Log \u2014 Agent ${agentId}`, data.output || "(no log)");
}

// --- Plan modal ---

function showPlanModal() {
  document.getElementById("plan-modal").classList.add("active");
  document.getElementById("plan-input").focus();
}

async function submitPlan() {
  const text = document.getElementById("plan-input").value.trim();
  if (!text) return;
  const tasks = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (tasks.length === 0) return;
  closeModal("plan-modal");
  document.getElementById("plan-input").value = "";
  await api("/api/plan", { tasks });
}

// --- Output modal ---

function showOutputModal(title, content) {
  document.getElementById("output-modal-title").textContent = title;
  document.getElementById("output-modal-content").textContent = content;
  document.getElementById("output-modal").classList.add("active");
}

function closeModal(id) {
  document.getElementById(id).classList.remove("active");
}

// Close modals on Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".modal-overlay.active").forEach((m) => {
      m.classList.remove("active");
    });
  }
});

// Close modals on overlay click
document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.classList.remove("active");
    }
  });
});

// --- Confirmation ---

function confirmAction(message, action) {
  if (confirm(message)) {
    action();
  }
}

// --- Toast ---

function toast(message, type) {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = truncate(message, 120);
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.3s";
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

// --- Utilities ---

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function truncate(str, len) {
  if (str.length <= len) return str;
  return str.slice(0, len) + "...";
}
