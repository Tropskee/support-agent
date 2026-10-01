// Plain ES module. No framework, no build step.

const TABS = [
  { id: "inbox", label: "Inbox", status: "new" },
  { id: "resolved", label: "Resolved", status: "resolved" },
  { id: "escalated", label: "Escalated", status: "escalated" },
  { id: "eval", label: "Eval", status: null },
];

const REASON_TEXT = {
  p1: "Triaged as P1 — top priority, needs a human before anything goes out.",
  money_over_limit: "Proposes a payout over the automatic limit.",
  grade_or_authenticity: "Proposes a grade or authenticity change.",
  low_confidence: "The model wasn't confident enough to send this automatically.",
  bad_citation: "Cited something that isn't in the ticket's context.",
  error: "The agent failed to produce a valid response.",
};

const state = {
  tab: "inbox",
  stats: null,
  lists: { new: [], resolved: [], escalated: [] },
  selected: { inbox: null, resolved: null, escalated: null, eval: null },
  mobileDetail: { inbox: false, resolved: false, escalated: false, eval: false },
  detailCache: new Map(), // ticket id -> { ticket, attempts, reviews, context }
  attemptIndex: {}, // ticket id -> selected attempt index
  editingDraft: false,
  draftValue: null, // live #draft-edit text, carried across re-renders while editingDraft is true
  retryNotesValue: null, // live #retry-notes text, carried across re-renders while the retry modal is open
  resolvedFilter: "all", // "all" | "P1".."P5"
  escalatedFilter: "needs", // "needs" | "approved"
  // Scroll position bookkeeping, per tab, so re-rendering a list or detail pane (selecting a
  // row, a progress tick, a stats refresh) doesn't snap either pane back to the top. See
  // captureScroll/restoreScroll below.
  listScroll: { inbox: 0, resolved: 0, escalated: 0, eval: 0 },
  detailScroll: { inbox: 0, resolved: 0, escalated: 0, eval: 0 },
  detailScrollTicket: { inbox: null, resolved: null, escalated: null, eval: null },
  // Per-ticket in-flight state for run/retry/approve requests: ticket id -> "running" |
  // "retrying" | "approving". Drives the disabled label/spinner on that ticket's own button
  // across re-renders (progress ticks, refreshes), so a second click while the first request
  // is still pending is ignored instead of firing a second request.
  inFlight: {},
  modal: null, // { type: "retry", ticketId } | { type: "eval-confirm" }
  error: null,
  notice: null, // brief neutral banner message, e.g. after a 409 "already run"
  evalRuns: [],
  evalSelectedRunId: null,
  evalCurrentRun: null, // { run, totals, results }
  evalRunning: false,
  evalStartedAt: null,
  evalFilter: "all", // "all" | "misses" | "unfaithful" | "escalation" | "priority"
  evalDetailCache: new Map(), // "runId:ticketId" -> snapshot from GET /eval/runs/:id/results/:ticketId
  runAll: null, // { total, done, resolved, escalated, skipped, errors: [], stopRequested }
};

let evalPollTimer = null;
let evalElapsedTimer = null;

// The Stop button for "Run agent on all": created once per run and re-parented into whatever
// the latest render produced, rather than rebuilt from an HTML string on every progress tick -
// see the comment on syncRunAllControl below for why that distinction matters.
let runAllProgressEl = null;

////////////////
// UTILITIES  //
////////////////

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function qs(id) {
  return document.getElementById(id);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    // no body, or not JSON
  }
  if (!res.ok) {
    const err = new Error((body && (body.error || JSON.stringify(body))) || res.statusText);
    err.status = res.status;
    throw err;
  }
  return body;
}

