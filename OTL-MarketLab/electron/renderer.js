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
let playheadBar = 0;
let dragActive = false;
let seekDebounce = null;

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

function renderTelemetryFromSeek(j) {
  if (!j) {
    return;
  }
  const t = j.telemetry || {};
  const ns = j.node_states || {};
  clearMetricTiles();

  addMetricTile("bar", j.bar != null ? String(j.bar) : "—", "ok");
  const wall =
    j.bar_label != null && j.bar_label !== ""
      ? String(j.bar_label)
      : j.wall_time != null
        ? String(j.wall_time)
        : "—";
  addMetricTile("wall time", wall, "ok");

  const keys = Object.keys(ns).filter((k) => k !== "map_from");
  for (const k of keys) {
    addMetricTile(k, formatNum(/** @type {number} */ (ns[k])), "ok");
  }
  if (Array.isArray(j.m_attrs_for_osl) && j.m_attrs_for_osl.length) {
    addMetricTile("m_attrs_for_osl", j.m_attrs_for_osl.join(", "), "ok");
  }

  const tail = t.close_tail;
  if (Array.isArray(tail) && tail.length) {
    const s = tail.slice(-6).map((x) => formatNum(x)).join(", ");
    addMetricTile("close tail (6)", s, "ok");
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
}

function updateTimelineStatus() {
  const st = $("timeline-status");
  const c = $("timeline-canvas");
  if (!st) {
    return;
  }
  if (loadMeta.bars <= 0) {
    st.textContent = "Load a CSV to enable scrub";
    if (c) {
      c.setAttribute("aria-valuemax", "0");
      c.setAttribute("aria-valuemin", "0");
      c.setAttribute("aria-valuenow", "0");
    }
    return;
  }
  const start = loadMeta.start || "?";
  const end = loadMeta.end || "?";
  st.textContent = `Loaded ${loadMeta.bars} bars · ${start} → ${end}`;
  if (c) {
    c.setAttribute("aria-valuemax", String(loadMeta.bars - 1));
    c.setAttribute("aria-valuemin", "0");
    c.setAttribute("aria-valuenow", String(playheadBar));
    c.setAttribute("aria-label", `Time axis, bar ${playheadBar} of ${loadMeta.bars}`);
  }
}

function applyLoadJson(j) {
  loadMeta = {
    bars: typeof j.bars === "number" ? j.bars : 0,
    start: j.time_range && j.time_range.start ? j.time_range.start : null,
    end: j.time_range && j.time_range.end ? j.time_range.end : null,
    path: j.path || null
  };
  playheadBar = loadMeta.bars > 0 ? loadMeta.bars - 1 : 0;
  updateTimelineStatus();
  drawTimeline();
}

function barFromClientX(clientX) {
  const c = $("timeline-canvas");
  if (!c || loadMeta.bars <= 0) {
    return 0;
  }
  const r = c.getBoundingClientRect();
  const pad = 14;
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
    ghost.textContent = `scrub bar ${b}`;
  }
  drawTimeline();
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
  const pad = 14;
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
    return { x: pad + u * innerW, text: String(bar) };
  });
  labels.forEach(({ x, text }) => {
    ctx.fillText(text, x - 6, baseY);
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
  const c = $("timeline-canvas");
  if (!c) {
    return;
  }
  c.addEventListener("pointerdown", (e) => {
    if (loadMeta.bars <= 0) {
      return;
    }
    e.preventDefault();
    dragActive = true;
    c.setPointerCapture(e.pointerId);
    scheduleSeekFromDrag(barFromClientX(e.clientX));
  });
  c.addEventListener("pointermove", (e) => {
    if (!dragActive || loadMeta.bars <= 0) {
      return;
    }
    e.preventDefault();
    scheduleSeekFromDrag(barFromClientX(e.clientX));
  });
  c.addEventListener("pointerup", (e) => {
    if (dragActive) {
      dragActive = false;
      try {
        c.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      clearTimeout(seekDebounce);
      const b = barFromClientX(e.clientX);
      void seekToBar(b);
    }
  });
  c.addEventListener("pointercancel", () => {
    dragActive = false;
    clearTimeout(seekDebounce);
  });
  c.addEventListener("wheel", (e) => {
    if (loadMeta.bars <= 0) {
      return;
    }
    e.preventDefault();
    const d = e.deltaY > 0 ? 1 : -1;
    const nb = playheadBar + d;
    void seekToBar(nb);
  }, { passive: false });

  c.addEventListener("keydown", (e) => {
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
      const md = $("node-val-md-path");
      const short = pth.length > 36 ? "…" + pth.slice(-34) : pth;
      if (md) {
        md.textContent = short;
        md.setAttribute("title", pth);
      }
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

  drawTimeline();
  bindTimeline();
  window.addEventListener("resize", () => drawTimeline());
  void onPing();

  window.addEventListener("mlab-uber-updated", () => {
    if (loadMeta.bars > 0) {
      void seekToBar(playheadBar);
    }
  });
});
