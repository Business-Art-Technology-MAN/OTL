/* global */
/**
 * N-Panel, node board: backdrop is static; only #board-graph is panned & zoomed.
 * Nodes are draggable; wires follow socket positions.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "mlabNPanelCollapsed";
  let selectedId = "market-data";
  /** @type {object | null} */
  let lastSeekJson = null;
  let panX = 0;
  let panY = 0;
  let scale = 1;
  const MIN_SCALE = 0.5;
  const MAX_SCALE = 2.5;

  let backdropChart = null;
  let closeLineSeries = null;
  let shadowLineSeries = null;
  /** Drawdown area when Portfolio node is selected (data from `telemetry.portfolio`). */
  let portfolioDdSeries = null;
  /** Buy & hold benchmark line when Analysis node is selected (`telemetry.analysis.buy_hold_tail`). */
  let analysisBuyHoldLineSeries = null;
  /** Strategy wealth (`telemetry.analysis.wealth_tail`) — right scale vs faded reference prices on left. */
  let analysisWealthLineSeries = null;
  let backdropResizeObserver = null;
  const PORTFOLIO_UI_KEY = "mlabPortfolioUiV1";
  /** `localStorage` for Uber N-panel OSL shader directory (path sent as `lab.osl_shader_dir`). */
  const MLAB_OSL_SHADER_DIR_KEY = "mlab.osl_shader_dir";
  /** Index into SEEK `per_asset_telemetry` / `node_states_by_asset` (UI only; one CSV row may have N close columns). */
  const MLAB_ASSET_KEY = "mlab.selected_asset_index";
  /** Persisted pan/zoom + pipeline node positions + layout frame notes (see `+ Frame`). */
  const GRAPH_LAYOUT_KEY = "mlab.graphLayoutV1";
  const CORE_GRAPH_IDS = ["market-data", "signal-otl", "portfolio-mix", "analysis-metrics"];
  /** Primary Uber / bridge nodes (one host config). Duplicates share N-Panel by `data-kind`. */
  const PRIMARY_TEMPLATE_ID = {
    md: "market-data",
    sig: "signal-otl",
    port: "portfolio-mix",
    ana: "analysis-metrics",
  };
  /** @type {Array<{ id: string, from: [string, string], to: [string, string], w: string }>} */
  let graphEdges = [];
  const DEFAULT_GRAPH_EDGES = /** @type {const} */ ([
    {
      id: "e-def-md-sig",
      from: /** @type {[string, string]} */ (["market-data", "out"]),
      to: /** @type {[string, string]} */ (["signal-otl", "in"]),
      w: "stream",
    },
    {
      id: "e-def-sig-p1",
      from: ["signal-otl", "out"],
      to: ["portfolio-mix", "in1"],
      w: "scalar",
    },
    {
      id: "e-def-sig-p2",
      from: ["signal-otl", "out"],
      to: ["portfolio-mix", "in2"],
      w: "scalar",
    },
    {
      id: "e-def-sig-p3",
      from: ["signal-otl", "out"],
      to: ["portfolio-mix", "in3"],
      w: "scalar",
    },
    {
      id: "e-def-p-ana",
      from: ["portfolio-mix", "odata"],
      to: ["analysis-metrics", "in"],
      w: "pipe",
    },
  ]);
  const SVG_NS = "http://www.w3.org/2000/svg";
  /** Set in `initBoardInteraction` so new frame nodes get drag wiring. */
  /** @type {null | ((g: SVGGElement) => void)} */
  let wireNodeDragImpl = null;

  function getLC() {
    return window.LightweightCharts;
  }

  /**
   * @param {unknown} time lightweight-charts Time
   * @returns {Date}
   */
  function chartTimeToUtcDate(time) {
    if (typeof time === "number") {
      return new Date(time * 1000);
    }
    if (time && typeof time === "object" && "year" in /** @type {object} */ (time)) {
      const bd = /** @type {{ year: number; month: number; day: number }} */ (time);
      return new Date(Date.UTC(bd.year, bd.month - 1, bd.day));
    }
    if (typeof time === "string") {
      const t = Date.parse(time.includes("T") ? time : `${time}T00:00:00Z`);
      if (!Number.isNaN(t)) {
        return new Date(t);
      }
    }
    return new Date();
  }

  /**
   * X-axis tick labels always include the calendar year (UTC).
   * @param {typeof window.LightweightCharts} LC
   * @returns {(time: unknown, tickMarkType: number, locale: string) => string | null}
   */
  function makeTickMarkFormatter(LC) {
    const T = LC.TickMarkType;
    return function formatXAxisTick(time, tickMarkType, locale) {
      const d = chartTimeToUtcDate(time);
      const y = d.getUTCFullYear();
      const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      if (tickMarkType === T.Year) {
        return String(y);
      }
      if (tickMarkType === T.Month) {
        return `${y}-${mo}`;
      }
      if (tickMarkType === T.DayOfMonth) {
        return `${y}-${mo}-${day}`;
      }
      if (tickMarkType === T.Time || tickMarkType === T.TimeWithSeconds) {
        return d.toLocaleString(locale || "en-US", {
          timeZone: "UTC",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
      }
      return null;
    };
  }

  /**
   * @param {string | null} barLabel
   * @param {number} playheadBar
   * @returns {number} UTCTimestamp (seconds) for the bar at the right end of the tail
   */
  function barTimeSeconds(barLabel, playheadBar) {
    if (barLabel && typeof barLabel === "string" && /^\d{4}-\d{2}-\d{2}/.test(barLabel)) {
      const s = barLabel.slice(0, 10) + "T00:00:00Z";
      const t = Date.parse(s);
      if (!Number.isNaN(t)) {
        return Math.floor(t / 1000);
      }
    }
    return 1577836800 + (playheadBar | 0) * 86400;
  }

  /**
   * @param {object} j
   * @returns {{ time: number; value: number }[]}
   */
  /**
   * @param {object} j seek JSON
   * @param {number[]|null|undefined} tail
   * @returns {{ time: number; value: number }[]}
   */
  function tailToLineData(j, tail) {
    if (!Array.isArray(tail) || tail.length < 2) {
      return [];
    }
    const n = tail.length;
    const lab = j.bar_label != null && j.bar_label !== "" ? j.bar_label : j.wall_time;
    const endT = barTimeSeconds(lab != null ? String(lab) : null, j.bar != null ? j.bar : 0);
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = Number(tail[i]);
      if (Number.isNaN(v)) {
        continue;
      }
      const time = endT - (n - 1 - i) * 86400;
      out.push({ time, value: v });
    }
    return out;
  }

  function closeTailToLineData(j) {
    const t = j && j.telemetry;
    const tail = t && t.close_tail;
    return tailToLineData(j, tail);
  }

  function readPreferredAssetIndex() {
    try {
      const s = localStorage.getItem(MLAB_ASSET_KEY);
      if (s == null) {
        return 0;
      }
      return parseInt(s, 10) || 0;
    } catch {
      return 0;
    }
  }

  function savePreferredAssetIndex(/** @type {number} */ n) {
    try {
      localStorage.setItem(MLAB_ASSET_KEY, String(n | 0));
    } catch {
      // ignore
    }
  }

  /// Clamps 0..N-1; prefers stored index when a new file has the same or larger N.
  function getClampedSelectedAssetIndex(/** @type {object} */ j) {
    const n = j && typeof j.assets === "number" ? (j.assets | 0) : 0;
    if (n <= 0) {
      return 0;
    }
    let want = readPreferredAssetIndex();
    if (want < 0) {
      want = 0;
    }
    if (want >= n) {
      want = n - 1;
    }
    return want;
  }

  /**
   * Backdrop tail of close prices keyed to **`analysis_asset_index`** (same column as Analysis / preview).
   * @param {object} j
   */
  function resolveCloseTailLineData(/** @type {object} */ j) {
    let data = closeTailToLineData(j);
    const aidx = getClampedSelectedAssetIndex(j);
    const pat = j.per_asset_telemetry;
    if (Array.isArray(pat) && pat[aidx]) {
      const pa = pat[aidx];
      if (pa && typeof pa === "object" && pa.close_tail && arrOk(/** @type {unknown} */ (pa).close_tail)) {
        data = tailToLineData(j, /** @type {number[]} */ (pa.close_tail));
      }
    }
    return data;
  }

  /**
   * @param {object} j seek JSON
   * @param {number} aidx
   * @returns {Record<string, unknown>|null}
   */
  function getNodeStatesForAsset(/** @type {object} */ j, /** @type {number} */ aidx) {
    const bya = j && j.node_states_by_asset;
    if (Array.isArray(bya) && aidx >= 0 && aidx < bya.length) {
      const o = bya[aidx];
      if (o && typeof o === "object") {
        return /** @type {Record<string, unknown>} */ (o);
      }
    }
    const ns = j && j.node_states;
    return ns && typeof ns === "object" ? /** @type {Record<string, unknown>} */ (ns) : null;
  }

  function isPriceScaleShadow(/** @type {string} */ mAttr) {
    if (!mAttr) {
      return true;
    }
    if (mAttr === "m_close" || mAttr.startsWith("m_sma")) {
      return true;
    }
    if (mAttr.startsWith("m_bb") && mAttr.indexOf("bbw") < 0) {
      return true;
    }
    return false;
  }

  /**
   * Default backdrop series when the previous selection is no longer in the list.
   * Prefer SMA over m_close: the host only fills shadow_overlay from `try_get_m_series`, and
   * m_close is often not a series there — so m_close as primary yields no shadow line.
   * @param {string[]} attrs from SEEK `m_attrs_for_osl`
   * @returns {string}
   */
  function defaultUberPrimaryFromAttrs(/** @type {string[]} */ attrs) {
    if (!Array.isArray(attrs) || !attrs.length) {
      return "m_close";
    }
    const sma = attrs.find((a) => a.startsWith("m_sma_"));
    if (sma) {
      return sma;
    }
    const close = attrs.find((a) => a === "m_close");
    if (close) {
      return close;
    }
    const firstOk = attrs.find((a) => isPriceScaleShadow(a));
    if (firstOk) {
      return firstOk;
    }
    return attrs[0];
  }

  function initBackdropChart() {
    const LC = getLC();
    const el = $("backdrop-chart");
    if (!el) {
      return;
    }
    if (!LC || typeof LC.createChart !== "function") {
      el.textContent = "lightweight-charts not loaded. Run: npm install";
      return;
    }
    const ColorType = LC.ColorType;
    const solid = ColorType && ColorType.Solid != null ? ColorType.Solid : "solid";
    const loc = typeof navigator !== "undefined" ? navigator.language : "en-US";
    const baseOpts = {
      autoSize: true,
      layout: {
        background: { type: solid, color: "#0d0d0d" },
        textColor: "#9e9e9e",
        fontSize: 11,
        fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace',
      },
      localization: {
        locale: loc,
        dateFormat: "yyyy-MM-dd",
      },
      grid: {
        vertLines: { color: "#2a2a2a" },
        horzLines: { color: "#2a2a2a" },
      },
      rightPriceScale: { borderColor: "#3a3a3a" },
      timeScale: {
        borderColor: "#3a3a3a",
        tickMarkMaxCharacterLength: 12,
        tickMarkFormatter: makeTickMarkFormatter(LC),
      },
      crosshair: { mode: LC.CrosshairMode != null ? LC.CrosshairMode.Normal : 0 },
      handleScroll: false,
      handleScale: false,
    };
    try {
      backdropChart = LC.createChart(el, baseOpts);
    } catch (e1) {
      console.warn("MLWorkbench: createChart retry minimal", e1);
      try {
        backdropChart = LC.createChart(el, {
          layout: { background: { color: "#0d0d0d" } },
          localization: { locale: loc, dateFormat: "yyyy-MM-dd" },
          timeScale: {
            tickMarkMaxCharacterLength: 12,
            tickMarkFormatter: makeTickMarkFormatter(LC),
          },
          handleScroll: false,
          handleScale: false,
        });
      } catch (e2) {
        console.warn("MLWorkbench: createChart failed", e2);
        el.textContent = "Chart could not be created. Node graph and bridge still work.";
        backdropChart = null;
      }
    }
    try {
      const LineS = LC.LineSeries;
      const lineOpts = {
        color: "rgba(100, 180, 120, 0.9)",
        lineWidth: 2,
        title: "close (tail)",
      };
      if (LineS && typeof backdropChart.addSeries === "function") {
        closeLineSeries = backdropChart.addSeries(LineS, lineOpts);
      } else if (typeof backdropChart.addLineSeries === "function") {
        closeLineSeries = backdropChart.addLineSeries(lineOpts);
      }
    } catch (err) {
      console.warn("MLWorkbench: line series", err);
    }
    try {
      const LineS = LC.LineSeries;
      const shOpts = {
        color: "rgba(255, 168, 72, 0.42)",
        lineWidth: 1,
        title: "uber shadow",
        visible: true,
      };
      if (LineS && backdropChart && typeof backdropChart.addSeries === "function") {
        shadowLineSeries = backdropChart.addSeries(LineS, shOpts);
      } else if (typeof backdropChart.addLineSeries === "function") {
        shadowLineSeries = backdropChart.addLineSeries(shOpts);
      }
    } catch (e2) {
      console.warn("MLWorkbench: shadow line series", e2);
    }
    const outer = $("node-board-outer");
    if (outer && typeof ResizeObserver !== "undefined") {
      const sync = () => {
        if (!backdropChart) {
          return;
        }
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (w > 0 && h > 0) {
          backdropChart.applyOptions({ width: w, height: h });
        }
      };
      sync();
      backdropResizeObserver = new ResizeObserver(() => {
        sync();
      });
      backdropResizeObserver.observe(outer);
    }
    try {
      const AS = LC.AreaSeries;
      if (AS && backdropChart && typeof backdropChart.addSeries === "function") {
        portfolioDdSeries = backdropChart.addSeries(AS, {
          lineColor: "rgba(220, 60, 60, 0.55)",
          topColor: "rgba(200, 40, 40, 0.2)",
          bottomColor: "rgba(10, 0, 0, 0.2)",
          title: "drawdown (synth · close tail)",
          priceScaleId: "dd",
        });
        if (typeof portfolioDdSeries.priceScale === "function") {
          portfolioDdSeries.priceScale().applyOptions({ scaleMargins: { top: 0.2, bottom: 0 } });
        }
        portfolioDdSeries.applyOptions({ visible: false });
        portfolioDdSeries.setData([]);
      }
    } catch (e) {
      console.warn("MLWorkbench: portfolio drawdown area series", e);
    }
    try {
      const LineS = LC.LineSeries;
      const bhOpts = {
        color: "rgba(150, 150, 150, 0.65)",
        lineWidth: 1,
        title: "buy & hold (host)",
        visible: false,
        priceScaleId: "right",
      };
      if (LineS && backdropChart && typeof backdropChart.addSeries === "function") {
        analysisBuyHoldLineSeries = backdropChart.addSeries(LineS, bhOpts);
      } else if (backdropChart && typeof backdropChart.addLineSeries === "function") {
        analysisBuyHoldLineSeries = backdropChart.addLineSeries(bhOpts);
      }
      if (LineS && backdropChart && typeof backdropChart.addSeries === "function") {
        const wOpts = {
          color: "rgba(186, 104, 200, 0.95)",
          lineWidth: 2,
          title: "strategy wealth (host)",
          visible: false,
          priceScaleId: "right",
        };
        analysisWealthLineSeries = backdropChart.addSeries(LineS, wOpts);
      } else if (backdropChart && typeof backdropChart.addLineSeries === "function") {
        analysisWealthLineSeries = backdropChart.addLineSeries({
          color: "rgba(186, 104, 200, 0.95)",
          lineWidth: 2,
          title: "strategy wealth (host)",
          visible: false,
          priceScaleId: "right",
        });
      }
    } catch (e) {
      console.warn("MLWorkbench: analysis B&H line", e);
    }
  }

  /**
   * @typedef {{ method: 'equal'|'strength'|'risk', leverage: number, commBps: number, slippageBps: number, integrator: 'close_proxy'|'gal_m1' }} PortfolioUiV1
   */

  /** @returns {PortfolioUiV1} */
  function defaultPortfolioUi() {
    return { method: "equal", leverage: 1, commBps: 2, slippageBps: 5, integrator: "close_proxy" };
  }

  /** @returns {PortfolioUiV1} */
  function loadPortfolioUi() {
    try {
      const raw = localStorage.getItem(PORTFOLIO_UI_KEY);
      if (!raw) {
        return defaultPortfolioUi();
      }
      const o = JSON.parse(raw);
      if (!o || typeof o !== "object") {
        return defaultPortfolioUi();
      }
      const m = o.method;
      const method = m === "strength" || m === "risk" ? m : "equal";
      const lev = Number(o.leverage);
      const c = Number(o.commBps);
      const s = Number(o.slippageBps);
      const integ = o.integrator === "gal_m1" ? "gal_m1" : "close_proxy";
      return {
        method,
        integrator: integ,
        leverage: !Number.isFinite(lev) ? 1 : Math.min(5, Math.max(0.25, lev)),
        commBps: !Number.isFinite(c) ? 2 : Math.max(0, c),
        slippageBps: !Number.isFinite(s) ? 5 : Math.max(0, s),
      };
    } catch {
      return defaultPortfolioUi();
    }
  }

  /** @param {PortfolioUiV1} ui */
  function savePortfolioUi(ui) {
    try {
      localStorage.setItem(PORTFOLIO_UI_KEY, JSON.stringify(ui));
    } catch {
      // ignore
    }
  }

  /** Host `telemetry.analysis` (ANLY-CALC). */
  function getAnalysisTelemetry(/** @type {object} */ j) {
    const t = j && j.telemetry;
    const a = t && t.analysis;
    if (!a || typeof a !== "object") {
      return null;
    }
    const w = a.wealth_tail;
    if (!Array.isArray(w) || w.length < 2) {
      return null;
    }
    const bh = a.buy_hold_tail;
    return {
      wealthTail: w.map((x) => Number(x)),
      buyHoldTail: Array.isArray(bh) && bh.length === w.length ? bh.map((x) => Number(x)) : null,
      summary: a.summary && typeof a.summary === "object" ? a.summary : null,
      preview: Array.isArray(a.preview) ? a.preview : [],
      previewPlayheadIndex:
        typeof a.preview_playhead_index === "number" ? a.preview_playhead_index : 0,
      signalAttr: a.signal_attr != null ? String(a.signal_attr) : "",
    };
  }

  function setBackdropLogScale(/** @type {boolean} */ enabled) {
    if (!backdropChart) {
      return;
    }
    const LC = getLC();
    let mode = 0;
    let norm = 0;
    if (LC && LC.PriceScaleMode) {
      mode = enabled ? LC.PriceScaleMode.Logarithmic : LC.PriceScaleMode.Normal;
      norm = LC.PriceScaleMode.Normal;
    } else {
      mode = enabled ? 1 : 0;
      norm = 0;
    }
    try {
      if (typeof backdropChart.priceScale === "function") {
        backdropChart.priceScale("right").applyOptions({ mode: mode });
        if (enabled) {
          backdropChart.priceScale("left").applyOptions({ mode: norm });
        }
      } else {
        backdropChart.applyOptions({
          rightPriceScale: { mode: mode },
        });
      }
    } catch (e) {
      console.warn("MLWorkbench: price scale mode", e);
    }
  }

  function backdropLeftScaleVisible(show) {
    if (!backdropChart || typeof backdropChart.priceScale !== "function") {
      return;
    }
    try {
      backdropChart.priceScale("left").applyOptions({
        visible: !!show,
        borderColor: "#3a3a3a",
      });
    } catch (e) {
      console.warn("MLWorkbench: left price scale visibility", e);
    }
  }

  /** Revert dual-scale Analysis backdrop so Portfolio / Uber nodes use single right scale equity or close. */
  function detachAnalysisEquityBackdrop() {
    backdropLeftScaleVisible(false);
    if (closeLineSeries) {
      try {
        closeLineSeries.applyOptions({ priceScaleId: "right", lineWidth: 2 });
      } catch {
        /* ignore */
      }
    }
    if (analysisWealthLineSeries) {
      analysisWealthLineSeries.setData([]);
      analysisWealthLineSeries.applyOptions({ visible: false });
    }
    if (analysisBuyHoldLineSeries) {
      analysisBuyHoldLineSeries.setData([]);
      analysisBuyHoldLineSeries.applyOptions({ visible: false });
    }
  }

  /** Host `telemetry.portfolio` (no client-side PnL math). */
  function getPortfolioTelemetry(/** @type {object} */ j) {
    const t = j && j.telemetry;
    const p = t && t.portfolio;
    if (!p || typeof p !== "object") {
      return null;
    }
    const eq =
      p.integrator === "gal_m1" && Array.isArray(p.equity_tail_gal) && p.equity_tail_gal.length >= 2
        ? p.equity_tail_gal
        : p.equity_tail;
    if (!Array.isArray(eq) || eq.length < 2) {
      return null;
    }
    const dd = p.drawdown_tail;
    return {
      equityTail: eq.map((x) => Number(x)),
      ddTail: Array.isArray(dd) && dd.length === eq.length ? dd.map((x) => Number(x)) : null,
      stats: p.stats && typeof p.stats === "object" ? p.stats : null,
    };
  }

  function portfolioTailsToLineData(/** @type {object} */ j, /** @type {number[]} */ equityTail, /** @type {number[]|null} */ ddTail) {
    const ref = closeTailToLineData(j);
    if (!ref || ref.length < 2 || equityTail.length !== ref.length) {
      return null;
    }
    const equity = ref.map((p, i) => ({ time: p.time, value: Number(equityTail[i]) }));
    const dd =
      ddTail && ddTail.length === ref.length
        ? ref.map((p, i) => ({ time: p.time, value: -Math.abs(Number(ddTail[i])) }))
        : null;
    return { equity, dd };
  }

  function portfolioJsonForHost(/** @type {PortfolioUiV1} */ u) {
    const o = {
      integrator: u.integrator || "close_proxy",
      method: u.method,
      leverage: u.leverage,
      comm_bps: u.commBps,
      slippage_bps: u.slippageBps,
    };
    if (lastSeekJson && typeof lastSeekJson.assets === "number" && (lastSeekJson.assets | 0) > 1) {
      /** @type {Record<string, unknown>} */ (o).analysis_asset_index = getClampedSelectedAssetIndex(
        /** @type {object} */ (lastSeekJson)
      );
    }
    return JSON.stringify(o);
  }

  let portfolioHostPushTimer = 0;
  function schedulePushPortfolioToHost() {
    if (portfolioHostPushTimer) {
      clearTimeout(portfolioHostPushTimer);
    }
    portfolioHostPushTimer = window.setTimeout(() => {
      portfolioHostPushTimer = 0;
      void pushPortfolioToHost();
    }, 200);
  }

  /**
   * Pushes N-panel portfolio JSON to the host (`SET_PORTFOLIO`).
   * @param {{ skipResync?: boolean } | void} [opts] If `skipResync`, do not re-SEEK (caller will SEEK).
   */
  async function pushPortfolioToHost(opts) {
    const ml = window.marketLab;
    if (!ml || typeof ml.setPortfolioConfig !== "function") {
      return;
    }
    const u = getEffectivePortfolioUi();
    const skip = opts && opts.skipResync;
    try {
      const line = await ml.setPortfolioConfig(portfolioJsonForHost(u));
      if (typeof line === "string" && line.indexOf("OK ") === 0 && !skip) {
        const fn = window.__mlabSeekResync;
        if (typeof fn === "function") {
          fn();
        }
      }
    } catch (e) {
      console.warn("MLWorkbench: setPortfolioConfig", e);
    }
  }

  function updateBackdropFloatingLabel() {
    const el = $("backdrop-floating-lbl");
    if (!el) {
      return;
    }
    if (selEq("portfolio-mix")) {
      el.textContent = "EQUITY + DRAWDOWN (host · telemetry.portfolio)";
    } else if (selEq("analysis-metrics")) {
      el.textContent = "REF PRICE (left · linear) · WEALTH + BUY/HOLD (right · log)";
    } else {
      el.textContent = "BACKDROP";
    }
  }

  function syncMlabAssetRow(/** @type {object} */ j) {
    const row = /** @type {HTMLElement | null} */ ($("mlab-asset-row"));
    const sel = /** @type {HTMLSelectElement | null} */ ($("mlab-asset"));
    if (!row || !sel) {
      return;
    }
    const n = typeof j.assets === "number" ? (j.assets | 0) : 0;
    const pat = j.per_asset_telemetry;
    if (n > 1 && Array.isArray(pat) && pat.length === n) {
      row.style.removeProperty("display");
      const labels = Array.isArray(j.asset_labels) ? j.asset_labels : [];
      sel.replaceChildren();
      for (let a = 0; a < n; a++) {
        const o = document.createElement("option");
        o.value = String(a);
        const raw =
          typeof labels[a] === "string" && String(labels[a]).trim() !== ""
            ? String(labels[a]).trim()
            : "Asset " + a;
        o.textContent = raw.length > 44 ? raw.slice(0, 41) + "…" : raw;
        o.title = typeof labels[a] === "string" ? raw : "Asset " + a;
        sel.appendChild(o);
      }
      const idx = getClampedSelectedAssetIndex(j);
      sel.value = String(idx);
      savePreferredAssetIndex(idx);
    } else {
      row.style.display = "none";
    }
  }

  let mlabAssetSelectWired = false;
  function ensureMlabAssetSelectWired() {
    if (mlabAssetSelectWired) {
      return;
    }
    mlabAssetSelectWired = true;
    document.body.addEventListener(
      "change",
      (e) => {
        const t = e.target;
        if (!(t instanceof HTMLSelectElement) || t.id !== "mlab-asset") {
          return;
        }
        const v = parseInt(t.value, 10) || 0;
        savePreferredAssetIndex(v);
        if (lastSeekJson) {
          updateBackdropFromSeek(/** @type {object} */ (lastSeekJson));
          if (selEq("analysis-metrics")) {
            syncAnalysisPipelineNpanel();
            syncAnalysisDashboardNpanel();
            syncAnalysisPreviewNpanel();
          }
          schedulePushPortfolioToHost();
        }
      },
      true
    );
  }

  function updateBackdropFromSeek(/** @type {object} */ j) {
    if (!closeLineSeries) {
      return;
    }
    if (selEq("portfolio-mix")) {
      detachAnalysisEquityBackdrop();
      setBackdropLogScale(false);
      const pt = getPortfolioTelemetry(j);
      const mapped = pt ? portfolioTailsToLineData(j, pt.equityTail, pt.ddTail) : null;
      if (shadowLineSeries) {
        shadowLineSeries.setData([]);
        shadowLineSeries.applyOptions({ visible: false });
      }
      if (!mapped) {
        closeLineSeries.setData([]);
        if (portfolioDdSeries) {
          portfolioDdSeries.setData([]);
          portfolioDdSeries.applyOptions({ visible: false });
        }
        closeLineSeries.applyOptions({ title: "equity (host)" });
      } else {
        closeLineSeries.setData(mapped.equity);
        closeLineSeries.applyOptions({ title: "equity (host)" });
        if (portfolioDdSeries) {
          if (mapped.dd && mapped.dd.length > 0) {
            portfolioDdSeries.setData(mapped.dd);
            portfolioDdSeries.applyOptions({ visible: true });
          } else {
            portfolioDdSeries.setData([]);
            portfolioDdSeries.applyOptions({ visible: false });
          }
        }
        if (backdropChart) {
          backdropChart.timeScale().fitContent();
        }
      }
    } else if (selEq("analysis-metrics")) {
      backdropLeftScaleVisible(true);
      setBackdropLogScale(true);
      if (portfolioDdSeries) {
        portfolioDdSeries.setData([]);
        portfolioDdSeries.applyOptions({ visible: false });
      }
      if (shadowLineSeries) {
        shadowLineSeries.setData([]);
        shadowLineSeries.applyOptions({ visible: false });
      }
      const aidx = getClampedSelectedAssetIndex(j);
      const ref = resolveCloseTailLineData(j);
      const ctOk = !!(ref && ref.length >= 2);
      closeLineSeries.applyOptions({
        priceScaleId: "left",
        lineWidth: 1,
      });
      const refPriceTitle =
        typeof j.assets === "number" && (j.assets | 0) > 1 ? "close (ref · strip " + aidx + ")" : "close (reference)";
      if (ctOk && ref) {
        closeLineSeries.setData(ref);
        closeLineSeries.applyOptions({ visible: true, title: refPriceTitle });
      } else {
        closeLineSeries.setData([]);
      }
      const at = getAnalysisTelemetry(j);
      if (analysisWealthLineSeries) {
        if (at && ctOk && ref && Array.isArray(at.wealthTail) && at.wealthTail.length === ref.length) {
          const wealth = ref.map((p, i) => ({
            time: p.time,
            value: Number(at.wealthTail[i]),
          }));
          analysisWealthLineSeries.setData(wealth);
          analysisWealthLineSeries.applyOptions({ visible: true, title: "strategy wealth (host)" });
        } else {
          analysisWealthLineSeries.setData([]);
          analysisWealthLineSeries.applyOptions({ visible: false });
        }
      }
      if (analysisBuyHoldLineSeries) {
        const bhArr = at && Array.isArray(at.buyHoldTail) ? at.buyHoldTail : null;
        if (at && ctOk && ref && bhArr && bhArr.length === ref.length) {
          const bhd = ref.map((p, i) => ({
            time: p.time,
            value: Number(bhArr[i]),
          }));
          analysisBuyHoldLineSeries.setData(bhd);
          analysisBuyHoldLineSeries.applyOptions({ visible: true, title: "buy & hold (host)" });
        } else {
          analysisBuyHoldLineSeries.setData([]);
          analysisBuyHoldLineSeries.applyOptions({ visible: false });
        }
      }
      if (backdropChart) {
        backdropChart.timeScale().fitContent();
      }
    } else {
      detachAnalysisEquityBackdrop();
      setBackdropLogScale(false);
      const aidx = getClampedSelectedAssetIndex(j);
      const pat = j && j.per_asset_telemetry;
      let data = resolveCloseTailLineData(j);
      if (data.length < 2) {
        closeLineSeries.setData([]);
      } else {
        closeLineSeries.setData(data);
        if (backdropChart) {
          backdropChart.timeScale().fitContent();
        }
      }
      const aTitle = typeof j.assets === "number" && j.assets > 1 ? "close (tail · a=" + aidx + ")" : "close (tail)";
      closeLineSeries.applyOptions({ title: aTitle });
      if (portfolioDdSeries) {
        portfolioDdSeries.setData([]);
        portfolioDdSeries.applyOptions({ visible: false });
      }
      if (shadowLineSeries) {
        const patRow = Array.isArray(pat) && pat[aidx] ? pat[aidx] : null;
        const pax =
          patRow && typeof patRow === "object" && patRow.shadow_overlay
            ? patRow.shadow_overlay
            : null;
        const sh = pax && pax.m_attr != null ? pax : j && j.shadow_overlay;
        const a = sh && sh.m_attr != null ? String(sh.m_attr) : "";
        if (sh && arrOk(sh.tail) && canonicalNodeRole(selectedId) && isPriceScaleShadow(a)) {
          shadowLineSeries.applyOptions({ visible: true });
          shadowLineSeries.setData(tailToLineData(j, sh.tail));
        } else {
          shadowLineSeries.setData([]);
          shadowLineSeries.applyOptions({ visible: false });
        }
      }
    }
    if (j && j.m_attrs_for_osl) {
      updateUberPrimaryOptions(j.m_attrs_for_osl);
    }
    refreshBackdropHot();
  }

  function arrOk(/** @type {unknown} */ t) {
    return Array.isArray(t) && t.length >= 2;
  }

  /**
   * Socket centers (relative to node translate origin) keyed by `data-wire-k` on sockets.
   * @type {Record<string, Record<string, { x: number, y: number }>>}
   */
  const SOCKET_OFFSETS_BY_KIND = {
    md: { out: { x: 200, y: 100 } },
    sig: {
      in: { x: 0, y: 100 },
      out: { x: 220, y: 100 },
    },
    port: {
      in1: { x: 0, y: 52 },
      in2: { x: 0, y: 74 },
      in3: { x: 0, y: 96 },
      ocl: { x: 210, y: 64 },
      odata: { x: 210, y: 108 },
    },
    ana: { in: { x: 0, y: 100 } },
  };



  const NPANEL_TEXT = {
    "market-data": {
      title: "Yahoo / CSV · Market data",
      body:
        "Green <strong>Data stream</strong> output (OHLCV-aligned) for downstream nodes. Use <strong>Load CSV</strong> below to open a universe close file in the C++ host.",
      extra: "• Active file path is shown on this node and under the button\n• Scrub the timeline in the footer; explicit seek is in the N-Panel",
    },
    "signal-otl": {
      title: "Uber · VectorTA (OtlNodeSystem)",
      body:
        "Multi-toggle indicators bake into <code>otl::OtlUniverse</code> as <code>m_*</code> (VectorTA / <code>bake_series</code>). Use the <strong>controls below</strong> and <strong>Apply to host</strong> to send a JSON plan via <code>SET_UBER_SIGNAL</code>; the host re-<code>apply_to_asset</code> on the loaded close series.",
      extra:
        "• OSL <code>MarketDelegate</code> can resolve the same <code>m_*</code> when wired.\n• <strong>Multi-asset</strong> CSV: use <strong>Price strip (asset)</strong> to pick which close column drives the chart and the Analysis one-line <code>node_states</code> readout.\n• <strong>Backdrop</strong> orange shadow stays on for any <strong>green→blue→gold→purple</strong> node along the data path (same SEEK feed).\n• <strong>m_attrs_for_osl</strong> in SEEK lists register names.",
    },
    "portfolio-mix": {
      title: "Portfolio · multi-signal",
      body:
        "Composites <strong>signal inputs</strong> (grey sockets) with allocation, leverage, and cost controls. <strong>Closure</strong> (purple) is for trade history; <strong>data out</strong> (cyan) feeds Analysis. <strong>Backdrop</strong> and stats use the host <code>telemetry.portfolio</code> (equity and drawdown tails) after <code>SET_PORTFOLIO</code> and <code>SEEK</code>.",
      extra:
        "• Controls are pushed to the C++ host; each SEEK returns aligned <code>equity_tail</code> / <code>drawdown_tail</code> and <code>stats</code> for the N-Panel.",
    },
    "analysis-metrics": {
      title: "Analysis · performance viewer",
      body:
        "Host-computed <strong>ANLY-CALC</strong> (<code>telemetry.analysis.summary</code>) on the reconstructed portfolio equity to the scrub bar. <strong>Backdrop</strong>: faded <strong>reference close</strong> (left · linear) under <strong>strategy wealth vs buy &amp; hold</strong> (<code>telemetry.analysis</code> · right · log). Preview rows match <strong>EXPORT_CSV</strong> semantics (scrub-aligned playhead row highlighted).",
      extra:
        "• Preview = last window of bars ending at playhead (ANLY-VIS)\n• Win rate = share of bars with positive <em>strategy</em> daily return on the equity curve",
    },
  };

  /** @returns {SVGElement | null} */
  function qsNode(nodeId) {
    if (!nodeId || typeof nodeId !== "string") {
      return null;
    }
    const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(nodeId) : nodeId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return document.querySelector(`g.mlab-node[data-id="${esc}"]`);
  }

  /** Maps any pipeline-node instance → canonical Uber role (`market-data` …), or **null** (layout/frame). */
  function canonicalNodeRole(nodeId) {
    const g = qsNode(nodeId);
    if (!g) {
      return null;
    }
    const kind = g.getAttribute("data-kind");
    if (!kind || kind === "frame") {
      return null;
    }
    if (kind === "md") {
      return "market-data";
    }
    if (kind === "sig") {
      return "signal-otl";
    }
    if (kind === "port") {
      return "portfolio-mix";
    }
    if (kind === "ana") {
      return "analysis-metrics";
    }
    return null;
  }

  function selectedCanonicalRole() {
    return canonicalNodeRole(selectedId);
  }

  /** Selected node has canonical pipeline role **r** (host-bridge semantics). */
  function selEq(/** @type {string} */ r) {
    return canonicalNodeRole(selectedId) === r;
  }

  function migrateEdgeKeys(e) {
    const from = Array.isArray(e.from) ? [String(e.from[0]), String(e.from[1])] : ["", ""];
    const to = Array.isArray(e.to) ? [String(e.to[0]), String(e.to[1])] : ["", ""];
    if (from[1] === "outData") {
      from[1] = "odata";
    }
    if (to[1] === "outData") {
      to[1] = "odata";
    }
    return {
      id: typeof e.id === "string" ? e.id : "e-" + Date.now(),
      w: typeof e.w === "string" ? e.w : "scalar",
      from,
      to,
    };
  }

  function normalizeGraphEdges(/** @type {unknown} */ arr) {
    if (!Array.isArray(arr) || !arr.length) {
      return DEFAULT_GRAPH_EDGES.map((x) => Object.assign({}, x));
    }
    const out = [];
    for (const raw of arr) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const o = /** @type {Record<string, unknown>} */ (raw);
      const id = typeof o.id === "string" ? o.id : "e-" + Date.now();
      const fr = o.from;
      const to = o.to;
      const w = typeof o.w === "string" ? o.w : "scalar";
      if (!Array.isArray(fr) || !Array.isArray(to) || fr.length < 2 || to.length < 2) {
        continue;
      }
      out.push(
        migrateEdgeKeys({
          id,
          from: /** @type {[string, string]} */ ([String(fr[0]), String(fr[1])]),
          to: /** @type {[string, string]} */ ([String(to[0]), String(to[1])]),
          w,
        })
      );
    }
    return out.length > 0 ? out : DEFAULT_GRAPH_EDGES.map((x) => Object.assign({}, x));
  }

  function socketPoint(nodeId, sockKey) {
    const g = qsNode(nodeId);
    if (!g) {
      return { x: 0, y: 0 };
    }
    const kind = g.getAttribute("data-kind");
    const base = nodeCenter(/** @type {SVGGElement} */ (g));
    const tab = kind && SOCKET_OFFSETS_BY_KIND[kind];
    const o = tab && tab[sockKey];
    return o ? { x: base.x + o.x, y: base.y + o.y } : base;
  }

  function socketsPairAllowed(outKin, inKin) {
    return (
      (outKin === "stream" && inKin === "stream_in") ||
      (outKin === "scalar_out" && inKin === "scalar_in") ||
      (outKin === "pipeline_data" && inKin === "analysis_in")
    );
  }

  function mapEdgeSemantic(outKin) {
    if (outKin === "stream") {
      return "stream";
    }
    if (outKin === "pipeline_data") {
      return "pipe";
    }
    return "scalar";
  }

  function upsertWireEdge(fromId, fromKey, toId, toKey) {
    const cOut = qsNode(fromId)?.querySelector(`circle[data-wire-k="${CSS.escape(fromKey)}"]`);
    const cIn = qsNode(toId)?.querySelector(`circle[data-wire-k="${CSS.escape(toKey)}"]`);
    if (!(cOut instanceof SVGElement) || !(cIn instanceof SVGElement)) {
      return false;
    }
    const ok = cOut.getAttribute("data-wire-kind");
    const ik = cIn.getAttribute("data-wire-kind");
    if (!ok || !ik || !socketsPairAllowed(ok, ik)) {
      return false;
    }
    graphEdges = graphEdges.filter((e) => !(e.to[0] === toId && e.to[1] === toKey));
    graphEdges.push({
      id: "e-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e4),
      from: /** @type {[string, string]} */ ([fromId, fromKey]),
      to: /** @type {[string, string]} */ ([toId, toKey]),
      w: mapEdgeSemantic(ok),
    });
    saveGraphLayout();
    updateWires();
    return true;
  }

  function removeEdgeById(eid) {
    const n = graphEdges.length;
    graphEdges = graphEdges.filter((e) => e.id !== eid);
    if (graphEdges.length !== n) {
      saveGraphLayout();
      updateWires();
    }
  }

  function syncMdClonesFromPrimary() {
    const src = document.querySelector("#node-val-md-path");
    if (!src) {
      return;
    }
    const full = src.getAttribute("title") || "";
    document.querySelectorAll(".md-graph-path-sync").forEach((el) => {
      if (el === src) {
        return;
      }
      el.textContent = src.textContent;
      if (full) {
        el.setAttribute("title", full);
      } else {
        el.removeAttribute("title");
      }
    });
  }

  function createPipelineNode(kind, presetId, x, y) {
    const tmpl = PRIMARY_TEMPLATE_ID[/** @type {"md"|"sig"|"port"|"ana"} */ (kind)];
    if (!tmpl) {
      return null;
    }
    const proto = qsNode(tmpl);
    if (!proto) {
      return null;
    }
    const g = /** @type {SVGGElement} */ (proto.cloneNode(true));
    const nid = presetId || `${kind}-${Date.now().toString(36)}`;
    g.setAttribute("data-id", nid);
    g.setAttribute("data-core", "0");
    g.querySelectorAll("[id]").forEach((el) => {
      el.removeAttribute("id");
    });
    const hdr = g.querySelector(".node-hdr-text");
    if (hdr) {
      const base = String(hdr.textContent || "").trim();
      hdr.textContent = base + " · " + nid.slice(-6);
    }
    setNodePosition(g, x, y);
    const bg = $("board-graph");
    if (bg) {
      bg.appendChild(g);
    }
    if (wireNodeDragImpl) {
      wireNodeDragImpl(g);
    }
    attachSocketWireHandlers(g);
    syncMdClonesFromPrimary();
    updateWires();
    return g;
  }

  let socketWireDrag = /** @type {null | { fromNode: string, fromKey: string, svg: SVGSVGElement }} */ (null);
  let draftWireEl = /** @type {SVGPathElement | null} */ (null);

  function ensureDraftWire() {
    if (draftWireEl && draftWireEl.parentNode) {
      return draftWireEl;
    }
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("class", "graph-draft-wire");
    p.setAttribute("fill", "none");
    p.setAttribute("pointer-events", "none");
    const gw = $("graph-wires");
    if (gw) {
      gw.appendChild(p);
    }
    draftWireEl = /** @type {SVGPathElement} */ (p);
    return draftWireEl;
  }

  function clearDraftWire() {
    if (draftWireEl && draftWireEl.parentNode) {
      draftWireEl.parentNode.removeChild(draftWireEl);
    }
    draftWireEl = null;
  }

  function onSocketPointerDown(e) {
    const t = e.target && e.target instanceof Element ? e.target.closest("circle.socket") : null;
    if (!t || !t.classList.contains("socket-out")) {
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    const g = t.closest("g.mlab-node");
    const sid = g && g.getAttribute("data-id");
    const wk = t.getAttribute("data-wire-k");
    const svg = $("node-board-svg");
    if (!sid || !wk || !(svg instanceof SVGSVGElement)) {
      return;
    }
    socketWireDrag = { fromNode: sid, fromKey: wk, svg };
    ensureDraftWire();
    window.addEventListener("pointermove", onSocketPointerMove, true);
    window.addEventListener("pointerup", onSocketPointerUp, true);
    window.addEventListener("pointercancel", onSocketPointerUp, true);
  }

  function onSocketPointerMove(e) {
    if (!socketWireDrag || !draftWireEl) {
      return;
    }
    const svg = socketWireDrag.svg;
    const a = socketPoint(socketWireDrag.fromNode, socketWireDrag.fromKey);
    const gp = clientToGraph(svg, e.clientX, e.clientY);
    draftWireEl.setAttribute("d", wirePath(a.x, a.y, gp.x, gp.y));
  }

  function onSocketPointerUp(e) {
    window.removeEventListener("pointermove", onSocketPointerMove, true);
    window.removeEventListener("pointerup", onSocketPointerUp, true);
    window.removeEventListener("pointercancel", onSocketPointerUp, true);
    clearDraftWire();
    const st = socketWireDrag;
    socketWireDrag = null;
    if (!st) {
      return;
    }
    const stack = document.elementsFromPoint(e.clientX, e.clientY);
    /** @type {SVGCircleElement | null} */
    let t = null;
    for (const el of stack) {
      if (el instanceof SVGCircleElement && el.classList.contains("socket-in")) {
        t = el;
        break;
      }
    }
    if (!t) {
      return;
    }
    const g = t.closest("g.mlab-node");
    const tid = g && g.getAttribute("data-id");
    const tk = t.getAttribute("data-wire-k");
    if (!tid || !tk || tid === st.fromNode) {
      return;
    }
    upsertWireEdge(st.fromNode, st.fromKey, tid, tk);
  }

  function attachSocketWireHandlers(root) {
    root.querySelectorAll("circle.socket").forEach((c) => {
      if (c.dataset.mlWire === "1") {
        return;
      }
      c.dataset.mlWire = "1";
      c.addEventListener("pointerdown", onSocketPointerDown);
    });
  }

  /**
   * Market data: duplicate of header Load (id must differ — use `btn-load-npanel`). Delegation in renderer.
   */
  const MARKET_NPANEL_MD = `
<div class="npanel-md-fo" id="npanel-md-fo" aria-label="Market data source">
  <button type="button" id="btn-load-npanel" class="btn-npanel-md-load">Load CSV…</button>
  <p class="npanel-md-path mono" id="npanel-md-path">(no file)</p>
  <p class="npanel-md-hint">Universe <strong>close</strong> CSV (Yahoo-style). Drives the host and timeline.</p>
</div>`;

  /**
   * Injected into the N-Panel when the Uber / VectorTA node is selected (plain DOM — not SVG).
   * IDs are stable for getElementById, buildUberConfig, and Apply delegation.
   */
  const UBER_NPANEL_FORM = `
<div class="uber-strip uber-npanel" id="uber-fo" aria-label="Uber · VectorTA host controls">
  <div class="uber-strip-hdr">Host indicators</div>
  <div class="uber-row uber-row-cb">
    <label class="uber-lab" title="RSI (relative strength)"><input type="checkbox" id="uber-cb-rsi" checked /> RSI</label>
    <input type="number" class="uber-num" id="uber-p-rsi" min="1" max="200" value="14" title="RSI period" />
  </div>
  <div class="uber-row uber-row-cb">
    <label class="uber-lab" title="SMA (simple moving average)"><input type="checkbox" id="uber-cb-sma" checked /> SMA</label>
    <input type="number" class="uber-num" id="uber-p-sma" min="1" max="500" value="20" title="SMA period" />
  </div>
  <div class="uber-row uber-row-cb">
    <label class="uber-lab" title="MACD line (VectorTA default fast/slow/signal)"><input type="checkbox" id="uber-cb-macd" /> MACD</label>
    <input type="number" class="uber-num" id="uber-p-macd" min="1" max="200" value="9" title="Plumbing period" />
  </div>
  <div class="uber-row uber-row-cb">
    <label class="uber-lab" title="Bollinger width (single-series)"><input type="checkbox" id="uber-cb-bbw" /> BB width</label>
    <input type="number" class="uber-num" id="uber-p-bbw" min="1" max="200" value="20" title="Window" />
  </div>
  <div class="uber-row uber-row-asset" id="mlab-asset-row" style="display:none" title="Multi-column CSV: pick which price column drives the chart and the host feed in this bar">
    <label class="uber-lab" for="mlab-asset">Price strip (asset)</label>
    <select class="uber-sel" id="mlab-asset" aria-label="Select asset for chart and m attributes"></select>
  </div>
  <div class="uber-row uber-row-backdrop">
    <label class="uber-lab" for="uber-primary">Backdrop</label>
    <select class="uber-sel" id="uber-primary" title="Price chart shadow when this node is selected">
      <option value="m_sma_20" selected>Primary: SMA (shadow)</option>
      <option value="m_close">m_close</option>
      <option value="m_rsi_14">m_rsi (14)</option>
      <option value="m_macd">m_macd</option>
      <option value="m_bbw_20">m_bbw (width)</option>
    </select>
  </div>
  <div class="uber-row uber-row-osl" title="Host looks for m1_alpha.oso here; overrides OTL_SHADER_DIR when non-empty">
    <label class="uber-lab" for="uber-osl-shader-dir">OSL dir (M1)</label>
    <input type="text" class="uber-inp-text" id="uber-osl-shader-dir" spellcheck="false" placeholder="(optional) folder with m1_alpha.oso" />
  </div>
  <div class="uber-row uber-row-apply">
    <button type="button" class="btn-uber" id="uber-apply" title="Sends JSON to host: SET_UBER_SIGNAL">Apply to host</button>
  </div>
  <p class="uber-status" id="uber-status" role="status">Load a CSV, then use Apply to push indicators to the C++ host.</p>
</div>`;

  const PORTFOLIO_NPANEL_FORM = `
<div class="npanel-portfo npanel-portfolio-fo" id="port-fo" aria-label="Portfolio compositor controls">
  <div class="port-strip-hdr">Allocator &amp; frictions (host · PORT-CALC)</div>
  <div class="port-row">
    <label class="port-lab" for="port-alloc">Allocation</label>
    <select class="port-sel" id="port-alloc" title="Equal weight, signal-strength, or vol-scaled (risk) — computed in the host on the close tail">
      <option value="equal" selected>Equal weight</option>
      <option value="strength">Signal strength</option>
      <option value="risk">Risk parity (vol-scaled)</option>
    </select>
  </div>
  <div class="port-row port-row-integrator">
    <label class="port-lab" for="port-integrator">Integrator</label>
    <select class="port-sel" id="port-integrator" title="close_proxy: legacy PnL on close tail. gal_m1: OSL M1 + GAL bar replay 0..playhead (needs lab.osl_shader_dir or OTL_SHADER_DIR)">
      <option value="close_proxy" selected>PORT-CALC (close tail)</option>
      <option value="gal_m1">GAL+OSL M1 (execution clock)</option>
    </select>
  </div>
  <div class="port-row port-row-lev">
    <label class="port-lab" for="port-lev">Leverage <span class="port-lev-disp" id="port-lev-disp">1.0×</span></label>
    <input type="range" class="port-range" id="port-lev" min="0.25" max="5" step="0.05" value="1" />
  </div>
  <div class="port-row port-row-nums">
    <label class="port-lab" for="port-comm" title="Round-trip bps (host friction model)">Comm. (bps)</label>
    <input type="number" class="port-num" id="port-comm" min="0" max="200" step="0.5" value="2" />
    <label class="port-lab" for="port-slip">Slippage (bps)</label>
    <input type="number" class="port-num" id="port-slip" min="0" max="200" step="0.5" value="5" />
  </div>
  <div class="port-stats" id="port-stats" aria-live="polite">
    <div class="port-stat-h">Backtest (host, same close tail as backdrop)</div>
    <ul class="port-stat-grid">
      <li><span>Total return</span> <strong id="port-stat-total">—</strong></li>
      <li><span>Max DD</span> <strong id="port-stat-mdd">—</strong></li>
      <li><span>Sharpe</span> <strong id="port-stat-sharpe">—</strong></li>
      <li><span>Sortino</span> <strong id="port-stat-sortino">—</strong></li>
      <li><span>Profit factor</span> <strong id="port-stat-pf">—</strong></li>
      <li><span>PnL (tail end)</span> <strong id="port-stat-unrl">—</strong></li>
    </ul>
  </div>
  <p class="port-hint" id="port-hint">Parameters are sent to the host; scrub to refresh <code>telemetry.portfolio</code> (same playhead as the rest of Market Lab).</p>
</div>`;

  const ANALYSIS_NPANEL_FORM = `
<div class="ana-npanel" id="ana-fo" aria-label="Analysis viewer">
  <div class="ana-strip-hdr">Financial summary (host · ANLY-CALC)</div>
  <p class="ana-sig mono" id="ana-sig-attr" role="status">—</p>
  <table class="ana-table ana-sum-table" id="ana-sum-table" aria-labelledby="ana-sum-caption">
    <caption id="ana-sum-caption" class="ana-sum-caption">Full series 0→playhead (same equity as EXPORT_CSV rows)</caption>
    <thead><tr><th scope="col">Metric</th><th scope="col">Value</th></tr></thead>
    <tbody>
      <tr class="ana-metric-key"><td>CAGR</td><td id="ana-v-cagr">—</td></tr>
      <tr><td>Total return</td><td id="ana-v-tr">—</td></tr>
      <tr class="ana-metric-key"><td>Max drawdown</td><td id="ana-v-mdd">—</td></tr>
      <tr class="ana-metric-key"><td>Sharpe <span class="ana-metric-sub">(ann.)</span></td><td id="ana-v-sh">—</td></tr>
      <tr><td>Sortino <span class="ana-metric-sub">(ann.)</span></td><td id="ana-v-so">—</td></tr>
      <tr><td>Profit factor</td><td id="ana-v-pf">—</td></tr>
      <tr><td>Win rate <span class="ana-metric-sub">(daily ret &gt; 0)</span></td><td id="ana-v-wr">—</td></tr>
      <tr><td>Buy &amp; hold total return</td><td id="ana-v-bh">—</td></tr>
      <tr class="ana-metric-meta"><td>Bars sampled</td><td id="ana-v-nbars">—</td></tr>
    </tbody>
  </table>
  <div class="ana-strip-hdr ana-mt">Preview <span class="ana-hdr-sub">(scrub-aligned · ANLY-VIS)</span></div>
  <div class="ana-preview-wrap" id="ana-preview-wrap" role="region" aria-label="Export preview" tabindex="0">
    <table class="ana-preview-tbl" id="ana-preview-tbl" aria-label="Tail rows aligned to EXPORT_CSV">
      <thead>
        <tr>
          <th>Timestamp</th><th>Price</th><th>Signal</th><th>Weight</th>
          <th>Daily Δ%</th><th>Cum. wealth</th><th>DD%</th>
        </tr>
      </thead>
      <tbody id="ana-preview-body"></tbody>
    </table>
  </div>
  <p class="ana-csv-hint mono">EXPORT_CSV columns: Timestamp, Price, Signal, Weight, Daily_Return, Cumulative_Wealth, Drawdown — same semantics as NODE_EDITOR_ANALYTIC_PERSISTENCE §3.</p>
  <div class="ana-csv-row">
    <button type="button" class="btn-ana-csv" id="btn-ana-csv" title="Writes full-history CSV via host (portfolio + reference asset).">Export full series CSV…</button>
    <p class="ana-csv-st" id="ana-csv-status" role="status"></p>
  </div>
</div>`;

  function $(id) {
    return document.getElementById(id);
  }

  /**
   * Uber controls live in the N-Panel (`#uber-fo`). Resolve with `getElementById`, with `#uber-fo` as fallback.
   * @param {string} id
   * @returns {HTMLElement | null}
   */
  function uberGet(id) {
    const byId = document.getElementById(id);
    if (byId) {
      return /** @type {HTMLElement} */ (byId);
    }
    const root = document.getElementById("uber-fo");
    if (root) {
      const el = root.querySelector("#" + id);
      if (el) {
        return /** @type {HTMLElement} */ (el);
      }
    }
    return null;
  }

  function clamp(/** @type {number} */ n, /** @type {number} */ lo, /** @type {number} */ hi) {
    if (n < lo) {
      return lo;
    }
    if (n > hi) {
      return hi;
    }
    return n;
  }

  function updateUberPrimaryOptions(/** @type {string[]} */ attrs) {
    const sel = uberGet("uber-primary");
    if (!sel || !Array.isArray(attrs) || !attrs.length) {
      return;
    }
    const keep = String(sel.value || "");
    sel.replaceChildren();
    for (const a of attrs) {
      const o = document.createElement("option");
      o.value = a;
      o.textContent = a;
      sel.appendChild(o);
    }
    if ([...sel.options].some((x) => x.value === keep)) {
      sel.value = keep;
    } else {
      sel.value = defaultUberPrimaryFromAttrs(attrs);
    }
    // Stuck on m_close while an SMA is available — host often has no m_close *series* for shadow_overlay.
    if (sel.value === "m_close") {
      const sma = attrs.find((a) => a.startsWith("m_sma_"));
      if (sma) {
        sel.value = sma;
      }
    }
  }

  function buildUberConfig() {
    const rsiOn = /** @type {HTMLInputElement} */ (uberGet("uber-cb-rsi"))?.checked;
    const smaOn = /** @type {HTMLInputElement} */ (uberGet("uber-cb-sma"))?.checked;
    const macdOn = /** @type {HTMLInputElement} */ (uberGet("uber-cb-macd"))?.checked;
    const bbwOn = /** @type {HTMLInputElement} */ (uberGet("uber-cb-bbw"))?.checked;
    let rOn = !!rsiOn;
    let sOn = !!smaOn;
    let mOn = !!macdOn;
    let bOn = !!bbwOn;
    if (!rOn && !sOn && !mOn && !bOn) {
      rOn = true;
      const rcb = /** @type {HTMLInputElement} */ (uberGet("uber-cb-rsi"));
      if (rcb) {
        rcb.checked = true;
      }
    }
    const rsiP = clamp(parseInt(/** @type {HTMLInputElement} */ (uberGet("uber-p-rsi"))?.value || "14", 10) || 14, 1, 500);
    const smaP = clamp(parseInt(/** @type {HTMLInputElement} */ (uberGet("uber-p-sma"))?.value || "20", 10) || 20, 1, 500);
    const macdP = clamp(parseInt(/** @type {HTMLInputElement} */ (uberGet("uber-p-macd"))?.value || "9", 10) || 9, 1, 200);
    const bbwP = clamp(parseInt(/** @type {HTMLInputElement} */ (uberGet("uber-p-bbw"))?.value || "20", 10) || 20, 1, 200);

    const shaderAttrs = ["m_close"];
    const ind = [];

    if (rOn) {
      const id = "r" + String(rsiP);
      const ma = "m_rsi_" + String(rsiP);
      ind.push({ id, indicator: "rsi", period: rsiP, from: "close", m_attr: ma });
      shaderAttrs.push(ma);
    }
    if (sOn) {
      const id = "s" + String(smaP);
      const ma = "m_sma_" + String(smaP);
      ind.push({ id, indicator: "sma", period: smaP, from: "close", m_attr: ma });
      shaderAttrs.push(ma);
    }
    if (mOn) {
      const ma = "m_macd";
      ind.push({ id: "mac", indicator: "macd", period: macdP, from: "close", m_attr: ma });
      shaderAttrs.push(ma);
    }
    if (bOn) {
      const id = "bbw" + String(bbwP);
      const ma = "m_bbw_" + String(bbwP);
      ind.push({ id, indicator: "bollinger_bands_width", period: bbwP, from: "close", m_attr: ma });
      shaderAttrs.push(ma);
    }

    const sel = /** @type {HTMLSelectElement} */ (uberGet("uber-primary"));
    let primary = "m_close";
    if (sel && typeof sel.value === "string" && sel.value && shaderAttrs.indexOf(sel.value) >= 0) {
      primary = sel.value;
    } else {
      for (const a of shaderAttrs) {
        if (a !== "m_close") {
          primary = a;
          break;
        }
      }
    }
    {
      const sma = shaderAttrs.find((a) => a.startsWith("m_sma_"));
      if (sma && primary === "m_close") {
        primary = sma;
        if (sel) {
          sel.value = sma;
        }
      }
    }

    const outHint = uberGet("uber-out-hint");
    if (outHint) {
      outHint.textContent = shaderAttrs
        .filter((x) => x !== "m_close")
        .slice(0, 4)
        .join(", ");
    }

    const oslIn = /** @type {HTMLInputElement} */ (uberGet("uber-osl-shader-dir"));
    const oslRaw = oslIn && typeof oslIn.value === "string" ? oslIn.value.trim() : "";
    /** @type {Record<string, string>} */
    const lab = { primary_overlay: primary };
    if (oslRaw) {
      lab.osl_shader_dir = oslRaw;
    }
    return {
      version: 1,
      lab,
      source: { m_attr: "m_close" },
      shader: { m_attrs: shaderAttrs },
      indicators: ind,
    };
  }

  function onUberApplyClick() {
    const ml = window.marketLab;
    if (!ml || typeof ml.setUberSignal !== "function") {
      return;
    }
    const cfg = buildUberConfig();
    void (async () => {
      try {
        const line = await ml.setUberSignal(JSON.stringify(cfg));
        if (typeof line === "string" && line.startsWith("ERR ")) {
          console.warn("MLWorkbench: SET_UBER_SIGNAL", line);
          const pill = document.getElementById("conn-pill");
          if (pill) {
            pill.classList.remove("pill-ok", "pill-warn", "pill-err", "pill-idle");
            pill.classList.add("pill-err");
            pill.textContent = "SET_UBER failed (see console)";
          }
          const st = document.getElementById("uber-status");
          if (st) {
            st.textContent = "Host rejected plan: " + line.slice(0, 120);
          }
          return;
        }
        try {
          const lab = /** @type {{ osl_shader_dir?: string } | null | undefined} */ (cfg.lab);
          const o   = lab && typeof lab.osl_shader_dir === "string" ? lab.osl_shader_dir.trim() : "";
          if (o) {
            localStorage.setItem(MLAB_OSL_SHADER_DIR_KEY, o);
          } else {
            localStorage.removeItem(MLAB_OSL_SHADER_DIR_KEY);
          }
        } catch {
          /* ignore */
        }
        const st = document.getElementById("uber-status");
        if (st) {
          st.textContent = "Last apply: OK — refreshed SEEK at current bar.";
        }
        if (typeof window.MLRendererSeekRefresh === "function") {
          await window.MLRendererSeekRefresh();
        } else {
          window.dispatchEvent(new Event("mlab-uber-updated"));
        }
      } catch (e) {
        console.warn("MLWorkbench: setUberSignal", e);
        const pill = document.getElementById("conn-pill");
        if (pill) {
          pill.classList.remove("pill-ok", "pill-warn", "pill-err", "pill-idle");
          pill.classList.add("pill-err");
          pill.textContent = "SET_UBER error";
        }
        const st = document.getElementById("uber-status");
        if (st) {
          const msg = e && typeof /** @type {Error} */ (e).message === "string" ? /** @type {Error} */ (e).message : String(e);
          st.textContent = "SetUber failed: " + msg;
        }
      }
    })();
  }

  /** One delegated handler on `#npanel-item-body` — survives innerHTML when switching nodes. */
  function wireUberApplyDelegation() {
    const body = $("npanel-item-body");
    if (!body || body.dataset.mlUberDelegate === "1") {
      return;
    }
    body.dataset.mlUberDelegate = "1";
    body.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof Element)) {
        return;
      }
      if (!t.closest("#uber-apply")) {
        return;
      }
      e.preventDefault();
      onUberApplyClick();
    });
  }

  function syncNpanelMarketPathFromNode() {
    const src = $("node-val-md-path");
    const dst = $("npanel-md-path");
    if (!src || !dst) {
      return;
    }
    dst.textContent = src.textContent || "(no file)";
    const tt = src.getAttribute("title");
    if (tt) {
      dst.setAttribute("title", tt);
    } else {
      dst.removeAttribute("title");
    }
  }

  function formatAnalysisPipelineLine() {
    if (!lastSeekJson) {
      return "No SEEK yet. Load a CSV, apply Uber indicators, then scrub — the host will fill node_states for this bar.";
    }
    const j = lastSeekJson;
    const bar = j.bar != null ? String(j.bar) : "—";
    const aidx = getClampedSelectedAssetIndex(/** @type {object} */ (j));
    const ns = getNodeStatesForAsset(/** @type {object} */ (j), aidx);
    if (!ns || typeof ns !== "object") {
      return "SEEK has no node_states from the host.";
    }
    const parts = ["bar " + bar];
    if (typeof j.assets === "number" && (j.assets | 0) > 1) {
      parts.push("asset " + aidx);
    }
    for (const k of Object.keys(ns)) {
      if (k === "map_from") {
        continue;
      }
      const v = ns[k];
      const s =
        typeof v === "number" && !Number.isNaN(v) ? (Math.abs(v) >= 1e5 || Math.abs(v) < 1e-3 ? v.toExponential(3) : String(Math.round(v * 1e5) / 1e5)) : String(v);
      parts.push(String(k) + "=" + s);
    }
    const scope = typeof j.assets === "number" && (j.assets | 0) > 1 ? "selected price strip" : "asset 0";
    return "Host feed (this bar, " + scope + "): " + parts.join(" · ");
  }

  function syncAnalysisPipelineNpanel() {
    const p = $("npanel-ana-pipeline");
    if (p) {
      p.textContent = formatAnalysisPipelineLine();
    }
  }

  function syncAnalysisDashboardNpanel() {
    if (!selEq("analysis-metrics") || !lastSeekJson) {
      return;
    }
    const at = getAnalysisTelemetry(/** @type {object} */ (lastSeekJson));
    const sig = $("ana-sig-attr");
    const setT = (/** @type {string} */ id, /** @type {string} */ v) => {
      const el = $(id);
      if (el) {
        el.textContent = v;
      }
    };
    if (!at) {
      if (sig) {
        sig.textContent =
          "ANLY-CALC: load a CSV, wire graph to Portfolio→Analysis, then SEEK — equity summary appears when telemetry.analysis has a wealth tail.";
      }
      setT("ana-v-cagr", "—");
      setT("ana-v-tr", "—");
      setT("ana-v-mdd", "—");
      setT("ana-v-sh", "—");
      setT("ana-v-so", "—");
      setT("ana-v-pf", "—");
      setT("ana-v-wr", "—");
      setT("ana-v-bh", "—");
      setT("ana-v-nbars", "—");
      return;
    }
    const s = at.summary;
    if (sig) {
      sig.textContent =
        at.signalAttr && at.signalAttr.length
          ? "Signal column (CSV / preview): " + at.signalAttr
          : "Signal column (CSV / preview): (none)";
    }
    if (!s) {
      setT("ana-v-cagr", "—");
      setT("ana-v-tr", "—");
      setT("ana-v-mdd", "—");
      setT("ana-v-sh", "—");
      setT("ana-v-so", "—");
      setT("ana-v-pf", "—");
      setT("ana-v-wr", "—");
      setT("ana-v-bh", "—");
      setT("ana-v-nbars", "—");
      return;
    }
    setT("ana-v-cagr", fmtP(/** @type {number} */ (s.cagr_pct)));
    setT("ana-v-tr", fmtP(/** @type {number} */ (s.total_return_pct)));
    setT("ana-v-mdd", fmtP(/** @type {number} */ (s.max_drawdown_pct)));
    setT("ana-v-sh", fmtR(/** @type {number} */ (s.sharpe)));
    setT("ana-v-so", fmtR(/** @type {number} */ (s.sortino)));
    setT("ana-v-pf", fmtR(/** @type {number} */ (s.profit_factor)));
    setT("ana-v-wr", fmtP(/** @type {number} */ (s.win_rate_pct)));
    setT("ana-v-bh", fmtP(/** @type {number} */ (s.buy_hold_total_return_pct)));
    const nper = /** @type {unknown} */ (s.n_periods);
    const nb =
      typeof nper === "number" && Number.isFinite(nper) ? String(Math.round(nper)) : "—";
    setT("ana-v-nbars", nb);
  }

  function syncAnalysisPreviewNpanel() {
    const body = /** @type {HTMLTableSectionElement | null} */ ($("ana-preview-body"));
    if (!body) {
      return;
    }
    body.replaceChildren();
    if (!selEq("analysis-metrics") || !lastSeekJson) {
      return;
    }
    const at = getAnalysisTelemetry(/** @type {object} */ (lastSeekJson));
    if (!at) {
      return;
    }
    const rows = at.preview;
    const hi = at.previewPlayheadIndex;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (!row || typeof row !== "object") {
        continue;
      }
      const tr = document.createElement("tr");
      if (r === hi) {
        tr.className = "ana-preview-hi";
      }
      const R = /** @type {Record<string, unknown>} */ (row);
      const cells = [
        R.timestamp != null ? String(R.timestamp) : "—",
        numCell(R.price),
        numCell(R.signal),
        numCell(R.weight),
        numCell(R.daily_return_pct),
        numCell(R.cumulative_wealth),
        numCell(R.drawdown_pct),
      ];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = c;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    const wrap = $("ana-preview-wrap");
    const hiTr = body.querySelector("tr.ana-preview-hi");
    if (wrap && hiTr && typeof hiTr.scrollIntoView === "function") {
      hiTr.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  function numCell(/** @type {unknown} */ v) {
    if (v == null || (typeof v === "number" && !Number.isFinite(v))) {
      return "—";
    }
    if (typeof v === "number") {
      if (Math.abs(v) >= 1e5 || (Math.abs(v) > 0 && Math.abs(v) < 1e-3)) {
        return v.toExponential(2);
      }
      return (Math.round(v * 1e4) / 1e4).toString();
    }
    return String(v);
  }

  function wireAnalysisDelegation() {
    const body = $("npanel-item-body");
    if (!body || body.dataset.mlAnalysisDelegate === "1") {
      return;
    }
    body.dataset.mlAnalysisDelegate = "1";
    body.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof Element)) {
        return;
      }
      if (t.closest("#btn-ana-csv")) {
        e.preventDefault();
        void onAnalysisSaveCsv();
      }
    });
  }

  async function onAnalysisSaveCsv() {
    const st = $("ana-csv-status");
    const api = window.marketLab;
    if (!api || typeof api.pickCsvExport !== "function" || typeof api.exportAnalysisCsv !== "function") {
      if (st) {
        st.textContent = "Save dialog / export not available (preload).";
      }
      return;
    }
    if (st) {
      st.textContent = "…";
    }
    let path = "";
    try {
      const r = await api.pickCsvExport();
      if (r.canceled || !r.path) {
        if (st) {
          st.textContent = "";
        }
        return;
      }
      path = r.path;
      const line = await api.exportAnalysisCsv(path);
      if (typeof line === "string" && line.indexOf("OK ") === 0) {
        if (st) {
          st.textContent = "Wrote: " + path;
        }
      } else {
        if (st) {
          st.textContent = "Export failed: " + (line && line.length < 160 ? line : "ERR");
        }
      }
    } catch (e) {
      if (st) {
        st.textContent = "Error: " + (e && typeof /** @type {Error} */ (e).message === "string" ? /** @type {Error} */ (e).message : String(e));
      }
    }
  }

  /** @returns {PortfolioUiV1 | null} */
  function parsePortfolioForm() {
    if (!$("port-lev")) {
      return null;
    }
    const a = /** @type {HTMLSelectElement | null} */ ($("port-alloc"));
    const m = a && a.value;
    const method = m === "strength" || m === "risk" ? m : "equal";
    const lr = /** @type {HTMLInputElement | null} */ ($("port-lev"));
    const c = /** @type {HTMLInputElement | null} */ ($("port-comm"));
    const s = /** @type {HTMLInputElement | null} */ ($("port-slip"));
    const ing = /** @type {HTMLSelectElement | null} */ ($("port-integrator"));
    const integ = ing && ing.value === "gal_m1" ? "gal_m1" : "close_proxy";
    const lv = lr ? Number(lr.value) : 1;
    return {
      method,
      integrator: integ,
      leverage: !Number.isFinite(lv) ? 1 : Math.min(5, Math.max(0.25, lv)),
      commBps: c ? Math.max(0, Number(c.value) || 0) : 2,
      slippageBps: s ? Math.max(0, Number(s.value) || 0) : 5,
    };
  }

  /** @returns {PortfolioUiV1} */
  function getEffectivePortfolioUi() {
    if (selEq("portfolio-mix")) {
      const p = parsePortfolioForm();
      if (p) {
        return p;
      }
    }
    return loadPortfolioUi();
  }

  function applyPortfolioFormFromStorage() {
    const u = loadPortfolioUi();
    const a = /** @type {HTMLSelectElement | null} */ ($("port-alloc"));
    const ing = /** @type {HTMLSelectElement | null} */ ($("port-integrator"));
    const lr = /** @type {HTMLInputElement | null} */ ($("port-lev"));
    const c = /** @type {HTMLInputElement | null} */ ($("port-comm"));
    const s = /** @type {HTMLInputElement | null} */ ($("port-slip"));
    if (a) {
      a.value = u.method;
    }
    if (ing) {
      ing.value = u.integrator === "gal_m1" ? "gal_m1" : "close_proxy";
    }
    if (lr) {
      lr.value = String(u.leverage);
    }
    if (c) {
      c.value = String(u.commBps);
    }
    if (s) {
      s.value = String(u.slippageBps);
    }
    const disp = $("port-lev-disp");
    if (disp) {
      disp.textContent = (Math.round(u.leverage * 100) / 100).toFixed(2) + "×";
    }
  }

  function fmtP(x) {
    if (x == null || !Number.isFinite(x)) {
      return "—";
    }
    return (Math.round(x * 100) / 100).toFixed(2) + "%";
  }

  function fmtR(x) {
    if (x == null || !Number.isFinite(x)) {
      return "—";
    }
    if (x >= 99) {
      return "∞";
    }
    return (Math.round(x * 100) / 100).toFixed(2);
  }

  function syncPortfolioStatsNpanel() {
    if (!lastSeekJson || !selEq("portfolio-mix")) {
      return;
    }
    const pt = getPortfolioTelemetry(/** @type {object} */ (lastSeekJson));
    const stats = pt && pt.stats;
    const st = /** @type {HTMLSpanElement | null} */ ($("port-stat-total"));
    const mdd = /** @type {HTMLSpanElement | null} */ ($("port-stat-mdd"));
    const sh = /** @type {HTMLSpanElement | null} */ ($("port-stat-sharpe"));
    const so = /** @type {HTMLSpanElement | null} */ ($("port-stat-sortino"));
    const pf = /** @type {HTMLSpanElement | null} */ ($("port-stat-pf"));
    const ur = /** @type {HTMLSpanElement | null} */ ($("port-stat-unrl"));
    if (!stats) {
      if (st) {
        st.textContent = "\u2014";
      }
      if (mdd) {
        mdd.textContent = "\u2014";
      }
      if (sh) {
        sh.textContent = "\u2014";
      }
      if (so) {
        so.textContent = "\u2014";
      }
      if (pf) {
        pf.textContent = "\u2014";
      }
      if (ur) {
        ur.textContent = "\u2014";
      }
      return;
    }
    if (st) {
      st.textContent = fmtP(/** @type {number} */ (stats.total_return_pct));
    }
    if (mdd) {
      mdd.textContent = fmtP(/** @type {number} */ (stats.max_drawdown_pct));
    }
    if (sh) {
      sh.textContent = fmtR(/** @type {number} */ (stats.sharpe));
    }
    if (so) {
      so.textContent = fmtR(/** @type {number} */ (stats.sortino));
    }
    if (pf) {
      pf.textContent = fmtR(/** @type {number} */ (stats.profit_factor));
    }
    if (ur) {
      ur.textContent = fmtP(/** @type {number} */ (stats.pnl_tail_end_pct));
    }
  }

  function onPortfolioFormChanged() {
    if (selEq("portfolio-mix")) {
      const lr = /** @type {HTMLInputElement | null} */ ($("port-lev"));
      const disp = $("port-lev-disp");
      if (lr && disp) {
        const v = Number(lr.value);
        disp.textContent = (Number.isFinite(v) ? (Math.round(v * 100) / 100).toFixed(2) : "1.00") + "×";
      }
    }
    const p = parsePortfolioForm();
    if (p) {
      savePortfolioUi(p);
    }
    schedulePushPortfolioToHost();
  }

  function wirePortfolioDelegation() {
    const body = $("npanel-item-body");
    if (!body || body.dataset.mlPortfolioDelegate === "1") {
      return;
    }
    body.dataset.mlPortfolioDelegate = "1";
    body.addEventListener("input", (e) => {
      const t = e.target;
      if (t && t instanceof Element && t.closest && t.closest("#port-fo")) {
        onPortfolioFormChanged();
      }
    });
    body.addEventListener("change", (e) => {
      const t = e.target;
      if (t && t instanceof Element && t.closest && t.closest("#port-fo")) {
        onPortfolioFormChanged();
      }
    });
  }

  /**
   * @param {string} id node data-id
   * @returns {string}
   */
  function npanelHtmlForNode(id) {
    if (typeof id === "string" && id.startsWith("frame-")) {
      return (
        `<h4 class="npanel-item-h">Frame · note</h4>` +
        `<p class="npanel-item-p">Layout-only (not connected to the OTL bridge). Double-click the dashed rectangle to edit text. <kbd>Delete</kbd> / <kbd>Backspace</kbd> removes the frame.</p>` +
        `<p class="npanel-item-x mono">id: ${id.replace(/</g, "")}</p>`
      );
    }
    const role = canonicalNodeRole(id);
    if (!role) {
      return `<h4 class="npanel-item-h">Node</h4><p class="npanel-item-p">Unknown pipeline node.</p><p class="npanel-item-x mono">${String(id).replace(/</g, "")}</p>`;
    }
    const t = NPANEL_TEXT[role];
    const shortId = role === id ? "" : String(id).replace(/</g, "");
    const hdr = role === id ? t.title : `${t.title} · ${shortId}`;
    if (role === "market-data") {
      return (
        `<h4 class="npanel-item-h">${hdr}</h4>` +
        `<p class="npanel-item-p">${t.body}</p>` +
        MARKET_NPANEL_MD +
        `<p class="npanel-item-x">${t.extra}</p>`
      );
    }
    if (role === "signal-otl") {
      return (
        `<h4 class="npanel-item-h">${hdr}</h4>` +
        `<p class="npanel-item-p">${t.body}</p>` +
        UBER_NPANEL_FORM +
        `<p class="npanel-item-x">${t.extra}</p>`
      );
    }
    if (role === "analysis-metrics") {
      return (
        `<h4 class="npanel-item-h">${hdr}</h4>` +
        `<p class="npanel-item-p">${t.body}</p>` +
        `<p class="npanel-item-p npanel-ana-pipe mono" id="npanel-ana-pipeline"></p>` +
        ANALYSIS_NPANEL_FORM +
        `<p class="npanel-item-x">${t.extra}</p>`
      );
    }
    if (role === "portfolio-mix") {
      return (
        `<h4 class="npanel-item-h">${hdr}</h4>` +
        `<p class="npanel-item-p">${t.body}</p>` +
        PORTFOLIO_NPANEL_FORM +
        `<p class="npanel-item-x">${t.extra}</p>`
      );
    }
    return `<h4 class="npanel-item-h">${t.title}</h4><p class="npanel-item-p">${t.body}</p><p class="npanel-item-x">${t.extra}</p>`;
  }

  /**
   * @param {SVGSVGElement} svg
   * @param {number} clientX
   * @param {number} clientY
   * @returns {{ x: number, y: number }}
   */
  function pointerToSvg(svg, clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const m = svg.getScreenCTM();
    if (!m) {
      return { x: 0, y: 0 };
    }
    return pt.matrixTransform(m.inverse());
  }

  /**
   * Coordinates inside the “graph” layer (unscaled, before the graph group’s translate/scale).
   * @param {SVGSVGElement} svg
   * @param {number} clientX
   * @param {number} clientY
   * @returns {{ x: number, y: number }}
   */
  function clientToGraph(svg, clientX, clientY) {
    const p = pointerToSvg(svg, clientX, clientY);
    return { x: (p.x - panX) / scale, y: (p.y - panY) / scale };
  }

  function parseTranslate(g) {
    const tr = g.getAttribute("transform") || "";
    const m = tr.match(/translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
    if (m) {
      return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
    }
    return { x: 0, y: 0 };
  }

  function setNodePosition(/** @type {SVGGElement} */ g, /** @type {number} */ x, /** @type {number} */ y) {
    g.setAttribute("transform", `translate(${x},${y})`);
  }

  function saveGraphLayout() {
    const out = {
      pan: { x: panX, y: panY },
      scale,
      /** @type {Record<string, { x: number, y: number, kind?: string }>} */
      nodes: {},
      /** @type {Array<{ id: string, x: number, y: number, note: string }>} */
      frames: [],
      edges: graphEdges.slice(),
    };
    document.querySelectorAll("g.mlab-node").forEach((el) => {
      const g = /** @type {SVGGElement} */ (el);
      const id = g.getAttribute("data-id");
      const kind = g.getAttribute("data-kind");
      if (!id || kind === "frame") {
        return;
      }
      const p = nodeCenter(g);
      const core = g.getAttribute("data-core");
      if (core === "1") {
        out.nodes[id] = { x: p.x, y: p.y };
      } else {
        out.nodes[id] = { x: p.x, y: p.y, kind: kind || "" };
      }
    });
    document.querySelectorAll('g.mlab-node[data-kind="frame"]').forEach((el) => {
      const g = /** @type {SVGGElement} */ (el);
      const id = g.getAttribute("data-id");
      if (!id) {
        return;
      }
      const p = nodeCenter(g);
      const te = g.querySelector(".frame-note-el");
      out.frames.push({
        id,
        x: p.x,
        y: p.y,
        note: te && te.textContent ? te.textContent : "",
      });
    });
    try {
      localStorage.setItem(GRAPH_LAYOUT_KEY, JSON.stringify(out));
    } catch {
      // ignore
    }
  }

  /**
   * @param {string} id
   * @param {number} x
   * @param {number} y
   * @param {string} note
   */
  function createFrameGroup(id, x, y, note) {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "mlab-node mlab-frame-node");
    g.setAttribute("data-id", id);
    g.setAttribute("data-kind", "frame");
    setNodePosition(g, x, y);
    const r = document.createElementNS(SVG_NS, "rect");
    r.setAttribute("class", "node-chrome");
    r.setAttribute("x", "0");
    r.setAttribute("y", "0");
    r.setAttribute("width", "240");
    r.setAttribute("height", "96");
    r.setAttribute("rx", "4");
    r.setAttribute("fill", "none");
    r.setAttribute("stroke", "#5a6a7a");
    r.setAttribute("stroke-width", "1.2");
    r.setAttribute("stroke-dasharray", "5 4");
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("class", "frame-note-el");
    t.setAttribute("x", "10");
    t.setAttribute("y", "24");
    t.setAttribute("fill", "#aab8c8");
    t.setAttribute("font-size", "11");
    t.setAttribute("font-family", "inherit");
    t.textContent = note || "Double-click to edit";
    g.appendChild(r);
    g.appendChild(t);
    return g;
  }

  function loadGraphLayout() {
    let o;
    try {
      o = JSON.parse(localStorage.getItem(GRAPH_LAYOUT_KEY) || "null");
    } catch {
      return;
    }
    if (!o || typeof o !== "object") {
      return;
    }
    if (o.pan && typeof o.pan.x === "number") {
      panX = o.pan.x;
    }
    if (o.pan && typeof o.pan.y === "number") {
      panY = o.pan.y;
    }
    if (typeof o.scale === "number") {
      scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, o.scale));
    }
    const nodes = o.nodes;
    if (nodes && typeof nodes === "object") {
      for (const nid of CORE_GRAPH_IDS) {
        const p = /** @type {Record<string, { x?: number; y?: number }>} */ (nodes)[nid];
        if (p && typeof p.x === "number" && typeof p.y === "number") {
          const ng = qsNode(nid);
          if (ng) {
            setNodePosition(/** @type {SVGGElement} */ (ng), p.x, p.y);
          }
        }
      }
      for (const id of Object.keys(nodes)) {
        if (CORE_GRAPH_IDS.indexOf(id) >= 0) {
          continue;
        }
        const p = /** @type {Record<string, unknown>} */ (nodes)[id];
        if (!p || typeof p !== "object" || typeof p.x !== "number" || typeof p.y !== "number") {
          continue;
        }
        const kind = typeof p.kind === "string" ? p.kind : null;
        let g = qsNode(id);
        if (!g && kind) {
          createPipelineNode(kind, id, Number(p.x), Number(p.y));
        } else if (g) {
          setNodePosition(/** @type {SVGGElement} */ (g), Number(p.x), Number(p.y));
        }
      }
    }
    graphEdges = normalizeGraphEdges(o.edges);
    const bg = $("board-graph");
    if (Array.isArray(o.frames) && bg) {
      document.querySelectorAll('g.mlab-node[data-kind="frame"]').forEach((el) => {
        el.remove();
      });
      for (const fr of o.frames) {
        if (!fr || typeof fr !== "object" || typeof fr.id !== "string" || fr.id.indexOf("frame-") !== 0) {
          continue;
        }
        const fx = typeof fr.x === "number" ? fr.x : 420;
        const fy = typeof fr.y === "number" ? fr.y : 280;
        const note = typeof fr.note === "string" ? fr.note : "";
        const g = createFrameGroup(fr.id, fx, fy, note);
        bg.appendChild(g);
        if (wireNodeDragImpl) {
          wireNodeDragImpl(g);
        }
      }
    }
    updateGraphTransform();
    updateZoomLabel();
    updateWires();
    const bg2 = $("board-graph");
    if (bg2) {
      attachSocketWireHandlers(bg2);
    }
  }

  function addFrameNode() {
    const bg = $("board-graph");
    if (!bg) {
      return;
    }
    const id = "frame-" + Date.now();
    const g = createFrameGroup(id, 420, 280, "");
    bg.appendChild(g);
    if (wireNodeDragImpl) {
      wireNodeDragImpl(g);
    }
    setSelectedNode(id);
    saveGraphLayout();
  }

  function nodeCenter(g) {
    return parseTranslate(g);
  }

  function wirePath(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const c = Math.max(48, Math.abs(dx) * 0.4);
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + c).toFixed(1)} ${y1.toFixed(1)} ${(x2 - c).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }

  function updateWires() {
    const gw = $("graph-wires");
    if (!gw) {
      return;
    }
    const draft = gw.querySelector("path.graph-draft-wire");
    gw.replaceChildren();
    for (const edge of graphEdges) {
      const p1 = socketPoint(edge.from[0], edge.from[1]);
      const p2 = socketPoint(edge.to[0], edge.to[1]);
      const d = wirePath(p1.x, p1.y, p2.x, p2.y);
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("pointer-events", "stroke");
      path.dataset.edgeId = edge.id;
      path.setAttribute("d", d);
      if (edge.w === "stream") {
        path.setAttribute("class", "connect-wire connect-stream wire-edge");
        path.setAttribute("stroke-width", "2.5");
      } else if (edge.w === "pipe") {
        path.setAttribute("class", "connect-wire connect-pipe wire-edge");
        path.setAttribute("stroke-width", "2.5");
      } else {
        path.setAttribute("class", "connect-wire connect-float wire-edge");
        path.setAttribute("stroke-width", edge.from[1] === "out" || edge.from[0].indexOf("sig") >= 0 ? "1.85" : "2.2");
        path.setAttribute("stroke-opacity", "0.78");
      }
      gw.appendChild(path);
    }
    if (draft instanceof SVGPathElement && draft.parentNode == null) {
      gw.appendChild(draft);
    }
    attachGraphWireDismiss(gw);
  }

  /** Alt+click a wire curve to disconnect (removes persisted edge). */
  function attachGraphWireDismiss(/** @type {Element} */ gw) {
    if (gw.dataset.mlWireDismiss === "1") {
      return;
    }
    gw.dataset.mlWireDismiss = "1";
    gw.addEventListener(
      "click",
      (e) => {
        if (!e.altKey) {
          return;
        }
        const pt = /** @type {SVGElement | null} */ (e.target && e.target instanceof SVGElement && e.target.closest ? e.target.closest("path.wire-edge") : null);
        if (!pt || !(pt instanceof SVGElement)) {
          return;
        }
        e.preventDefault();
        const eid = pt.dataset.edgeId;
        if (eid) {
          removeEdgeById(eid);
        }
      },
      true
    );
  }

  function setNPanelCollapsed(collapsed) {
    document.body.classList.toggle("npanel-collapsed", collapsed);
    const b = $("btn-npanel");
    if (b) {
      b.setAttribute("aria-pressed", collapsed ? "true" : "false");
    }
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      // ignore
    }
  }

  function toggleNPanel() {
    setNPanelCollapsed(!document.body.classList.contains("npanel-collapsed"));
  }

  function applyStoredNPanel() {
    let c = false;
    try {
      c = localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      c = false;
    }
    setNPanelCollapsed(c);
  }

  function refreshBackdropHot() {
    if (!closeLineSeries) {
      return;
    }
    if (selEq("portfolio-mix")) {
      closeLineSeries.applyOptions({
        color: "rgba(212, 180, 90, 0.95)",
      });
    } else if (selEq("analysis-metrics")) {
      closeLineSeries.applyOptions({
        color: "rgba(88, 134, 106, 0.45)",
      });
      if (analysisWealthLineSeries) {
        analysisWealthLineSeries.applyOptions({
          color: "rgba(186, 104, 200, 0.95)",
        });
      }
      if (analysisBuyHoldLineSeries) {
        analysisBuyHoldLineSeries.applyOptions({
          color: "rgba(150, 150, 150, 0.72)",
        });
      }
    } else {
      closeLineSeries.applyOptions({
        color: "rgba(100, 180, 120, 0.9)",
      });
    }
  }

  function setSelectedNode(id) {
    selectedId = id;
    const rn = canonicalNodeRole(id);
    document.querySelectorAll("g.mlab-node").forEach((g) => {
      g.classList.toggle("selected", g.getAttribute("data-id") === id);
    });
    if (rn || (typeof id === "string" && id.startsWith("frame-"))) {
      setNPanelCollapsed(false);
    }
    const np = $("npanel-item-body");
    if (np) {
      np.innerHTML = npanelHtmlForNode(id);
    }
    if (rn === "market-data") {
      syncNpanelMarketPathFromNode();
    }
    if (rn === "signal-otl") {
      const osl = /** @type {HTMLInputElement} */ (uberGet("uber-osl-shader-dir"));
      if (osl) {
        try {
          if (!osl.value) {
            const s = localStorage.getItem(MLAB_OSL_SHADER_DIR_KEY);
            if (s) {
              osl.value = s;
            }
          }
        } catch {
          /* ignore */
        }
      }
      if (lastSeekJson) {
        syncMlabAssetRow(/** @type {object} */ (lastSeekJson));
      }
    }
    if (rn === "analysis-metrics") {
      syncAnalysisPipelineNpanel();
      wireAnalysisDelegation();
      syncAnalysisDashboardNpanel();
      syncAnalysisPreviewNpanel();
    }
    if (rn === "portfolio-mix") {
      applyPortfolioFormFromStorage();
      wirePortfolioDelegation();
      syncPortfolioStatsNpanel();
    }
    updateBackdropFloatingLabel();
    if (lastSeekJson) {
      updateBackdropFromSeek(/** @type {object} */ (lastSeekJson));
    } else {
      refreshBackdropHot();
    }
  }

  function updateGraphTransform() {
    const g = $("board-graph");
    if (g) {
      g.setAttribute("transform", `translate(${panX},${panY}) scale(${scale})`);
    }
  }

  function updateZoomLabel() {
    const el = $("zoom-pct");
    if (el) {
      el.textContent = Math.round(scale * 100) + "%";
    }
  }

  function initBoardInteraction() {
    const svg = $("node-board-svg");
    if (!svg) {
      return;
    }

    let panning = false;
    let lastSvgPt = { x: 0, y: 0 };

    /** @type {SVGGElement | null} */
    let dragNode = null;
    let dragOffX = 0;
    let dragOffY = 0;
    let dragMoved = false;
    let dragStartClient = { x: 0, y: 0 };
    const DRAG_THRESH = 4;

    function endPan() {
      panning = false;
    }

    svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.button !== 1) {
        return;
      }
      if (e.target && e.target.closest && e.target.closest("g.mlab-node")) {
        return;
      }
      const t = e.target;
      if (t && t.id === "node-board-svg") {
        // click on root
      }
      e.preventDefault();
      panning = true;
      lastSvgPt = pointerToSvg(svg, e.clientX, e.clientY);
      svg.setPointerCapture(e.pointerId);
    });

    svg.addEventListener("pointermove", (e) => {
      if (!panning) {
        return;
      }
      const p = pointerToSvg(svg, e.clientX, e.clientY);
      panX += p.x - lastSvgPt.x;
      panY += p.y - lastSvgPt.y;
      lastSvgPt = p;
      updateGraphTransform();
    });
    svg.addEventListener("pointerup", (e) => {
      if (panning) {
        endPan();
        try {
          svg.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }
    });
    svg.addEventListener("pointercancel", endPan);

    function endNodeDrag(/** @type {PointerEvent} */ e) {
      if (!dragNode) {
        return;
      }
      const id = dragNode.getAttribute("data-id");
      const wasMoved = dragMoved;
      const el = dragNode;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      window.removeEventListener("pointermove", onNodeWindowMove, true);
      window.removeEventListener("pointerup", onNodeWindowUp, true);
      window.removeEventListener("pointercancel", onNodeWindowUp, true);
      dragNode = null;
      dragMoved = false;
      if (wasMoved) {
        saveGraphLayout();
      }
      if (id && !wasMoved) {
        setSelectedNode(id);
      }
    }

    function onNodeWindowMove(/** @type {PointerEvent} */ e) {
      if (!dragNode) {
        return;
      }
      e.preventDefault();
      const dx = e.clientX - dragStartClient.x;
      const dy = e.clientY - dragStartClient.y;
      if (Math.hypot(dx, dy) > DRAG_THRESH) {
        dragMoved = true;
      }
      const gp = clientToGraph(svg, e.clientX, e.clientY);
      setNodePosition(dragNode, gp.x - dragOffX, gp.y - dragOffY);
      updateWires();
    }

    function onNodeWindowUp(/** @type {PointerEvent} */ e) {
      endNodeDrag(e);
    }

    /**
     * @param {SVGGElement} g
     */
    function wireNodeDrag(g) {
      if (g.dataset.mlDragWire === "1") {
        return;
      }
      g.dataset.mlDragWire = "1";
      g.addEventListener(
        "pointerdown",
        (e) => {
          const hit = e.target instanceof Element && e.target.closest && e.target.closest("circle.socket");
          if (hit) {
            return;
          }
          e.stopPropagation();
          e.preventDefault();
          dragNode = /** @type {SVGGElement} */ (g);
          dragStartClient = { x: e.clientX, y: e.clientY };
          dragMoved = false;
          const gp = clientToGraph(svg, e.clientX, e.clientY);
          const pos = nodeCenter(dragNode);
          dragOffX = gp.x - pos.x;
          dragOffY = gp.y - pos.y;
          if (dragNode.parentNode) {
            dragNode.parentNode.appendChild(dragNode);
          }
          try {
            dragNode.setPointerCapture(e.pointerId);
          } catch {
            // ignore
          }
          window.addEventListener("pointermove", onNodeWindowMove, true);
          window.addEventListener("pointerup", onNodeWindowUp, true);
          window.addEventListener("pointercancel", onNodeWindowUp, true);
        },
        true
      );
      if (g.getAttribute("data-kind") === "frame") {
        g.addEventListener("dblclick", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const tx = /** @type {SVGTextElement | null} */ (g.querySelector(".frame-note-el"));
          const prev = tx && tx.textContent ? tx.textContent : "";
          const n = window.prompt("Frame note", prev);
          if (n != null && tx) {
            tx.textContent = n.length > 120 ? n.slice(0, 117) + "…" : n;
            saveGraphLayout();
          }
        });
      }
    }

    document.querySelectorAll("g.mlab-node").forEach((g) => {
      wireNodeDrag(/** @type {SVGGElement} */ (g));
    });
    wireNodeDragImpl = wireNodeDrag;

    svg.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const d = e.deltaY > 0 ? -0.08 : 0.08;
        scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + d));
        updateGraphTransform();
        updateZoomLabel();
      },
      { passive: false }
    );

    $("btn-zoom-fit") &&
      $("btn-zoom-fit").addEventListener("click", () => {
        panX = 0;
        panY = 0;
        scale = 1;
        updateGraphTransform();
        updateZoomLabel();
        saveGraphLayout();
      });

    const bgSock = $("board-graph");
    if (bgSock) {
      attachSocketWireHandlers(bgSock);
    }
  }

  function onSeekFromHost(/** @type {object} */ j) {
    lastSeekJson = j || null;
    if (j) {
      syncMlabAssetRow(/** @type {object} */ (j));
      updateBackdropFromSeek(/** @type {object} */ (j));
    } else {
      refreshBackdropHot();
    }
    if (selEq("analysis-metrics")) {
      syncAnalysisPipelineNpanel();
      syncAnalysisDashboardNpanel();
      syncAnalysisPreviewNpanel();
    }
    if (selEq("portfolio-mix")) {
      syncPortfolioStatsNpanel();
    }
  }

  function init() {
    applyStoredNPanel();
    ensureMlabAssetSelectWired();
    wireUberApplyDelegation();
    const btn = $("btn-npanel");
    btn && btn.addEventListener("click", () => toggleNPanel());
    document.addEventListener("keydown", (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        toggleNPanel();
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (typeof selectedId !== "string") {
          return;
        }
        /** @type {Element | null} */
        let go = null;
        for (const node of document.querySelectorAll("g.mlab-node")) {
          if (node.getAttribute("data-id") === selectedId) {
            go = node;
            break;
          }
        }
        if (!go || !go.parentNode) {
          return;
        }
        if (selectedId.startsWith("frame-")) {
          e.preventDefault();
          go.remove();
          setSelectedNode("market-data");
          saveGraphLayout();
          updateWires();
          return;
        }
        if (go.getAttribute("data-core") === "0") {
          e.preventDefault();
          const removeId = selectedId;
          go.remove();
          graphEdges = graphEdges.filter((ed) => ed.from[0] !== removeId && ed.to[0] !== removeId);
          setSelectedNode("market-data");
          saveGraphLayout();
          updateWires();
        }
      }
    });
    initBackdropChart();
    setSelectedNode(selectedId);
    buildUberConfig();
    initBoardInteraction();
    loadGraphLayout();
    if (!graphEdges.length) {
      graphEdges = normalizeGraphEdges(null);
      updateWires();
    }
    $("btn-graph-add-frame") &&
      $("btn-graph-add-frame").addEventListener("click", () => {
        addFrameNode();
      });
    const addKindSel = $("graph-add-kind");
    if (addKindSel instanceof HTMLSelectElement) {
      addKindSel.addEventListener("change", () => {
        const k = /** @type {string} */ (addKindSel.value);
        addKindSel.value = "";
        if (k !== "md" && k !== "sig" && k !== "port" && k !== "ana") {
          return;
        }
        const tmplKey = PRIMARY_TEMPLATE_ID[/** @type {"md"|"sig"|"port"|"ana"} */ (k)];
        const proto = tmplKey ? qsNode(tmplKey) : null;
        const bc =
          proto && proto instanceof SVGElement
            ? nodeCenter(/** @type {SVGGElement} */ (proto))
            : { x: 120, y: 140 };
        const gx = bc.x + 52;
        const gy = bc.y + 42;
        const g = createPipelineNode(k, null, gx, gy);
        if (g) {
          const nid = g.getAttribute("data-id");
          if (nid) {
            setSelectedNode(nid);
          }
          saveGraphLayout();
        }
      });
    }
    updateWires();
    updateGraphTransform();
    updateZoomLabel();
    void pushPortfolioToHost();
  }

  window.MLWorkbench = {
    init,
    onSeek: onSeekFromHost,
    setSelectedNode,
    updateWires,
    /** @param {{ skipResync?: boolean } | void} [opts] forwarded to `pushPortfolioToHost` */
    reapplyPortfolioToHost: (opts) => pushPortfolioToHost(opts),
  };
})();