function postJson(path, body) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function parseJsonSafe(s, fallback) {
  if (s == null) return fallback;
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function fmtMoney(usd) {
  if (usd == null) return "$0.0000";
  return `$${Number(usd).toFixed(4)}`;
}

function fmtMoneyShort(usd) {
  if (usd == null) return "$0.00";
  return `$${Number(usd).toFixed(2)}`;
}

function fmtTokens(n) {
  if (n == null) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Compact, single-line time ("3:28pm") — the locale "03:28 PM" form wraps onto two
// lines in a narrow column because of the space before AM/PM.
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${m}${ap}`;
}

function fmtLatency(ms) {
  if (ms == null) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtElapsed(startedAt) {
  if (!startedAt) return "";
  const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

function orderIdOf(t) {
  const m = `${t.subject || ""} ${t.body || ""}`.match(/CG-\d{4,6}/);
  return m ? m[0] : null;
}

const VALID_PRIORITIES = new Set(["P1", "P2", "P3", "P4", "P5"]);

function priClass(p) {
  if (!p) return "none";
  const s = String(p).toUpperCase();
  return VALID_PRIORITIES.has(s) ? s.toLowerCase() : "none";
}

function priBadge(p) {
  return `<span class="pri ${priClass(p)}">${esc(p || "—")}</span>`;
}

function firstLine(s) {
  return String(s ?? "").split("\n")[0];
}

function formatAction(a) {
  const amount = a.amount_usd != null ? ` $${a.amount_usd}` : "";
  return `${a.type}${amount} — ${a.detail || ""}`;
}

function emptyState(text, hint) {
  return `<div class="empty"><div>${esc(text)}</div>${hint ? `<div class="hint">${esc(hint)}</div>` : ""}</div>`;
}

////////////////////
// ERROR BANNER   //
////////////////////

function showError(message) {
  state.error = String(message);
  renderErrorBanner();
}

function hideError() {
  state.error = null;
  renderErrorBanner();
}

function renderErrorBanner() {
  const banner = qs("error-banner");
  if (!banner) return;
  banner.hidden = !state.error;
  qs("error-banner-text").textContent = state.error || "";
}

/////////////////////
// NOTICE BANNER   //
/////////////////////

let noticeDismissTimer = null;

// A brief, non-error notice, e.g. after a run/retry/approve request loses a race with
// another click and comes back 409 ("already running or not runnable"). Auto-dismisses so
// it never lingers like a real error would.
function showNotice(message, { autoDismissMs = 5000 } = {}) {
  state.notice = String(message);
  renderNoticeBanner();
  if (noticeDismissTimer) clearTimeout(noticeDismissTimer);
  if (autoDismissMs) {
    noticeDismissTimer = setTimeout(hideNotice, autoDismissMs);
  }
}

function hideNotice() {
  if (noticeDismissTimer) {
    clearTimeout(noticeDismissTimer);
    noticeDismissTimer = null;
  }
  state.notice = null;
  renderNoticeBanner();
}

function renderNoticeBanner() {
  const banner = qs("notice-banner");
  if (!banner) return;
  banner.hidden = !state.notice;
  qs("notice-banner-text").textContent = state.notice || "";
}

////////////////
// CONTEXT    //
////////////////

// Renders a context block's body as readable lines instead of one run-on paragraph:
// "key: value" lines become a definition list, "heading:" lines become a small caps
// label, "- " lines become a bullet or (when pipe-delimited) a compact row of cells.
function renderContextLines(body) {
  const lines = String(body ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  let html = "";
  let kvBuffer = [];
  let itemBuffer = [];

  const flushKv = () => {
    if (kvBuffer.length === 0) return;
    html += `<dl class="ctx-kv">${kvBuffer.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
    kvBuffer = [];
  };
  const flushItems = () => {
    if (itemBuffer.length === 0) return;
    // lookup.ts's bullet lines are "<field> | <field> | ..." with a literal " | " between
    // fields (never a bare "|"), so splitting on that exact separator is what keeps a
    // hyphenated submission id ("6-0"), an apostrophe in a card name ("Rocket's"), or a
    // hyphenated set/cert code ("gym1-18") intact within its own cell.
    const hasPipes = itemBuffer.some((i) => i.includes(" | "));
    if (hasPipes) {
      html += `<table class="ctx-items">${itemBuffer
        .map((i) => `<tr>${i.split(" | ").map((c) => `<td>${esc(c.trim())}</td>`).join("")}</tr>`)
        .join("")}</table>`;
    } else {
      html += `<ul class="ctx-items-list">${itemBuffer.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
    }
    itemBuffer = [];
  };

  for (const line of lines) {
    if (line.startsWith("- ")) {
      flushKv();
      itemBuffer.push(line.slice(2));
      continue;
    }
    flushItems();
    const headingMatch = line.match(/^([A-Za-z0-9 _]+):$/);
    if (headingMatch) {
      flushKv();
      html += `<div class="ctx-heading">${esc(headingMatch[1])}</div>`;
      continue;
    }
    const kvMatch = line.match(/^([^:]{1,40}):\s+(.*)$/);
    if (kvMatch) {
      kvBuffer.push([kvMatch[1], kvMatch[2]]);
      continue;
    }
    flushKv();
    html += `<div class="ctx-text">${esc(line)}</div>`;
  }
  flushKv();
  flushItems();
  return html || `<div class="ctx-text">${esc(body)}</div>`;
}

function renderContextBlock(block) {
  return `<div class="ctx-block"><span class="tag">${esc(block.label)}</span><div class="ctx-lines">${renderContextLines(block.body)}</div></div>`;
}

////////////////
// DATA LOADS //
////////////////

async function loadStats() {
  state.stats = await api("/stats");
}

async function loadList(status) {
  const items = await api(`/tickets?status=${status}`);
  state.lists[status] = items;
}

async function loadDetail(id, { force = false } = {}) {
  if (!force && state.detailCache.has(id)) return state.detailCache.get(id);
  const detail = await api(`/tickets/${id}`);
  state.detailCache.set(id, detail);
  return detail;
}

async function refreshAll() {
  await Promise.all([loadStats(), loadList("new"), loadList("resolved"), loadList("escalated")]);
}

// Refreshes stats plus whatever the active tab needs, so switching tabs never shows
// stale counts or a stale list.
async function refreshTab(tab) {
  const jobs = [loadStats()];
  if (tab === "inbox") jobs.push(loadList("new"));
  else if (tab === "resolved") jobs.push(loadList("resolved"));
  else if (tab === "escalated") jobs.push(loadList("escalated"), loadList("resolved"));
  else if (tab === "eval") jobs.push(loadEvalRuns());
  await Promise.all(jobs);
}

////////////////
// RENDERING  //
////////////////

// render() replaces each pane's innerHTML; capture and restore scrollTop per tab so
// re-renders don't jump to the top.
function captureScroll(tab) {
  const rowsEl = qs(`${tab}-list`)?.querySelector(".rows");
  if (rowsEl) state.listScroll[tab] = rowsEl.scrollTop;
  const detailEl = qs(`${tab}-detail`);
  if (detailEl) state.detailScroll[tab] = detailEl.scrollTop;
}

// selectedId identifies which ticket the detail pane is now showing. When it's the same
// ticket as before, the detail pane keeps its scroll position; when it changed (or there
// is none), the detail pane starts at its top, same as a freshly opened ticket should.
function restoreScroll(tab, selectedId) {
  const rowsEl = qs(`${tab}-list`)?.querySelector(".rows");
  if (rowsEl) {
    rowsEl.scrollTop = state.listScroll[tab] || 0;
    if (selectedId != null) {
      const row = Array.from(rowsEl.querySelectorAll("[data-select]")).find(
        (r) => r.dataset.select === String(selectedId)
      );
      row?.scrollIntoView({ block: "nearest" });
    }
  }

  const detailEl = qs(`${tab}-detail`);
  if (detailEl) {
    const sameTicket = selectedId != null && state.detailScrollTicket[tab] === selectedId;
    detailEl.scrollTop = sameTicket ? state.detailScroll[tab] || 0 : 0;
    state.detailScrollTicket[tab] = selectedId;
  }
}

function render() {
  const tab = state.tab;
  captureScroll(tab);

  renderErrorBanner();
  renderNoticeBanner();
  renderTabs();
  renderMeter();
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("on"));
  qs(`screen-${state.tab}`)?.classList.add("on");

  if (state.tab === "inbox") renderInbox();
  else if (state.tab === "resolved") renderResolved();
  else if (state.tab === "escalated") renderEscalated();
  else if (state.tab === "eval") renderEval();

  renderModal();
  restoreScroll(tab, state.selected[tab] ?? null);
}

function renderTabs() {
  const counts = state.stats?.byStatus || {};
  qs("tabs").innerHTML = TABS.map((t) => {
    const count = t.status ? (counts[t.status] ?? state.lists[t.status]?.length ?? 0) : null;
    return `<button class="tab ${state.tab === t.id ? "on" : ""}" data-tab="${esc(t.id)}">${esc(t.label)}${
      count != null ? `<span class="count">${count}</span>` : ""
    }</button>`;
  }).join("");
}

function renderMeter() {
  const s = state.stats;
  if (!s) {
    qs("meter").innerHTML = "";
    return;
  }
  qs("meter").innerHTML = `
    <span>Model <b class="mono">${esc(s.model)}</b></span>
    <span>Spend <b>${fmtMoney(s.totalCostUsd)}</b></span>
    <span class="meter-tokens">Tokens <b>${fmtTokens(s.totalTokens)}</b></span>
  `;
}

function backButton(tab) {
  return `<button class="btn back-btn" data-action="mobile-back" data-tab="${esc(tab)}">‹ Back</button>`;
}

function applyMobileClass(bodyId, tab) {
  qs(bodyId)?.classList.toggle("show-detail", !!state.mobileDetail[tab]);
}

//////////////
// INBOX    //
//////////////

function renderInbox() {
  const items = state.lists.new || [];
  const selectedId = state.selected.inbox && items.some((t) => t.id === state.selected.inbox)
    ? state.selected.inbox
    : items[0]?.id || null;
  state.selected.inbox = selectedId;

  qs("inbox-list").innerHTML = `
    <div class="filters">
      <span class="chip on">All ${items.length}</span>
      <div class="spacer"></div>
      <div id="run-all-slot"></div>
    </div>
    <div class="rows">${
      items.length === 0
        ? emptyState("Inbox is empty.", "New tickets will show up here as they arrive.")
        : items.map((t) => rowHtml(t, selectedId, "time", true)).join("")
    }</div>
  `;
  syncRunAllControl();

  const detailEl = qs("inbox-detail");
  const ticket = items.find((t) => t.id === selectedId);
  if (!ticket) {
    detailEl.innerHTML = emptyState("Select a ticket.");
  } else {
    renderInboxDetail(ticket, detailEl);
  }
  applyMobileClass("body-inbox", "inbox");
}

// The progress control is created once per run and re-parented on each render, so a
// click on Stop never lands on a detached node.
function syncRunAllControl() {
  const slot = qs("run-all-slot");
  if (!slot) return;
  const ra = state.runAll;

  if (!ra) {
    runAllProgressEl = null;
    const anyTicketInFlight = Object.keys(state.inFlight).length > 0;
    slot.innerHTML = `<button class="btn primary" data-action="run-all" ${anyTicketInFlight ? "disabled" : ""}>Run agent on all</button>`;
    return;
  }

  if (!runAllProgressEl) {
    runAllProgressEl = document.createElement("div");
    runAllProgressEl.className = "run-all-progress";
    runAllProgressEl.innerHTML = `<span class="spin"></span><span class="label"></span><button class="btn" data-action="stop-run-all"></button>`;
  }
  if (runAllProgressEl.parentElement !== slot) {
    slot.appendChild(runAllProgressEl);
  }

  const skipped = ra.skipped ? ` · ${ra.skipped} skipped` : "";
  runAllProgressEl.querySelector(".label").textContent =
    `Running ${ra.done} / ${ra.total} · ${ra.resolved} resolved · ${ra.escalated} escalated${skipped}`;
  const stopBtn = runAllProgressEl.querySelector('[data-action="stop-run-all"]');
  stopBtn.disabled = ra.stopRequested;
  stopBtn.textContent = ra.stopRequested ? "Stopping…" : "Stop";
}

function rowHtml(t, selectedId, whenKind, isInbox) {
  const order = orderIdOf(t);
  const when = whenKind === "time" ? fmtTime(t.received_at) : fmtLatency(t.latency_ms);
  const badge = t.status === "running"
    ? '<span class="status running">Running</span>'
    : isInbox && !t.priority
      ? '<span class="dot" title="Not yet triaged"></span>'
      : priBadge(t.priority);
  return `
    <div class="row ${t.id === selectedId ? "sel" : ""}" data-select="${esc(t.id)}">
      ${badge}
      <div class="rowtext">
        <div class="subj">${esc(t.subject)}</div>
        <div class="from">${esc(t.sender_email)}${order ? ` · Order ${esc(order)}` : ""}</div>
      </div>
      <div class="when">${esc(when)}</div>
    </div>
  `;
}

function renderInboxDetail(t, el) {
  const cached = state.detailCache.get(t.id);
  const order = orderIdOf(t);
  const context = cached?.context || [];
  const running = state.inFlight[t.id] === "running";
  el.innerHTML = `
    ${backButton("inbox")}
    <h2>${esc(t.subject)}</h2>
    <div class="meta">
      <span>${esc(t.sender_email)}</span>
      ${order ? `<span>Order ${esc(order)}</span>` : ""}
      <span>Received ${esc(fmtTime(t.received_at))}</span>
      <span class="mono">${esc(t.id)}</span>
    </div>
    <div class="msg">${esc(t.body)}</div>
    <div class="panel"><h4>Account on file (prefetched)</h4>
      <div id="inbox-context-body">
      ${
        context.length === 0
          ? '<div style="color:var(--text-3)">Loading…</div>'
          : context.map((b) => renderContextBlock(b)).join("")
      }
      </div>
    </div>
    <div class="actions">
      <button class="btn primary" data-action="run-ticket" data-id="${esc(t.id)}" ${running || state.runAll || t.status === "running" ? "disabled" : ""}>
        ${running ? '<span class="spin"></span>Running…' : "Run agent on this ticket"}
      </button>
    </div>
  `;
  if (!cached) {
    loadDetail(t.id)
      .then(() => {
        if (state.tab === "inbox" && state.selected.inbox === t.id) render();
      })
      .catch((err) => {
        showError(err.message || String(err));
        const body = qs("inbox-context-body");
        if (body) body.innerHTML = `<div style="color:var(--text-3)">Couldn't load account details: ${esc(err.message || String(err))}</div>`;
      });
  }
}

