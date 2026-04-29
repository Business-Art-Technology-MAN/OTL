const $ = (id) => document.getElementById(id);

/** @returns {typeof window.marketLab | null} */
function getBridgeApi() {
  return window.marketLab != null && typeof window.marketLab === "object" ? window.marketLab : null;
}

/** @param {unknown} e */
function bridgeErrorMessage(e) {
  if (e && typeof /** @type {Error} */ (e).message === "string") {
    const m = /** @type {Error} */ (e).message;
    return m.length > 140 ? m.slice(0, 137) + "…" : m;
  }
  return String(e);
}

/** @type {{ bars: number, start: string|null, end: string|null, path: string|null }} */
let loadMeta = { bars: 0, start: null, end: null, path: null };
/** Wall-clock tick samples from host `LOAD_DATA.timeline_axis` (bar → CSV timestamp string). */
/** @type {Array<{ bar: number, wall: string }>} */
let timelineAxisTicks = [];
let playheadBar = 0;
let dragActive = false;
let seekDebounce = null;

const TIMELINE_PAD = 14;

/**
 * @param {boolean | "warn"} state true = green, "warn" = amber (degraded), false = red
 * @param {string} text
 */
function setConn(state, text) {
  const el = $("conn-pill");
  if (!el) {
    return;
  }
  el.classList.remove("pill-ok", "pill-warn", "pill-err", "pill-idle");
  if (state === "warn") {
    el.classList.add("pill-warn");
  } else if (state) {
    el.classList.add("pill-ok");
  } else {
    el.classList.add("pill-err");
  }
  el.textContent = text;
  if (text && text.length > 72) {
    el.setAttribute("title", text);
  } else {
    el.removeAttribute("title");
  }
}

function parseOkLine(line) {
  if (line.startsWith("OK ")) {
    const jsonPart = line.slice(3);
    try {
      return { ok: true, json: JSON.parse(jsonPart) };
    } catch {
      return { ok: true, json: { raw: jsonPart } };
    }
  }
  if (line.startsWith("ERR ")) {
    const jsonPart = line.slice(4);
    try {
      return { ok: false, json: JSON.parse(jsonPart) };
    } catch {
      return { ok: false, json: { error: jsonPart } };
    }
  }
  return { ok: true, json: { line } };
}

function clearMetricTiles() {
  const el = $("telemetry");
  if (!el) {
    return;
  }
  el.replaceChildren();
}

function addMetricTile(name, value, tone) {
  const el = $("telemetry");
  if (!el) {
    return;
  }
  const tile = document.createElement("div");
  tile.className = "metric-tile" + (tone === "warn" ? " metric-warn" : tone === "ok" ? " metric-ok" : "");
  tile.setAttribute("role", "listitem");
  const n = document.createElement("span");
  n.className = "metric-name";
  n.textContent = name;
  const v = document.createElement("span");
  v.className = "metric-val";
  v.textContent = value;
  tile.appendChild(n);
  tile.appendChild(v);
  el.appendChild(tile);
}

function formatNum(n) {
  if (n === null || n === undefined) {
    return "—";
  }
  const x = Number(n);
  if (Number.isNaN(x)) {
    return "—";
  }
  return x.toFixed(5).replace(/\.?0+$/, "");
}

/**
 * @param {unknown} x
 */
function fmtDeltaCell(x) {
  if (x === null || x === undefined) {
    return "—";
  }
  const v = Number(x);
  if (Number.isNaN(v) || Math.abs(v) < 1e-12) {
    return "—";
  }
  const s = v.toFixed(5).replace(/\.?0+$/, "");
  return v > 0 ? "+" + s : s;
}

/**
 * Timeline footer spreadsheet: cumulative gal_m1 weight deltas (`telemetry.analysis.trades`).
 * @param {object | undefined} j
 */