//////////////
// RESOLVED //
//////////////

function renderResolved() {
  const all = state.lists.resolved || [];
  const items = state.resolvedFilter === "all" ? all : all.filter((t) => t.priority === state.resolvedFilter);
  const selectedId = state.selected.resolved && items.some((t) => t.id === state.selected.resolved)
    ? state.selected.resolved
    : items[0]?.id || null;
  state.selected.resolved = selectedId;

  const priorities = ["P1", "P2", "P3", "P4", "P5"];
  qs("resolved-list").innerHTML = `
    <div class="filters">
      <span class="chip ${state.resolvedFilter === "all" ? "on" : ""}" data-filter-resolved="all">All ${all.length}</span>
      ${priorities.map((p) => {
        const n = all.filter((t) => t.priority === p).length;
        return n ? `<span class="chip ${state.resolvedFilter === p ? "on" : ""}" data-filter-resolved="${p}">${p}</span>` : "";
      }).join("")}
    </div>
    <div class="rows">${
      items.length === 0
        ? emptyState("No resolved tickets yet.", "Run the agent on an inbox ticket to see one here.")
        : items.map((t) => rowHtml(t, selectedId, "latency", false)).join("")
    }</div>
  `;

  const detailEl = qs("resolved-detail");
  const ticket = items.find((t) => t.id === selectedId);
  if (!ticket) {
    detailEl.innerHTML = emptyState("Select a ticket.");
  } else {
    renderResolvedDetail(ticket, detailEl);
  }
  applyMobileClass("body-resolved", "resolved");
}

function currentAttempt(detail) {
  if (!detail || !detail.attempts?.length) return null;
  const a = detail.attempts.find((a) => a.id === detail.ticket.current_attempt_id);
  return a || detail.attempts[detail.attempts.length - 1];
}

function citedEvidence(attempt) {
  const citations = parseJsonSafe(attempt?.citations_json, []) || [];
  const blocks = parseJsonSafe(attempt?.context_json, []) || [];
  return citations.map((label) => {
    const block = blocks.find((b) => b.label === label) || blocks.find((b) => b.label?.includes(label));
    return { label, body: block ? firstLine(block.body) : "" };
  });
}

function reviewFor(detail, attemptId) {
  return (detail.reviews || []).find((r) => r.attempt_id === attemptId && (r.action === "approve" || r.action === "edit"));
}