function renderTimelineTradesSheet(j) {
  const thead = $("timeline-trades-thead");
  const tbody = $("timeline-trades-tbody");
  const caption = $("timeline-trades-caption");
  if (!thead || !tbody || !caption) {
    return;
  }
  thead.replaceChildren();
  tbody.replaceChildren();

  const ex = j && typeof j.execution_clock === "object" ? j.execution_clock : null;
  const integrator =
    ex && typeof ex.integrator === "string" ? ex.integrator : "";
  /** @type {unknown[]} */
  let trades = [];
  if (j && j.telemetry && typeof j.telemetry === "object") {
    const an = /** @type {Record<string, unknown>} */ (j.telemetry).analysis;
    if (an && typeof an === "object") {
      const tr = /** @type {Record<string, unknown>} */ (an).trades;
      if (Array.isArray(tr)) {
        trades = tr;
      }
    }
  }

  /** @returns {number} */
  const maxDwLen = () => {
    let m = 0;
    for (const ev of trades) {
      const row = typeof ev === "object" && ev !== null ? /** @type {Record<string, unknown>} */ (ev) : null;
      const dw = row && Array.isArray(row.delta_w) ? row.delta_w : null;
      if (dw && dw.length > m) {
        m = dw.length;
      }
    }
    return m;
  };

  /** @returns {string} */
  function assetDwLabel(ix) {
    const labels = j && Array.isArray(j.asset_labels) ? j.asset_labels : null;
    if (labels && typeof labels[ix] === "string" && String(labels[ix]).trim()) {
      return `Δ · ${String(labels[ix]).trim()}`;
    }
    return "Δ weight " + String(ix);
  }

  /** @returns {number} */
  function currentBar() {
    if (j && typeof j.bar === "number") {
      return j.bar;
    }
    return playheadBar;
  }

  const pb = currentBar();

  if (integrator !== "gal_m1") {
    caption.textContent = "";
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.className = "timeline-dopesheet-empty";
    td.colSpan = 4;
    td.textContent =
      "Weight replay log appears when Portfolio integrator is gal_m1 (OSL + GAL replay to playhead).";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const galOk = !!(ex && ex.gal_m1_replay_ok === true);
  const ncDwRaw = trades.length ? maxDwLen() : 0;
  const ncol = Math.min(48, Math.max(1, ncDwRaw));
  /** @type {HTMLElement | null} */
  let keyframeEl = null;

  const hdr = document.createElement("tr");
  const hf = document.createElement("th");
  hf.scope = "col";
  hf.textContent = "#";
  hdr.appendChild(hf);
  const hb = document.createElement("th");
  hb.scope = "col";
  hb.textContent = "Bar";
  hdr.appendChild(hb);
  const hg = document.createElement("th");
  hg.scope = "col";
  hg.textContent = "Gross Σ|Δw|";
  hdr.appendChild(hg);
  for (let ax = 0; ax < ncol; ax++) {
    const hh = document.createElement("th");
    hh.scope = "col";
    hh.textContent = assetDwLabel(ax);
    hdr.appendChild(hh);
  }
  thead.appendChild(hdr);

  if (!galOk || !trades.length) {
    caption.textContent =
      trades.length === 0 && galOk ? "(no weight events buffered)" : galOk ? "" : "(replay incomplete)";
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3 + ncol;
    td.className = "timeline-dopesheet-empty";
    td.textContent = !galOk
      ? "GAL+M1 replay did not succeed (see execution_clock.error / host log)."
      : "No cumulative weight deltas for this SEEK.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const sorted = trades
    .map((ev) => (typeof ev === "object" && ev !== null ? /** @type {Record<string, unknown>} */ (ev) : {}))
    .sort((a, b) => {
      const ba = typeof a.bar === "number" ? a.bar : Number(a.bar) || 0;
      const bb = typeof b.bar === "number" ? b.bar : Number(b.bar) || 0;
      return ba - bb;
    });

  caption.textContent = `${sorted.length} bar(s) logged · playhead ${pb}`;

  sorted.forEach((row, ix) => {
    const bar = typeof row.bar === "number" ? row.bar : Number(row.bar) || 0;
    const gt =
      typeof row.gross_turnover_l1 === "number"
        ? row.gross_turnover_l1
        : row.gross_turnover_l1 != null && !Number.isNaN(Number(row.gross_turnover_l1))
          ? Number(row.gross_turnover_l1)
          : null;
    const dwRaw = Array.isArray(row.delta_w) ? row.delta_w : [];

    const tr = document.createElement("tr");
    if (bar === pb) {
      tr.classList.add("timeline-dopesheet-keyframe");
      keyframeEl = tr;
    }
    const tix = document.createElement("td");
    tix.textContent = String(ix + 1);
    tr.appendChild(tix);

    const tbar = document.createElement("td");
    tbar.textContent = String(bar);
    tr.appendChild(tbar);

    const tg = document.createElement("td");
    tg.className = "timeline-dopesheet-num";
    tg.textContent = gt !== null && !Number.isNaN(gt) ? formatNum(gt) : "—";
    tr.appendChild(tg);

    for (let ax = 0; ax < ncol; ax++) {
      const td = document.createElement("td");
      td.textContent = dwRaw.length > ax ? fmtDeltaCell(dwRaw[ax]) : "—";
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });

  if (keyframeEl instanceof HTMLElement) {
    keyframeEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

/** Same key as N-panel “Price strip”; drives which `node_states_*` row the metric rail mirrors. */
const MLAB_ASSET_INDEX_KEY = "mlab.selected_asset_index";

/**
 * @param {object} j
 * @param {number} want
 */
function clampAssetIndexForSeek(j, want) {
  const n = j && typeof j.assets === "number" ? j.assets | 0 : 0;
  if (n <= 0) {
    return 0;
  }
  let w = want | 0;
  if (w < 0) {
    w = 0;
  }
  if (w >= n) {
    w = n - 1;
  }
  return w;
}

/**
 * @param {object} j
 */
function selectedAssetIndexForTelemetry(j) {
  let want = 0;
  try {
    want = parseInt(localStorage.getItem(MLAB_ASSET_INDEX_KEY) || "0", 10) || 0;
  } catch {
    want = 0;
  }
  return clampAssetIndexForSeek(j, want);
}

function renderTelemetryFromSeek(j) {
  if (!j) {
    return;
  }
  const t = j.telemetry || {};
  const aidx = selectedAssetIndexForTelemetry(/** @type {object} */ (j));
  const bya = j.node_states_by_asset;
  let ns = j.node_states || {};
  if (Array.isArray(bya) && aidx >= 0 && aidx < bya.length && bya[aidx] && typeof bya[aidx] === "object") {
    ns = bya[aidx];
  }
  clearMetricTiles();

  addMetricTile("bar", j.bar != null ? String(j.bar) : "—", "ok");
  const wall =
    j.bar_label != null && j.bar_label !== ""
      ? String(j.bar_label)
      : j.wall_time != null
        ? String(j.wall_time)
        : "—";
  addMetricTile("wall time", wall, "ok");

  if (typeof j.assets === "number" && j.assets >= 1) {
    addMetricTile("assets (N)", String(j.assets), "ok");
  }
  if (Array.isArray(j.node_states_by_asset) && j.node_states_by_asset.length) {
    const nAst = j.node_states_by_asset.length;
    const n0 = j.node_states_by_asset[0];
    const k0 =
      n0 && typeof n0 === "object" ? Object.keys(n0).filter((k) => k !== "map_from").length : 0;
    addMetricTile("node states / asset", `${k0} m-attrs · ${nAst} assets`, "ok");
  }
  if (typeof j.assets === "number" && j.assets > 1) {
    const labels = j.asset_labels;
    const lab =
      Array.isArray(labels) && typeof labels[aidx] === "string" && String(labels[aidx]).trim() !== ""
        ? String(labels[aidx]).trim()
        : "asset " + aidx;
    addMetricTile("metric strip (N-panel)", lab, "ok");
  }
  const ex = j.execution_clock;
  if (ex && ex.gal_m1_replay_mode) {
    addMetricTile("GAL M1 replay", String(ex.gal_m1_replay_mode), "ok");
  }

  const keys = Object.keys(ns).filter((k) => k !== "map_from");
  for (const k of keys) {
    addMetricTile(k, formatNum(/** @type {number} */ (ns[k])), "ok");
  }
  if (Array.isArray(j.m_attrs_for_osl) && j.m_attrs_for_osl.length) {
    addMetricTile("m_attrs_for_osl", j.m_attrs_for_osl.join(", "), "ok");
  }

  const pat = j.per_asset_telemetry;
  let tail = t.close_tail;
  if (Array.isArray(pat) && pat[aidx] && pat[aidx].close_tail && Array.isArray(pat[aidx].close_tail)) {
    tail = pat[aidx].close_tail;
  }
  if (Array.isArray(tail) && tail.length) {
    const s = tail.slice(-6).map((x) => formatNum(x)).join(", ");
    const tailLabel = typeof j.assets === "number" && j.assets > 1 ? "close tail (6 · strip)" : "close tail (6)";
    addMetricTile(tailLabel, s, "ok");
  }

  const osl = t.osl_m1;
  if (osl && typeof osl === "object") {
    if (osl.enabled === false) {
      addMetricTile("osl m1", "off (lab.osl_shader_dir or OTL_SHADER_DIR + m1_alpha.oso)", "ok");
    } else if (osl.executed && osl.fix_signal && typeof osl.fix_signal === "object") {
      const f = /** @type {Record<string, number>} */ (osl.fix_signal);
      const side = f.side != null ? String(f.side) : "?";
      const qty = f.quantity != null ? formatNum(/** @type {number} */ (f.quantity)) : "?";
      const pr = f.price != null ? formatNum(/** @type {number} */ (f.price)) : "?";
      addMetricTile("osl fix_signal", "side " + side + " qty " + qty + " @ " + pr, "ok");
    } else if (osl.error) {
      addMetricTile("osl m1", String(osl.error).length > 100 ? String(osl.error).slice(0, 97) + "…" : String(osl.error), "warn");
    } else {
      addMetricTile("osl m1", "ok", "ok");
    }
  }

  const hb = j.bridge_heartbeat;
  const hbEl = $("heartbeat");
  if (hbEl) {
    hbEl.textContent = hb ? `heartbeat: ${JSON.stringify(hb)}` : "—";
  }
  if (hb) {
    const fullOk = hb.vector_ta === "linked" && hb.cxx === "ok";
    if (fullOk) {
      setConn(true, "Bridge: OK");
    } else {
      setConn("warn", "Bridge: DEGRADED (see heartbeat: vector_ta / cxx)");
    }
  }

  if (window.MLWorkbench && typeof window.MLWorkbench.onSeek === "function") {
    window.MLWorkbench.onSeek(j);
  }
  renderTimelineTradesSheet(j);
}

function formatWallCompact(s) {
  if (s == null || typeof s !== "string") {
    return "—";
  }
  const t = s.trim();
  if (t.length === 0) {
    return "—";
  }
  if (t.length > 14) {
    return t.slice(0, 13) + "…";
  }
  return t;
}

/**
 * @param {number} b
 */
function wallLabelForBar(b) {
  if (timelineAxisTicks.length === 0) {
    return String(b);
  }
  for (const t of timelineAxisTicks) {
    if (t.bar === b) {
      return formatWallCompact(t.wall);
    }
  }
  let best = timelineAxisTicks[0];
  let bestD = Math.abs(best.bar - b);
  for (let i = 1; i < timelineAxisTicks.length; i++) {
    const t = timelineAxisTicks[i];
    const d = Math.abs(t.bar - b);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return formatWallCompact(best.wall);
}

function updateTimelineStatus() {
  const st = $("timeline-status");
  const c = $("timeline-canvas");
  const macro = $("timeline-macro-canvas");
  if (!st) {
    updateTimelineUIMode();
    return;
  }
  if (loadMeta.bars <= 0) {
    st.textContent = "Load a CSV to enable scrub";
    if (c) {
      c.setAttribute("aria-valuemax", "0");
      c.setAttribute("aria-valuemin", "0");
      c.setAttribute("aria-valuenow", "0");
    }
    if (macro) {
      macro.setAttribute("aria-valuemax", "0");
      macro.setAttribute("aria-valuemin", "0");
      macro.setAttribute("aria-valuenow", "0");
    }
    updateTimelineUIMode();
    return;
  }
  const start = loadMeta.start || "?";
  const end = loadMeta.end || "?";
  const lastIdx = loadMeta.bars - 1;
  const scrubNote = playheadBar >= lastIdx ? " · Live (dataset end)" : " · Historical scrub";
  st.textContent = `Loaded ${loadMeta.bars} bars · ${start} → ${end}${scrubNote}`;
  const wallNow = wallLabelForBar(playheadBar);
  const axisHint = `Time axis · ${wallNow} · bar ${playheadBar} / ${lastIdx}`;
  if (c) {
    c.setAttribute("aria-valuemax", String(lastIdx));
    c.setAttribute("aria-valuemin", "0");
    c.setAttribute("aria-valuenow", String(playheadBar));
    c.setAttribute("aria-label", axisHint);
  }
  if (macro) {
    macro.setAttribute("aria-valuemax", String(lastIdx));
    macro.setAttribute("aria-valuemin", "0");
    macro.setAttribute("aria-valuenow", String(playheadBar));
    macro.setAttribute(
      "aria-label",
      `Macro overview of loaded range, playhead ${wallNow}`
    );
  }
  updateTimelineUIMode();
}

/** §5 temporal synchrony: desaturate main workspace while playhead is not at the dataset end. */
function updateTimelineUIMode() {
  const root = document.body;
  if (!root || !loadMeta || loadMeta.bars <= 0) {
    if (document.body) {
      document.body.classList.remove("timeline-historical");
      document.body.removeAttribute("data-timeline-live");
    }
    return;
  }
  const lastIdx = loadMeta.bars - 1;
  const atLiveEnd = playheadBar >= lastIdx;
  root.classList.toggle("timeline-historical", !atLiveEnd);
  root.setAttribute("data-timeline-live", atLiveEnd ? "1" : "0");
}

function applyLoadJson(j) {
  loadMeta = {
    bars: typeof j.bars === "number" ? j.bars : 0,
    start: j.time_range && j.time_range.start ? j.time_range.start : null,
    end: j.time_range && j.time_range.end ? j.time_range.end : null,
    path: j.path || null
  };
  timelineAxisTicks = [];
  const ax = j.timeline_axis;
  if (ax && typeof ax === "object" && Array.isArray(ax.ticks)) {
    for (const raw of ax.ticks) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const br = /** @type {Record<string, unknown>} */ (raw).bar;
      const wl = /** @type {Record<string, unknown>} */ (raw).wall;
      if (typeof br === "number" && typeof wl === "string") {
        timelineAxisTicks.push({ bar: br, wall: wl });
      }
    }
    timelineAxisTicks.sort((a, b) => a.bar - b.bar);
  }
  playheadBar = loadMeta.bars > 0 ? loadMeta.bars - 1 : 0;
  updateTimelineStatus();
  drawTimelineMacro();
  drawTimeline();
}

function barFromClientX(canvas, clientX) {
  if (!(canvas instanceof HTMLCanvasElement) || loadMeta.bars <= 0) {
    return 0;
  }
  const r = canvas.getBoundingClientRect();
  const pad = TIMELINE_PAD;
  const innerW = Math.max(1, r.width - 2 * pad);
  const x = clientX - r.left;
  let t = (x - pad) / innerW;
  if (t < 0) {
    t = 0;
  }
  if (t > 1) {
    t = 1;
  }
  const maxB = loadMeta.bars - 1;
  return Math.round(t * maxB);
}

function seekTokenForBar(b) {
  return String(b);
}

async function seekToBar(b) {
  if (loadMeta.bars <= 0) {
    return;
  }
  const cl = b < 0 ? 0 : b >= loadMeta.bars ? loadMeta.bars - 1 : b;
  playheadBar = cl;
  const tok = seekTokenForBar(cl);
  const input = $("seek-input");
  if (input) {
    input.value = tok;
  }
  const api = getBridgeApi();
  if (!api || typeof api.seek !== "function") {
    return;
  }
  try {
    const line = await api.seek(tok);
    const p = parseOkLine(line);
    if (p.ok && p.json) {
      renderTelemetryFromSeek(p.json);
    }
  } catch (e) {
    setConn(false, "SEEK: " + bridgeErrorMessage(e));
  }
  drawTimeline();
  drawTimelineMacro();
  updateTimelineStatus();
}

function scheduleSeekFromDrag(b) {
  playheadBar = b;
  const input = $("seek-input");
  if (input) {
    input.value = seekTokenForBar(b);
  }
  const ghost = $("scrub-ghost");
  if (ghost) {
    ghost.textContent =
      timelineAxisTicks.length > 0
        ? `scrub ${wallLabelForBar(b)} · bar ${b}`
        : `scrub bar ${b}`;
  }
  drawTimeline();
  drawTimelineMacro();
  updateTimelineUIMode();
  clearTimeout(seekDebounce);
  seekDebounce = setTimeout(() => {
    void seekToBar(b);
  }, 100);
}

function drawTimeline() {
  const c = $("timeline-canvas");
  if (!c) {
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 800;
  const hCss = 100;
  c.width = w * dpr;
  c.height = hCss * dpr;
  const ctx = c.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  const rw = c.clientWidth;
  const pad = TIMELINE_PAD;
  const innerW = Math.max(1, rw - 2 * pad);
  const axisY = 58;
  const baseY = 78;

  ctx.fillStyle = "#0d0d0d";
  ctx.fillRect(0, 0, rw, hCss);
  if (loadMeta.bars <= 0) {
    ctx.fillStyle = "#666";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText("Load data to see wall-clock axis", pad, 32);
    return;
  }

  const maxB = loadMeta.bars - 1;
  const tPlay = maxB > 0 ? playheadBar / maxB : 0;
  const xPlay = pad + tPlay * innerW;

  const grd = ctx.createLinearGradient(0, 0, rw, 0);
  grd.addColorStop(0, "rgba(79, 195, 247, 0.12)");
  grd.addColorStop(0.5, "rgba(79, 195, 247, 0.02)");
  grd.addColorStop(1, "rgba(79, 195, 247, 0.08)");
  ctx.fillStyle = grd;
  ctx.fillRect(pad, 14, innerW, 40);

  ctx.strokeStyle = "#3a3a3a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 6; i++) {
    const tx = pad + (i / 6) * innerW;
    ctx.moveTo(tx, 20);
    ctx.lineTo(tx, 52);
  }
  ctx.stroke();

  ctx.strokeStyle = "#5a5a5a";
  ctx.beginPath();
  ctx.moveTo(pad, axisY);
  ctx.lineTo(pad + innerW, axisY);
  ctx.stroke();

  ctx.fillStyle = "#8a8a8a";
  ctx.font = "10px ui-monospace, Consolas, monospace";
  const labels = [0, 0.25, 0.5, 0.75, 1].map((u) => {
    const bar = Math.round(u * maxB);
    return {
      x: pad + u * innerW,
      text: wallLabelForBar(bar)
    };
  });
  labels.forEach(({ x, text }) => {
    const tw = ctx.measureText(text).width;
    ctx.fillText(text, Math.max(pad, x - tw / 2), baseY);
  });
  if (loadMeta.start) {
    ctx.fillText(tickDateLabel(loadMeta.start, 0), pad, 92);
  }
  if (loadMeta.end) {
    const te = loadMeta.end;
    const tw = ctx.measureText(tickDateLabel(te, 1)).width;
    ctx.fillText(tickDateLabel(te, 1), rw - pad - tw, 92);
  }

  ctx.strokeStyle = "#4fc3f7";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(xPlay, 16);
  ctx.lineTo(xPlay, 50);
  ctx.stroke();
  ctx.fillStyle = "#4fc3f7";
  ctx.beginPath();
  ctx.moveTo(xPlay, 12);
  ctx.lineTo(xPlay - 4, 20);
  ctx.lineTo(xPlay + 4, 20);
  ctx.closePath();
  ctx.fill();
}

function drawTimelineMacro() {
  const c = $("timeline-macro-canvas");
  if (!c) {
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 800;
  const hCss = 40;
  c.width = w * dpr;
  c.height = hCss * dpr;
  const ctx = c.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  const rw = c.clientWidth;
  const pad = TIMELINE_PAD;
  const innerW = Math.max(1, rw - 2 * pad);
  const axisY = 21;

  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, rw, hCss);
  if (loadMeta.bars <= 0) {
    ctx.fillStyle = "#666";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText("Macro overview (load CSV)", pad, 24);
    return;
  }

  const maxB = loadMeta.bars - 1;
  const tPlay = maxB > 0 ? playheadBar / maxB : 0;
  const xPlay = pad + tPlay * innerW;

  const grd = ctx.createLinearGradient(0, 0, rw, 0);
  grd.addColorStop(0, "rgba(79, 195, 247, 0.08)");
  grd.addColorStop(0.5, "rgba(79, 195, 247, 0.02)");
  grd.addColorStop(1, "rgba(79, 195, 247, 0.07)");
  ctx.fillStyle = grd;
  ctx.fillRect(pad, 3, innerW, 14);

  ctx.strokeStyle = "#4a5560";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, axisY);
  ctx.lineTo(pad + innerW, axisY);
  ctx.stroke();

  ctx.fillStyle = "#7d8b96";
  ctx.font = "9px ui-monospace, Consolas, monospace";
  const drawTick = (bar, lbl) => {
    const tx = pad + (maxB > 0 ? (bar / maxB) * innerW : 0);
    ctx.strokeStyle = "rgba(90, 110, 128, 0.5)";
    ctx.beginPath();
    ctx.moveTo(tx, 6);
    ctx.lineTo(tx, axisY + 2);
    ctx.stroke();
    const tw = ctx.measureText(lbl).width;
    let lx = tx - tw / 2;
    if (lx < pad) {
      lx = pad;
    }
    if (lx + tw > rw - pad) {
      lx = rw - pad - tw;
    }
    ctx.fillStyle = "#7d8b96";
    ctx.fillText(lbl, lx, axisY + 11);
  };

  if (timelineAxisTicks.length > 0) {
    for (const t of timelineAxisTicks) {
      drawTick(t.bar, formatWallCompact(t.wall));
    }
  } else {
    for (let i = 0; i <= 4; i++) {
      const u = i / 4;
      const bar = Math.round(u * maxB);
      drawTick(bar, String(bar));
    }
  }

  ctx.strokeStyle = "#4fc3f7";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(xPlay, 2);
  ctx.lineTo(xPlay, axisY + 1);
  ctx.stroke();
  ctx.fillStyle = "#4fc3f7";
  ctx.beginPath();
  ctx.moveTo(xPlay, 1);
  ctx.lineTo(xPlay - 3, 7);
  ctx.lineTo(xPlay + 3, 7);
  ctx.closePath();
  ctx.fill();
}

function tickDateLabel(s, which) {
  if (!s) {
    return "—";
  }
  if (s.length >= 10) {
    return s.slice(0, 10);
  }
  return s;
}

function bindTimeline() {
  const micro = $("timeline-canvas");
  const macro = $("timeline-macro-canvas");
  if (!micro) {
    return;
  }

  const bindSeek = (/** @type {HTMLCanvasElement} */ cv) => {
    cv.addEventListener("pointerdown", (e) => {
      if (loadMeta.bars <= 0) {
        return;
      }
      e.preventDefault();
      dragActive = true;
      cv.setPointerCapture(e.pointerId);
      scheduleSeekFromDrag(barFromClientX(cv, e.clientX));
    });
    cv.addEventListener("pointermove", (e) => {
      if (!dragActive || loadMeta.bars <= 0) {
        return;
      }
      e.preventDefault();
      scheduleSeekFromDrag(barFromClientX(cv, e.clientX));
    });
    cv.addEventListener("pointerup", (e) => {
      if (dragActive) {
        dragActive = false;
        try {
          cv.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        clearTimeout(seekDebounce);
        const b = barFromClientX(cv, e.clientX);
        void seekToBar(b);
      }
    });
    cv.addEventListener("pointercancel", () => {
      dragActive = false;
      clearTimeout(seekDebounce);
    });
  };

  bindSeek(micro);
  if (macro) {
    bindSeek(macro);
  }

  micro.addEventListener("wheel", (e) => {
    if (loadMeta.bars <= 0) {
      return;
    }
    e.preventDefault();
    const d = e.deltaY > 0 ? 1 : -1;
    const nb = playheadBar + d;
    void seekToBar(nb);
  }, { passive: false });

  micro.addEventListener("keydown", (e) => {
    if (loadMeta.bars <= 0) {
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      void seekToBar(playheadBar - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      void seekToBar(playheadBar + 1);
    }
  });
}

async function onPing() {
  const api = getBridgeApi();
  if (!api || typeof api.ping !== "function") {
    setConn(
      false,
      "No bridge API — check preload (open DevTools) or run: npm start in OTL-MarketLab/electron"
    );
    return;
  }
  try {
    const line = await api.ping();
    const p = parseOkLine(line);
    setConn(!!p.ok, p.ok ? "Bridge: " + (p.json && p.json.event ? p.json.event : "OK") : "Bridge: ERR");
  } catch (e) {
    setConn(false, "Bridge: " + bridgeErrorMessage(e));
  }
}

async function onLoad() {
  const api = getBridgeApi();
  if (!api || typeof api.pickCsv !== "function" || typeof api.loadData !== "function") {
    setConn(false, "No bridge API — cannot open file picker. Check Electron preload path.");
    return;
  }
  let r;
  try {
    r = await api.pickCsv();
  } catch (e) {
    setConn(false, "CSV dialog: " + bridgeErrorMessage(e));
    return;
  }
  if (r.canceled) {
    return;
  }
  try {
    const line = await api.loadData(r.path);
    const p = parseOkLine(line);
    if (p.ok && p.json) {
      applyLoadJson(p.json);
      const pth = p.json.path || "—";
      const short = pth.length > 36 ? "…" + pth.slice(-34) : pth;
      document.querySelectorAll(".md-graph-path-sync").forEach((el) => {
        el.textContent = short;
        el.setAttribute("title", pth);
      });
      const npp = $("npanel-md-path");
      if (npp) {
        npp.textContent = short;
        npp.setAttribute("title", pth);
      }
      clearMetricTiles();
      addMetricTile("load", pth, "ok");
      addMetricTile("bars", String(p.json.bars ?? "—"), "ok");
      if (window.MLWorkbench && typeof window.MLWorkbench.reapplyPortfolioToHost === "function") {
        await window.MLWorkbench.reapplyPortfolioToHost({ skipResync: true });
      }
      await seekToBar(playheadBar);
    } else {
      setConn(false, "Load failed (see console)");
    }
  } catch (e) {
    setConn(false, "LOAD_DATA: " + bridgeErrorMessage(e));
  }
}

async function onSeek() {
  const api = getBridgeApi();
  if (!api || typeof api.seek !== "function") {
    setConn(false, "No bridge API for SEEK");
    return;
  }
  const t = ($("seek-input") && $("seek-input").value) || "0";
  try {
    const line = await api.seek(t);
    const p = parseOkLine(line);
    if (p.ok && p.json) {
      if (p.json.bar != null) {
        playheadBar = p.json.bar;
      }
      renderTelemetryFromSeek(p.json);
      drawTimeline();
      drawTimelineMacro();
      updateTimelineStatus();
    }
  } catch (e) {
    setConn(false, "SEEK: " + bridgeErrorMessage(e));
  }
}

window.addEventListener("DOMContentLoaded", () => {
  // Must be set before MLWorkbench.init(): Apply → SET_UBER_SIGNAL / SET_PORTFOLIO → re-SEEK so node_states/telemetry match.
  const seekResync = function () {
    return seekToBar(playheadBar);
  };
  window.MLRendererSeekRefresh = seekResync;
  window.__mlabSeekResync = seekResync;

  // Wire host actions first. If workbench init throws, Ping / Load / Seek must still work.
  $("btn-ping") && $("btn-ping").addEventListener("click", () => void onPing());
  $("btn-load") && $("btn-load").addEventListener("click", () => void onLoad());
  $("btn-seek") && $("btn-seek").addEventListener("click", () => void onSeek());
  const npItem = document.getElementById("npanel-item-body");
  if (npItem) {
    npItem.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof Element)) {
        return;
      }
      if (t.closest("#btn-load-npanel")) {
        e.preventDefault();
        void onLoad();
      }
    });
  }

  if (window.MLWorkbench && typeof window.MLWorkbench.init === "function") {
    try {
      window.MLWorkbench.init();
    } catch (e) {
      console.error("MLWorkbench.init failed", e);
      setConn(false, "Workbench: " + bridgeErrorMessage(e));
    }
  }

  drawTimelineMacro();
  drawTimeline();
  updateTimelineUIMode();
  bindTimeline();
  window.addEventListener("resize", () => {
    drawTimelineMacro();
    drawTimeline();
  });
  void onPing();

  window.addEventListener("mlab-uber-updated", () => {
    if (loadMeta.bars > 0) {
      void seekToBar(playheadBar);
    }
  });
});