function renderResolvedDetail(t, el) {
  const cached = state.detailCache.get(t.id);
  if (!cached) {
    el.innerHTML = emptyState("Loading…");
    loadDetail(t.id)
      .then(() => {
        if (state.tab === "resolved" && state.selected.resolved === t.id) render();
      })
      .catch((err) => {
        showError(err.message || String(err));
        if (state.tab === "resolved" && state.selected.resolved === t.id) {
          el.innerHTML = emptyState("Couldn't load this ticket.", err.message || String(err));
        }
      });
    return;
  }

  const attempt = currentAttempt(cached);
  if (!attempt) {
    el.innerHTML = emptyState("No attempt recorded.");
    return;
  }

  const expected = cached.ticket.expected_priority;
  const matchLabel = expected
    ? (expected === attempt.priority
        ? '<span class="check">✓ matches label</span>'
        : `<span class="miss">✗ label ${esc(expected)}</span>`)
    : "";

  const actions = parseJsonSafe(attempt.proposed_actions_json, []) || [];
  const evidence = citedEvidence(attempt);
  const review = reviewFor(cached, attempt.id);
  const finalReply = review ? (review.action === "edit" && review.edited_reply ? review.edited_reply : attempt.reply_text) : attempt.reply_text;
  const reasons = parseJsonSafe(attempt.guardrail_reasons_json, []) || [];
  const escalateText =
    attempt.guardrail_result === "escalate"
      ? `Held for review (${reasons.map((r) => r.reason).join(", ") || "reason unknown"}), approved by reviewer`
      : "No, no guardrail tripped";

  el.innerHTML = `
    ${backButton("resolved")}
    <h2>${esc(t.subject)}</h2>
    <div class="meta">
      <span>${esc(t.sender_email)}</span>
      ${orderIdOf(t) ? `<span>Order ${esc(orderIdOf(t))}</span>` : ""}
      <span class="mono">${esc(t.id)}</span>
      <span class="status sent">${review ? "Approved by reviewer" : "Sent automatically"}</span>
    </div>
    <div class="msg">${esc(t.body)}</div>
    <div class="grid2">
      <div class="panel"><h4>Decision</h4>
        <dl class="kv">
          <dt>Priority</dt><dd>${priBadge(attempt.priority)} ${matchLabel}</dd>
          <dt>Escalate</dt><dd>${esc(escalateText)}</dd>
          <dt>Confidence</dt><dd>${attempt.confidence != null ? attempt.confidence : "—"}</dd>
          <dt>Actions</dt><dd>${actions.length ? actions.map((a) => esc(formatAction(a))).join("<br>") : "—"}</dd>
        </dl>
      </div>
      <div class="panel"><h4>Evidence cited</h4>
        ${evidence.length ? evidence.map((e) => `<div class="ev"><span class="tag">${esc(e.label)}</span>${esc(e.body)}</div>`).join("") : '<div style="color:var(--text-3)">No citations recorded.</div>'}
      </div>
    </div>
    <div class="reply">
      <div class="hd">
        <span>${review ? "Final reply" : "Reply sent"}</span>
        <span class="mono">${attempt.input_tokens ?? 0} in / ${attempt.output_tokens ?? 0} out · ${fmtMoney(attempt.cost_usd)} · ${fmtLatency(attempt.latency_ms)}</span>
      </div>
      <div class="reply-text">${esc(finalReply)}</div>
    </div>
    <details class="trace"><summary>How it got here: prompt context and raw output</summary><pre>${esc(
      JSON.stringify(
        {
          context: parseJsonSafe(attempt.context_json, []),
          raw_response: (() => {
            const parsed = parseJsonSafe(attempt.raw_response, null);
            return parsed !== null ? parsed : attempt.raw_response;
          })(),
        },
        null,
        2
      )
    )}</pre></details>
  `;
}

///////////////
// ESCALATED //
///////////////

function renderEscalated() {
  const needs = state.lists.escalated || [];
  const approved = (state.lists.resolved || []).filter((t) => (t.approved_count ?? 0) > 0);
  const items = state.escalatedFilter === "needs" ? needs : approved;

  const selectedId = state.selected.escalated && items.some((t) => t.id === state.selected.escalated)
    ? state.selected.escalated
    : items[0]?.id || null;
  state.selected.escalated = selectedId;

  qs("escalated-list").innerHTML = `
    <div class="filters">
      <span class="chip ${state.escalatedFilter === "needs" ? "on" : ""}" data-filter-escalated="needs">Needs review ${needs.length}</span>
      <span class="chip ${state.escalatedFilter === "approved" ? "on" : ""}" data-filter-escalated="approved">Approved ${approved.length}</span>
    </div>
    <div class="rows">${
      items.length === 0
        ? emptyState("Nothing here.", state.escalatedFilter === "needs" ? "Escalated tickets will land in this queue." : "Approved tickets will show up once reviewed.")
        : items.map((t) => rowHtmlEscalated(t, selectedId)).join("")
    }</div>
  `;

  const detailEl = qs("escalated-detail");
  const ticket = items.find((t) => t.id === selectedId);
  if (!ticket) {
    detailEl.innerHTML = emptyState("Select a ticket.");
  } else {
    renderEscalatedDetail(ticket, detailEl);
  }
  applyMobileClass("body-escalated", "escalated");
}

function rowHtmlEscalated(t, selectedId) {
  const reasons = parseJsonSafe(t.guardrail_reasons_json, []) || [];
  const reasonText = reasons.map((r) => r.reason).join(", ");
  return `
    <div class="row ${t.id === selectedId ? "sel" : ""}" data-select="${esc(t.id)}">
      ${priBadge(t.priority)}
      <div class="rowtext">
        <div class="subj">${esc(t.subject)}</div>
        <div class="from">${esc(t.sender_email)}${reasonText ? ` · reason: ${esc(reasonText)}` : ""}</div>
      </div>
      <div class="when">${esc(fmtLatency(t.latency_ms))}</div>
    </div>
  `;
}

function renderEscalatedDetail(t, el) {
  const cached = state.detailCache.get(t.id);
  if (!cached) {
    el.innerHTML = emptyState("Loading…");
    loadDetail(t.id)
      .then(() => {
        if (state.tab === "escalated" && state.selected.escalated === t.id) render();
      })
      .catch((err) => {
        showError(err.message || String(err));
        if (state.tab === "escalated" && state.selected.escalated === t.id) {
          el.innerHTML = emptyState("Couldn't load this ticket.", err.message || String(err));
        }
      });
    return;
  }

  const attempts = cached.attempts || [];
  const idx = state.attemptIndex[t.id] != null ? state.attemptIndex[t.id] : attempts.length - 1;
  const attempt = attempts[idx] || attempts[attempts.length - 1];
  if (!attempt) {
    el.innerHTML = emptyState("No attempt recorded.");
    return;
  }
  const ticketInFlight = state.inFlight[t.id];
  const approving = ticketInFlight === "approving";

  const review = reviewFor(cached, attempt.id);
  const isApproved = !!review;
  const isCurrent = attempt.id === cached.ticket.current_attempt_id;
  const reasons = parseJsonSafe(attempt.guardrail_reasons_json, []) || [];
  const actions = parseJsonSafe(attempt.proposed_actions_json, []) || [];
  const evidence = citedEvidence(attempt);
  const draftText = review ? (review.action === "edit" && review.edited_reply ? review.edited_reply : attempt.reply_text) : attempt.reply_text;
  // Run-all progress ticks call render() repeatedly while a person may be mid-edit here; a
  // rebuilt #draft-edit with its original value would silently wipe what they just typed.
  // Carry the live value across this rebuild instead of resetting it from draftText.
  if (state.editingDraft && isCurrent) {
    const existing = el.querySelector("#draft-edit");
    if (existing) state.draftValue = existing.value;
  }
  const textareaValue = state.editingDraft && state.draftValue != null ? state.draftValue : draftText;

  el.innerHTML = `
    ${backButton("escalated")}
    <h2>${esc(t.subject)}</h2>
    <div class="meta">
      <span>${esc(t.sender_email)}</span>
      ${orderIdOf(t) ? `<span>Order ${esc(orderIdOf(t))}</span>` : ""}
      <span class="mono">${esc(t.id)}</span>
      <span class="status ${isApproved ? "sent" : "held"}">${isApproved ? "Approved by reviewer" : "Held for review"}</span>
    </div>
    ${!isApproved && reasons.length ? `
      <div class="banner">
        <b>Escalated</b>
        ${reasons.map((r) => `<div>${esc(REASON_TEXT[r.reason] || r.reason)}<div class="reason-detail">${esc(r.detail)}</div></div>`).join("")}
      </div>
    ` : ""}
    <div class="msg">${esc(t.body)}</div>
    <div class="grid2">
      <div class="panel"><h4>Decision</h4>
        <dl class="kv">
          <dt>Priority</dt><dd>${priBadge(attempt.priority)}</dd>
          <dt>Confidence</dt><dd>${attempt.confidence != null ? attempt.confidence : "—"}</dd>
          <dt>Proposed</dt><dd>${actions.length ? actions.map((a) => esc(formatAction(a))).join("<br>") : "—"}</dd>
        </dl>
        ${attempts.length > 1 ? `<div class="attempts">${attempts.map((a, i) => `<span class="attempt ${i === idx ? "on" : ""}" data-attempt="${esc(t.id)}:${i}">Attempt ${a.attempt_no}${a.reviewer_notes ? " (with context)" : ""}</span>`).join("")}</div>` : ""}
      </div>
      <div class="panel"><h4>Evidence cited</h4>
        ${evidence.length ? evidence.map((e) => `<div class="ev"><span class="tag">${esc(e.label)}</span>${esc(e.body)}</div>`).join("") : '<div style="color:var(--text-3)">No citations recorded.</div>'}
      </div>
    </div>
    ${attempt.critique ? `<div class="critique"><b>Self-critique:</b> ${esc(attempt.critique)}</div>` : ""}
    <div class="reply">
      <div class="hd">
        <span>${isApproved ? "Sent" : "Draft reply (not sent)"}</span>
        <span class="mono">${attempt.input_tokens ?? 0} in / ${attempt.output_tokens ?? 0} out · ${fmtMoney(attempt.cost_usd)}</span>
      </div>
      ${state.editingDraft && isCurrent ? `<textarea id="draft-edit">${esc(textareaValue)}</textarea>` : `<div class="reply-text">${esc(draftText)}</div>`}
    </div>
    ${isApproved || !isCurrent ? "" : `
      <div class="actions">
        <button class="btn" data-action="open-retry" data-id="${esc(t.id)}" ${ticketInFlight ? "disabled" : ""}>Try again…</button>
        <button class="btn" data-action="edit-draft" ${ticketInFlight ? "disabled" : ""}>${state.editingDraft ? "Cancel edit" : "Edit draft"}</button>
        <button class="btn accent" data-action="approve" data-id="${esc(t.id)}" ${ticketInFlight ? "disabled" : ""}>
          ${approving ? '<span class="spin"></span>Sending…' : "Approve &amp; send"}
        </button>
      </div>
    `}
  `;
}

///////////
// MODAL //
///////////

function renderModal() {
  const scrim = qs("modal-scrim");
  if (!state.modal) {
    scrim.classList.remove("on");
    qs("modal-body").innerHTML = "";
    state.retryNotesValue = null;
    return;
  }
  scrim.classList.add("on");

  // Run-all progress ticks call render() repeatedly while the retry modal may be open; a
  // rebuilt #retry-notes textarea would silently wipe what the reviewer just typed. Capture
  // the live value before replacing the modal body, and seed the new textarea with it.
  const existingNotes = qs("retry-notes");
  if (existingNotes) state.retryNotesValue = existingNotes.value;

  if (state.modal.type === "eval-confirm") {
    qs("modal-body").innerHTML = `
      <h3>Run the eval?</h3>
      <div class="meta">This runs all 100 labeled tickets through the agent and the judges. Takes about 5 minutes and costs about $4.</div>
      <div class="actions">
        <button class="btn" data-action="close-modal">Cancel</button>
        <button class="btn accent" data-action="confirm-run-eval">Run eval</button>
      </div>
    `;
    return;
  }

  const detail = state.detailCache.get(state.modal.ticketId);
  const attempt = detail ? currentAttempt(detail) : null;
  const actions = attempt ? parseJsonSafe(attempt.proposed_actions_json, []) || [] : [];
  const summary = attempt
    ? `${attempt.priority || "—"} · ${actions.map(formatAction).join(", ") || "no actions"} · "${(attempt.reply_text || "").slice(0, 200)}"`
    : "";
  const retrying = state.inFlight[state.modal.ticketId] === "retrying";

  qs("modal-body").innerHTML = `
    <h3>Try again with more context</h3>
    <div class="meta">The agent re-runs with its previous attempt, your notes, and a self-critique step first.</div>
    <div class="field"><label>Previous attempt (summary)</label><div class="prev">${esc(summary)}</div></div>
    <div class="field"><label>What should it do differently?</label><textarea id="retry-notes" placeholder="Required">${esc(state.retryNotesValue || "")}</textarea></div>
    <div class="field"><label>The agent will first answer</label><div class="prev">"Where did my last attempt go wrong, and what will I change?" This critique is shown in the audit trail above the new draft.</div></div>
    <div class="actions">
      <button class="btn" data-action="close-modal">Cancel</button>
      <button class="btn accent" data-action="retry" data-id="${esc(state.modal.ticketId)}" ${retrying ? "disabled" : ""}>
        ${retrying ? '<span class="spin"></span>Re-running…' : "Re-run agent"}
      </button>
    </div>
  `;
}

//////////
// EVAL //
//////////

const EVAL_FILTERS = [
  { id: "all", label: "All", pred: () => true },
  { id: "misses", label: "Misses", pred: isEvalMiss },
  { id: "unfaithful", label: "Unfaithful", pred: (r) => r.faithful === false },
  { id: "escalation", label: "Escalation wrong", pred: (r) => !r.escalateCorrect },
  { id: "priority", label: "Priority wrong", pred: (r) => !r.priorityExact },
];

function isEvalMiss(r) {
  return !r.priorityExact || !r.escalateCorrect || (r.factsTotal ?? 0) > (r.factsFound ?? 0) || r.faithful === false || !!r.error;
}

// A run the server closed on restart has an error starting "interrupted"; any other error
// (the model runtime unavailable, a crash mid-run) is a failure.
function evalRunIsInterrupted(totals) {
  return totals.error.startsWith("interrupted");
}

function evalRunFailedLabel(totals) {
  return `Failed: ${totals.error}`;
}

function renderEval() {
  const run = state.evalCurrentRun;
  const totals = run?.totals;
  const runs = state.evalRuns;

  qs("eval-top").innerHTML = `
    <div class="eval-toolbar">
      <button class="btn accent" data-action="run-eval" ${state.evalRunning ? "disabled" : ""}>
        ${state.evalRunning ? '<span class="spin"></span>' : ""}Run eval
      </button>
      ${state.evalRunning ? `<span class="mono" style="color:var(--text-2)">Running… ${esc(fmtElapsed(state.evalStartedAt))}</span>` : ""}
      ${runs.length > 1 ? `
        <select id="eval-run-select">
          ${runs.map((r) => `<option value="${esc(r.id)}" ${r.id === state.evalSelectedRunId ? "selected" : ""}>Run ${esc(r.id)} · ${esc(r.started_at || "")}</option>`).join("")}
        </select>
      ` : ""}
    </div>
    ${totals?.error ? `<div class="banner">${evalRunIsInterrupted(totals) ? `<b>Interrupted</b><div>${esc(totals.error)}</div>` : `<b>${esc(evalRunFailedLabel(totals))}</b>`}</div>` : ""}
    ${totals ? `
      <div class="stats">
        <div class="stat"><div class="v">${pct(totals.priorityExact)}</div><div class="l">Priority matches label (${countOf(totals.priorityExact, totals.n)}/${totals.n})</div></div>
        <div class="stat"><div class="v">${Math.round((totals.p1Recall || 0) * (totals.p1Total || 0))} / ${totals.p1Total ?? 0}</div><div class="l">P1 escalated (recall)</div></div>
        <div class="stat"><div class="v">${pct(totals.escalateAccuracy)}</div><div class="l">Escalate decision correct</div></div>
        <div class="stat"><div class="v">${totals.faithJudged ? pct(totals.faithfulness) : "not judged"}</div><div class="l">Faithful replies (${totals.faithJudged ?? 0}/${totals.n ?? 0} judged)</div></div>
        <div class="stat"><div class="v">${fmtMoneyShort(totals.totalCostUsd)}</div><div class="l">Full run, ${totals.n ?? 0} tickets</div></div>
      </div>
    ` : ""}
  `;

  const results = run?.results || [];
  const activeFilter = EVAL_FILTERS.find((f) => f.id === state.evalFilter) || EVAL_FILTERS[0];
  const filtered = results.filter(activeFilter.pred);

  // Falls back to the first visible row when the previous selection isn't in the filtered
  // list (or there was none yet), so the detail pane always matches what the table shows.
  const selectedId = state.selected.eval && filtered.some((r) => r.ticket_id === state.selected.eval)
    ? state.selected.eval
    : filtered[0]?.ticket_id || null;
  state.selected.eval = selectedId;

  qs("eval-list").innerHTML = `
    <div class="filters">
      ${EVAL_FILTERS.map((f) => `<span class="chip ${state.evalFilter === f.id ? "on" : ""}" data-filter-eval="${f.id}">${esc(f.label)} ${results.filter(f.pred).length}</span>`).join("")}
    </div>
    <div class="rows">${
      results.length === 0
        ? (run && !run.run?.finished_at
            ? emptyState("Running…", "This polls every 3 seconds until the run finishes.")
            : run?.totals?.error
              ? (evalRunIsInterrupted(run.totals) ? emptyState("Interrupted", run.totals.error) : emptyState(evalRunFailedLabel(run.totals)))
              : emptyState("No eval runs yet.", "Run eval to score the agent against the labeled tickets."))
        : filtered.length === 0
          ? emptyState("No results match this filter.")
          : `<table class="evtable">
              <tr><th>Ticket</th><th>Subject</th><th>Expected</th><th>Agent</th><th>Hold/Send</th><th>Facts</th><th>Faithful</th></tr>
              ${filtered.map((r) => evalRowHtml(r, selectedId)).join("")}
            </table>`
    }</div>
  `;

  const detailEl = qs("eval-detail");
  const selectedResult = results.find((r) => r.ticket_id === selectedId);
  if (!run || !selectedResult) {
    detailEl.innerHTML = emptyState("Select a ticket.");
  } else {
    renderEvalDetail(run.run.id, selectedResult, detailEl);
  }
  applyMobileClass("body-eval", "eval");
}

function pct(rate) {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

function countOf(rate, n) {
  if (rate == null || n == null) return "—";
  return Math.round(rate * n);
}

function evalRowHtml(r, selectedId) {
  const factsClass = (r.factsFound ?? 0) < (r.factsTotal ?? 0) ? "miss" : "check";
  const faithfulMark = r.faithful === true
    ? '<span class="check">✓</span>'
    : r.faithful === false
      ? '<span class="miss">✗</span>'
      : '<span style="color:var(--text-3)">—</span>';
  return `
    <tr class="${r.ticket_id === selectedId ? "sel" : ""}" data-select="${esc(r.ticket_id)}">
      <td class="mono">${esc(r.ticket_id)}</td>
      <td class="ellipsis" title="${esc(r.subject)}">${esc(r.subject)}</td>
      <td>${priBadge(r.label_priority)}</td>
      <td>${priBadge(r.agent_priority)}</td>
      <td>${r.escalateCorrect ? '<span class="check">✓</span>' : '<span class="miss">✗</span>'}</td>
      <td><span class="${factsClass}">${r.factsFound ?? 0}/${r.factsTotal ?? 0}</span></td>
      <td>${faithfulMark}</td>
    </tr>
  `;
}

// Builds the detail pane's verdict header: one line per check, each stating in plain words
// whether it passed and why - the reasons a reviewer would otherwise have to reconstruct by
// reading the raw attempt and the label side by side.
function evalVerdictItems(detail) {
  const { attempt, score, labels } = detail;
  const items = [];

  items.push({
    ok: score.priorityExact,
    text: score.priorityExact
      ? `Priority: matched label ${labels.priority}`
      : `Priority: expected ${labels.priority}, agent said ${attempt.priority ?? "—"}`,
  });

  const heldForReview = attempt.guardrail_result === "escalate";
  const reasonDetail = (attempt.guardrail_reasons || []).map((r) => r.detail).join("; ");
  if (score.escalateCorrect) {
    items.push({
      ok: true,
      text: heldForReview ? `Held for review because: ${reasonDetail || "—"}` : "Sent automatically, as labeled",
    });
  } else {
    items.push({
      ok: false,
      text: heldForReview
        ? `Held for review, but the label expected this sent automatically (reasons: ${reasonDetail || "—"})`
        : "Sent automatically, but the label expected this held for review",
    });
  }

  const missingFacts = (score.factResults || []).filter((f) => !f.found);
  if (score.factsTotal === 0) {
    items.push({ ok: true, text: "Facts: none required" });
  } else if (missingFacts.length === 0) {
    items.push({ ok: true, text: `Facts: all ${score.factsTotal} required fact(s) found` });
  } else {
    for (const f of missingFacts) items.push({ ok: false, text: `Missing fact: ${factReasonText(f)}` });
  }

  if (score.faithful === false) {
    items.push({ ok: false, text: `Unsupported: ${score.unsupportedClaims || "—"}` });
  } else if (score.faithful === true) {
    items.push({ ok: true, text: "Faithful: no unsupported claims found" });
  } else {
    items.push({ ok: null, text: "Faithful: not judged" });
  }

  if (attempt.error) items.push({ ok: false, text: `Run error: ${attempt.error}` });

  return items;
}

function factReasonText(f) {
  if (f.pattern) return `${f.description} (pattern ${f.pattern})`;
  if (f.notPattern) return `${f.description} (not pattern ${f.notPattern})`;
  return `${f.description} (judged)`;
}

function renderEvalDetail(runId, result, el) {
  const cacheKey = `${runId}:${result.ticket_id}`;
  const cached = state.evalDetailCache.get(cacheKey);
  if (!cached) {
    el.innerHTML = emptyState("Loading…");
    api(`/eval/runs/${runId}/results/${result.ticket_id}`)
      .then((detail) => {
        state.evalDetailCache.set(cacheKey, detail);
        if (state.tab === "eval" && state.selected.eval === result.ticket_id) render();
      })
      .catch((err) => showError(err.message || String(err)));
    return;
  }

  const { ticket, attempt } = cached;
  const verdict = evalVerdictItems(cached);
  const actions = attempt.proposed_actions || [];
  const citations = attempt.citations || [];
  const context = attempt.context || [];

  el.innerHTML = `
    ${backButton("eval")}
    <h2>${esc(ticket.subject)}</h2>
    <div class="meta">
      <span class="mono">${esc(ticket.id)}</span>
      <span>${esc(ticket.archetype)}${ticket.hard ? ` · ${esc(ticket.hard)}` : ""}</span>
    </div>

    <div class="panel verdict"><h4>Verdict</h4>
      ${verdict.map((v) => `<div class="verdict-line ${v.ok === true ? "check" : v.ok === false ? "miss" : ""}">${v.ok === true ? "✓" : v.ok === false ? "✗" : "–"} ${esc(v.text)}</div>`).join("")}
    </div>

    <div class="section-label">Customer's ticket</div>
    <div class="meta"><span>${esc(ticket.from)}</span></div>
    <div class="msg">${esc(ticket.body)}</div>

    <div class="section-label">What the agent decided</div>
    <div class="panel">
      <dl class="kv">
        <dt>Priority</dt><dd>${priBadge(attempt.priority)}</dd>
        <dt>Confidence</dt><dd>${attempt.confidence != null ? attempt.confidence : "—"}</dd>
        <dt>Reasoning</dt><dd>${esc(attempt.reasoning || "—")}</dd>
        <dt>Actions</dt><dd>${actions.length ? actions.map((a) => esc(formatAction(a))).join("<br>") : "—"}</dd>
        <dt>Citations</dt><dd>${citations.length ? citations.map((c) => esc(c)).join(", ") : "—"}</dd>
      </dl>
    </div>

    <div class="section-label">What the agent saw</div>
    <div class="panel">
      ${context.length ? context.map((b) => renderContextBlock(b)).join("") : '<div style="color:var(--text-3)">No context recorded.</div>'}
    </div>

    <div class="reply">
      <div class="hd">
        <span>Reply</span>
        <span class="mono">${attempt.input_tokens ?? 0} in / ${attempt.output_tokens ?? 0} out · ${fmtMoney(attempt.cost_usd)} · ${fmtLatency(attempt.latency_ms)}</span>
      </div>
      <div class="reply-text">${esc(attempt.reply_text || "—")}</div>
    </div>
    ${attempt.critique ? `<div class="critique"><b>Self-critique:</b> ${esc(attempt.critique)}</div>` : ""}
  `;
}

async function loadEvalRuns() {
  const runs = await api("/eval/runs");
  state.evalRuns = runs || [];
  if (state.evalRuns.length && (state.evalSelectedRunId == null || !state.evalRuns.some((r) => r.id === state.evalSelectedRunId))) {
    // listEvalRuns is ordered newest-first.
    state.evalSelectedRunId = state.evalRuns[0].id;
  }
  if (state.evalSelectedRunId != null) {
    await loadEvalRun(state.evalSelectedRunId);
  }
}

async function loadEvalRun(id) {
  const run = await api(`/eval/runs/${id}`);
  state.evalCurrentRun = run; // { run: { ..., finished_at }, totals, results }
  state.evalSelectedRunId = id;
}

// A run can still be in flight after a reload, after switching away from the eval tab and
// back, or when the run selector picks an unfinished run. Whenever the selected run has no
// finished_at, poll for it.
function maybeResumeEvalPolling() {
  const run = state.evalCurrentRun;
  if (run && !run.run?.finished_at) pollEvalRun(state.evalSelectedRunId, Date.parse(run.run?.started_at) || Date.now());
}

// The "Running…" state and its elapsed timer last exactly as long as a poll does.
function stopEvalPoll() {
  if (evalPollTimer) {
    clearInterval(evalPollTimer);
    evalPollTimer = null;
  }
  stopEvalElapsedTimer();
  state.evalRunning = false;
  state.evalStartedAt = null;
}

function startEvalElapsedTimer() {
  stopEvalElapsedTimer();
  evalElapsedTimer = setInterval(() => {
    if (state.tab === "eval" && evalPollTimer) render();
  }, 1000);
}

function stopEvalElapsedTimer() {
  if (evalElapsedTimer) {
    clearInterval(evalElapsedTimer);
    evalElapsedTimer = null;
  }
}

function pollEvalRun(id, startedAt = Date.now()) {
  stopEvalPoll();
  state.evalRunning = true;
  state.evalStartedAt = startedAt;
  startEvalElapsedTimer();
  const timer = setInterval(async () => {
    let run;
    try {
      run = await api(`/eval/runs/${id}`);
    } catch (err) {
      if (evalPollTimer !== timer) return;
      stopEvalPoll();
      showError(`Eval polling failed: ${err.message || err}`);
      render();
      return;
    }
    // A request still in flight when this poll was stopped (the selector moved to another
    // run, or the tab changed) must not overwrite what is on screen.
    if (evalPollTimer !== timer) return;
    state.evalCurrentRun = run;
    state.evalSelectedRunId = id;
    if (state.evalCurrentRun?.run?.finished_at) {
      stopEvalPoll();
      try {
        await loadEvalRuns();
        await loadStats();
      } catch (err) {
        showError(err.message || String(err));
      }
      render();
    } else if (state.tab === "eval") {
      render();
    }
  }, 3000);
  evalPollTimer = timer;
}

///////////////
// ACTIONS   //
///////////////

function setInFlight(id, kind) {
  state.inFlight[id] = kind;
  render();
}

function clearInFlight(id) {
  delete state.inFlight[id];
  render();
}

// Runs a run/retry/approve request for a single ticket, tracked per ticket id so the
// corresponding button renders disabled (with its own "Running…"/"Re-running…"/"Sending…"
// label) for the whole round trip, across any re-renders in between. If a request for this
// ticket is already in flight, a second call is a no-op - that's the belt to the button's own
// disabled-while-in-flight suspenders, for the case where it fires some other way.
//
// A 409 means the server already refused this request as a no-op (the ticket finished running,
// or was already approved, moments before this click). That isn't a real error: show a brief
// neutral notice instead of the error banner, and refresh so the console reflects where the
// ticket actually landed.
async function withTicketInFlight(id, kind, fn, alreadyDoneMessage) {
  if (state.inFlight[id]) return;
  hideNotice();
  setInFlight(id, kind);
  try {
    await fn();
  } catch (err) {
    if (err.status === 409) {
      await settleAfterConflict(id);
      showNotice(alreadyDoneMessage);
    } else {
      console.error(err);
      showError(err.message || String(err));
    }
  } finally {
    clearInFlight(id);
  }
}

// After a 409, pick up wherever the ticket actually ended up (another click, or run-all,
// already moved it) and select it there instead of leaving the console on its pre-request view.
async function settleAfterConflict(id) {
  state.detailCache.delete(id);
  try {
    await refreshAll();
    const detail = await loadDetail(id, { force: true });
    const status = detail?.ticket?.status;
    if (status === "resolved") {
      state.tab = "resolved";
      state.selected.resolved = id;
    } else if (status === "escalated") {
      state.tab = "escalated";
      state.escalatedFilter = "needs";
      state.selected.escalated = id;
    }
  } catch (err) {
    console.error(err); // best-effort refresh; the notice still shows regardless
  }
  state.modal = null;
}

async function runTicket(id) {
  await withTicketInFlight(id, "running", async () => {
    await postJson(`/tickets/${id}/run`);
    state.detailCache.delete(id);
    await refreshAll();
    const detail = await loadDetail(id, { force: true });
    if (detail.ticket.status === "resolved") {
      state.tab = "resolved";
      state.selected.resolved = id;
    } else if (detail.ticket.status === "escalated") {
      state.tab = "escalated";
      state.escalatedFilter = "needs";
      state.selected.escalated = id;
    }
  }, "This ticket was already run; showing its result.");
}

// Runs Inbox tickets through POST /tickets/:id/run with a small client-side pool so the
// console can show progress and stop between tickets.
const DEFAULT_RUN_ALL_CONCURRENCY = 4;

async function runAllClient() {
  if (state.runAll) return; // already running
  hideError();

  let tickets;
  try {
    tickets = await api("/tickets?status=new");
  } catch (err) {
    showError(err.message || String(err));
    state.runAll = null;
    render();
    return;
  }
  state.runAll = {
    total: tickets.length,
    done: 0,
    resolved: 0,
    escalated: 0,
    skipped: 0,
    errors: [],
    stopRequested: false,
  };
  render();

  let lastRefresh = 0;
  const throttledRefresh = async (force) => {
    const now = Date.now();
    if (!force && now - lastRefresh < 1000) return;
    lastRefresh = now;
    try {
      await refreshAll();
    } catch {
      // best-effort during the run; the final refresh below surfaces real problems
    }
    render();
  };

  let next = 0;
  const worker = async () => {
    while (next < tickets.length) {
      if (state.runAll.stopRequested) return;
      const ticket = tickets[next++];
      if (ticket.status === "running") {
        state.runAll.skipped++;
        state.runAll.done++;
        render();
        continue;
      }
      try {
        const res = await fetch(`/tickets/${ticket.id}/run`, { method: "POST" });
        if (res.status === 409) {
          state.runAll.skipped++;
        } else if (res.status === 503) {
          let message = "Model runtime unavailable";
          try {
            const body = await res.json();
            message = (body && body.error) || message;
          } catch {
            // no JSON body
          }
          showError(message);
          state.runAll.stopRequested = true;
        } else if (!res.ok) {
          let message = res.statusText;
          try {
            const body = await res.json();
            message = (body && body.error) || message;
          } catch {
            // no JSON body
          }
          state.runAll.errors.push(`${ticket.id}: ${message}`);
        } else {
          const body = await res.json();
          if (body.ticket?.status === "resolved") state.runAll.resolved++;
          else if (body.ticket?.status === "escalated") state.runAll.escalated++;
        }
      } catch (err) {
        state.runAll.errors.push(`${ticket.id}: ${err.message || err}`);
      }
      state.runAll.done++;
      render();
      await throttledRefresh(false);
    }
  };

  const concurrency = state.stats?.runConcurrency || DEFAULT_RUN_ALL_CONCURRENCY;
  await Promise.all(Array.from({ length: Math.min(concurrency, tickets.length) }, worker));

  state.detailCache.clear();
  const errors = state.runAll.errors;
  await throttledRefresh(true);
  state.runAll = null;
  if (errors.length) {
    showError(`${errors.length} ticket(s) failed to run: ${errors.slice(0, 3).join("; ")}${errors.length > 3 ? "…" : ""}`);
  }
  render();
}

async function approveTicket(id) {
  await withTicketInFlight(id, "approving", async () => {
    const cached = state.detailCache.get(id);
    const textarea = qs("draft-edit");
    const body = {};
    if (textarea) {
      const attempt = currentAttempt(cached);
      if (textarea.value !== attempt?.reply_text) body.edited_reply = textarea.value;
    }
    await postJson(`/tickets/${id}/approve`, body);
    state.editingDraft = false;
    state.draftValue = null;
    state.detailCache.delete(id);
    await refreshAll();
  }, "Already approved.");
}

async function retryTicket(id, notes) {
  await withTicketInFlight(id, "retrying", async () => {
    await postJson(`/tickets/${id}/retry`, { notes });
    state.modal = null;
    state.retryNotesValue = null;
    state.detailCache.delete(id);
    await refreshAll();
    const detail = await loadDetail(id, { force: true });
    state.attemptIndex[id] = (detail.attempts?.length || 1) - 1;
  }, "This ticket was already run; showing its result.");
}

async function runEval() {
  hideError();
  stopEvalPoll();
  state.evalRunning = true;
  render();
  try {
    const { id } = await postJson("/eval");
    await loadEvalRuns();
    await loadEvalRun(id);
    pollEvalRun(id);
    render();
  } catch (err) {
    stopEvalPoll();
    showError(err.message || String(err));
    render();
  }
}

////////////////////
// EVENT WIRING   //
////////////////////

function wireEvents() {
  qs("error-banner-dismiss").addEventListener("click", hideError);
  qs("notice-banner-dismiss").addEventListener("click", hideNotice);

  document.body.addEventListener("click", async (e) => {
    // Checked before [data-tab]: the Back button also carries data-tab.
    const backBtn = e.target.closest('[data-action="mobile-back"]');
    if (backBtn) {
      state.mobileDetail[backBtn.dataset.tab] = false;
      render();
      return;
    }

    const tabBtn = e.target.closest("[data-tab]");
    if (tabBtn) {
      const leavingEval = state.tab === "eval" && tabBtn.dataset.tab !== "eval";
      if (leavingEval) stopEvalPoll();
      state.tab = tabBtn.dataset.tab;
      state.editingDraft = false;
      state.draftValue = null;
      render();
      try {
        await refreshTab(state.tab);
      } catch (err) {
        showError(err.message || String(err));
      }
      if (state.tab === "eval") {
        maybeResumeEvalPolling();
      }
      render();
      return;
    }

    const row = e.target.closest("[data-select]");
    if (row) {
      state.selected[state.tab] = row.dataset.select;
      state.editingDraft = false;
      state.draftValue = null;
      state.mobileDetail[state.tab] = true;
      render();
      return;
    }

    const filterResolved = e.target.closest("[data-filter-resolved]");
    if (filterResolved) {
      state.resolvedFilter = filterResolved.dataset.filterResolved;
      state.selected.resolved = null;
      render();
      return;
    }

    const filterEscalated = e.target.closest("[data-filter-escalated]");
    if (filterEscalated) {
      state.escalatedFilter = filterEscalated.dataset.filterEscalated;
      state.selected.escalated = null;
      render();
      return;
    }

    const filterEval = e.target.closest("[data-filter-eval]");
    if (filterEval) {
      state.evalFilter = filterEval.dataset.filterEval;
      render();
      return;
    }

    const attemptPill = e.target.closest("[data-attempt]");
    if (attemptPill) {
      const [ticketId, idx] = attemptPill.dataset.attempt.split(":");
      state.attemptIndex[ticketId] = Number(idx);
      render();
      return;
    }

    const action = e.target.closest("[data-action]");
    if (!action) return;
    const act = action.dataset.action;

    if (act === "run-ticket") return runTicket(action.dataset.id);
    if (act === "run-all") return runAllClient();
    if (act === "stop-run-all") {
      if (state.runAll) state.runAll.stopRequested = true;
      render();
      return;
    }
    if (act === "edit-draft") {
      state.editingDraft = !state.editingDraft;
      if (!state.editingDraft) state.draftValue = null;
      render();
      return;
    }
    if (act === "approve") return approveTicket(action.dataset.id);
    if (act === "open-retry") {
      hideError();
      state.modal = { type: "retry", ticketId: action.dataset.id };
      state.retryNotesValue = null;
      render();
      return;
    }
    if (act === "close-modal") {
      state.modal = null;
      state.retryNotesValue = null;
      render();
      return;
    }
    if (act === "retry") {
      const notes = qs("retry-notes")?.value.trim();
      if (!notes) {
        showError("Notes are required before re-running.");
        return;
      }
      return retryTicket(action.dataset.id, notes);
    }
    if (act === "run-eval") {
      hideError();
      state.modal = { type: "eval-confirm" };
      render();
      return;
    }
    if (act === "confirm-run-eval") {
      state.modal = null;
      return runEval();
    }
  });

  document.body.addEventListener("change", async (e) => {
    if (e.target.id === "eval-run-select") {
      stopEvalPoll();
      state.selected.eval = null;
      try {
        await loadEvalRun(Number(e.target.value));
        maybeResumeEvalPolling();
      } catch (err) {
        showError(err.message || String(err));
      }
      render();
    }
  });
}

////////////
// BOOT   //
////////////

async function boot() {
  wireEvents();
  try {
    await refreshAll();
  } catch (err) {
    showError(err.message || String(err));
  }
  render();
}

boot();
