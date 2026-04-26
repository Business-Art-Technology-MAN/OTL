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
  let backdropResizeObserver = null;
  const PORTFOLIO_UI_KEY = "mlabPortfolioUiV1";
  /** `localStorage` for Uber N-panel OSL shader directory (path sent as `lab.osl_shader_dir`). */
  const MLAB_OSL_SHADER_DIR_KEY = "mlab.osl_shader_dir";

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
      };
      if (LineS && backdropChart && typeof backdropChart.addSeries === "function") {
        analysisBuyHoldLineSeries = backdropChart.addSeries(LineS, bhOpts);
      } else if (backdropChart && typeof backdropChart.addLineSeries === "function") {
        analysisBuyHoldLineSeries = backdropChart.addLineSeries(bhOpts);
      }
    } catch (e) {
      console.warn("MLWorkbench: analysis B&H line", e);
    }
  }

  /**
   * @typedef {{ method: 'equal'|'strength'|'risk', leverage: number, commBps: number, slippageBps: number }} PortfolioUiV1
   */

  /** @returns {PortfolioUiV1} */
  function defaultPortfolioUi() {
    return { method: "equal", leverage: 1, commBps: 2, slippageBps: 5 };
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
      return {
        method,
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
    if (LC && LC.PriceScaleMode) {
      mode = enabled ? LC.PriceScaleMode.Logarithmic : LC.PriceScaleMode.Normal;
    } else {
      mode = enabled ? 1 : 0;
    }
    try {
      if (typeof backdropChart.priceScale === "function") {
        backdropChart.priceScale("right").applyOptions({ mode: mode });
      } else {
        backdropChart.applyOptions({
          rightPriceScale: { mode: mode },
        });
      }
    } catch (e) {
      console.warn("MLWorkbench: price scale mode", e);
    }
  }

  /** Host `telemetry.portfolio` (no client-side PnL math). */
  function getPortfolioTelemetry(/** @type {object} */ j) {
    const t = j && j.telemetry;
    const p = t && t.portfolio;
    if (!p || typeof p !== "object") {
      return null;
    }
    const eq = p.equity_tail;
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
    return JSON.stringify({
      method: u.method,
      leverage: u.leverage,
      comm_bps: u.commBps,
      slippage_bps: u.slippageBps,
    });
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
    if (selectedId === "portfolio-mix") {
      el.textContent = "EQUITY + DRAWDOWN (host · telemetry.portfolio)";
    } else if (selectedId === "analysis-metrics") {
      el.textContent = "STRATEGY WEALTH vs BUY & HOLD (log · host · telemetry.analysis)";
    } else {
      el.textContent = "BACKDROP";
    }
  }

  function updateBackdropFromSeek(/** @type {object} */ j) {
    if (!closeLineSeries) {
      return;
    }
    if (selectedId === "portfolio-mix") {
      setBackdropLogScale(false);
      if (analysisBuyHoldLineSeries) {
        analysisBuyHoldLineSeries.setData([]);
        analysisBuyHoldLineSeries.applyOptions({ visible: false });
      }
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
    } else if (selectedId === "analysis-metrics") {
      setBackdropLogScale(true);
      if (portfolioDdSeries) {
        portfolioDdSeries.setData([]);
        portfolioDdSeries.applyOptions({ visible: false });
      }
      if (shadowLineSeries) {
        shadowLineSeries.setData([]);
        shadowLineSeries.applyOptions({ visible: false });
      }
      const at = getAnalysisTelemetry(j);
      const ref = closeTailToLineData(j);
      if (!at || !ref || ref.length < 2 || at.wealthTail.length !== ref.length) {
        closeLineSeries.setData([]);
        if (analysisBuyHoldLineSeries) {
          analysisBuyHoldLineSeries.setData([]);
          analysisBuyHoldLineSeries.applyOptions({ visible: false });
        }
        closeLineSeries.applyOptions({ title: "wealth (host)" });
      } else {
        const wealth = ref.map((p, i) => ({ time: p.time, value: Number(at.wealthTail[i]) }));
        closeLineSeries.setData(wealth);
        closeLineSeries.applyOptions({ title: "strategy wealth (host)" });
        if (analysisBuyHoldLineSeries && at.buyHoldTail && at.buyHoldTail.length === ref.length) {
          const bhd = ref.map((p, i) => ({ time: p.time, value: Number(at.buyHoldTail[i]) }));
          analysisBuyHoldLineSeries.setData(bhd);
          analysisBuyHoldLineSeries.applyOptions({ visible: true, title: "buy & hold (host)" });
        } else if (analysisBuyHoldLineSeries) {
          analysisBuyHoldLineSeries.setData([]);
          analysisBuyHoldLineSeries.applyOptions({ visible: false });
        }
        if (backdropChart) {
          backdropChart.timeScale().fitContent();
        }
      }
    } else {
      setBackdropLogScale(false);
      if (analysisBuyHoldLineSeries) {
        analysisBuyHoldLineSeries.setData([]);
        analysisBuyHoldLineSeries.applyOptions({ visible: false });
      }
      const data = closeTailToLineData(j);
      if (data.length < 2) {
        closeLineSeries.setData([]);
      } else {
        closeLineSeries.setData(data);
        if (backdropChart) {
          backdropChart.timeScale().fitContent();
        }
      }
      closeLineSeries.applyOptions({ title: "close (tail)" });
      if (portfolioDdSeries) {
        portfolioDdSeries.setData([]);
        portfolioDdSeries.applyOptions({ visible: false });
      }
      if (shadowLineSeries) {
        const sh = j && j.shadow_overlay;
        const a = sh && sh.m_attr != null ? String(sh.m_attr) : "";
        if (sh && arrOk(sh.tail) && PIPELINE_SHADOW_NODE_IDS.has(selectedId) && isPriceScaleShadow(a)) {
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

  /** Socket offsets (local to each node’s transform origin) */
  const NET = {
    "market-data": { out: { x: 200, y: 100 } },
    "signal-otl": { in: { x: 0, y: 100 }, out: { x: 220, y: 100 } },
    "portfolio-mix": {
      in1: { x: 0, y: 52 },
      in2: { x: 0, y: 74 },
      in3: { x: 0, y: 96 },
      outClosure: { x: 210, y: 64 },
      outData: { x: 210, y: 108 },
    },
    "analysis-metrics": { in: { x: 0, y: 100 } },
  };

  /** Orange shadow in backdrop: same SEEK feed for the whole chain — do not hide when only the Analysis node is selected. */
  const PIPELINE_SHADOW_NODE_IDS = new Set(["market-data", "signal-otl", "portfolio-mix", "analysis-metrics"]);

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
        "• OSL <code>MarketDelegate</code> can resolve the same <code>m_*</code> when wired.\n• <strong>Backdrop</strong> orange shadow stays on for any <strong>green→blue→gold→purple</strong> node along the data path (same SEEK feed).\n• <strong>m_attrs_for_osl</strong> in SEEK lists register names.",
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
        "Host-computed <strong>ANLY-CALC</strong> summary and preview rows in <code>telemetry.analysis</code>. <strong>Backdrop</strong> uses a <strong>log</strong> scale: strategy wealth vs buy &amp; hold benchmark on the same close tail. Use <strong>Save to CSV</strong> for <code>EXPORT_CSV</code> (ANLY-CSV).",
      extra:
        "• Preview table highlights the playhead row (ANLY-VIS)\n• Signal column uses the host’s first RSI series when available, else 0",
    },
  };

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
  <table class="ana-table" id="ana-sum-table" aria-label="Metrics">
    <thead><tr><th>Metric</th><th>Value</th></tr></thead>
    <tbody>
      <tr><td>CAGR</td><td id="ana-v-cagr">—</td></tr>
      <tr><td>Total return</td><td id="ana-v-tr">—</td></tr>
      <tr><td>Max DD</td><td id="ana-v-mdd">—</td></tr>
      <tr><td>Sharpe</td><td id="ana-v-sh">—</td></tr>
      <tr><td>Sortino</td><td id="ana-v-so">—</td></tr>
      <tr><td>Profit factor</td><td id="ana-v-pf">—</td></tr>
      <tr><td>Win rate</td><td id="ana-v-wr">—</td></tr>
      <tr><td>Buy &amp; hold (TR)</td><td id="ana-v-bh">—</td></tr>
    </tbody>
  </table>
  <div class="ana-strip-hdr ana-mt">Preview (scrub row)</div>
  <div class="ana-preview-wrap" id="ana-preview-wrap" role="region" aria-label="Export preview" tabindex="0">
    <table class="ana-preview-tbl" id="ana-preview-tbl" aria-label="SEEK rows">
      <thead>
        <tr>
          <th>Time</th><th>Price</th><th>Sig</th><th>W</th>
          <th>Δ%</th><th>Wealth</th><th>DD%</th>
        </tr>
      </thead>
      <tbody id="ana-preview-body"></tbody>
    </table>
  </div>
  <div class="ana-csv-row">
    <button type="button" class="btn-ana-csv" id="btn-ana-csv" title="EXPORT_CSV path via host">Save to CSV…</button>
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
    const ns = j && j.node_states;
    if (!ns || typeof ns !== "object") {
      return "SEEK has no node_states from the host.";
    }
    const parts = ["bar " + bar];
    for (const k of Object.keys(/** @type {object} */ (ns))) {
      if (k === "map_from") {
        continue;
      }
      const v = /** @type {Record<string, unknown>} */ (ns)[k];
      const s =
        typeof v === "number" && !Number.isNaN(v) ? (Math.abs(v) >= 1e5 || Math.abs(v) < 1e-3 ? v.toExponential(3) : String(Math.round(v * 1e5) / 1e5)) : String(v);
      parts.push(String(k) + "=" + s);
    }
    return "Host feed (this bar, same for all pipeline nodes): " + parts.join(" · ");
  }

  function syncAnalysisPipelineNpanel() {
    const p = $("npanel-ana-pipeline");
    if (p) {
      p.textContent = formatAnalysisPipelineLine();
    }
  }

  function syncAnalysisDashboardNpanel() {
    if (selectedId !== "analysis-metrics" || !lastSeekJson) {
      return;
    }
    const at = getAnalysisTelemetry(/** @type {object} */ (lastSeekJson));
    const s = at && at.summary;
    const sig = $("ana-sig-attr");
    if (sig) {
      sig.textContent = at && at.signalAttr ? "Signal series: " + at.signalAttr : "Signal series: —";
    }
    const setT = (/** @type {string} */ id, /** @type {string} */ v) => {
      const el = $(id);
      if (el) {
        el.textContent = v;
      }
    };
    if (!s) {
      setT("ana-v-cagr", "—");
      setT("ana-v-tr", "—");
      setT("ana-v-mdd", "—");
      setT("ana-v-sh", "—");
      setT("ana-v-so", "—");
      setT("ana-v-pf", "—");
      setT("ana-v-wr", "—");
      setT("ana-v-bh", "—");
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
  }

  function syncAnalysisPreviewNpanel() {
    const body = /** @type {HTMLTableSectionElement | null} */ ($("ana-preview-body"));
    if (!body) {
      return;
    }
    body.replaceChildren();
    if (selectedId !== "analysis-metrics" || !lastSeekJson) {
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
    const lv = lr ? Number(lr.value) : 1;
    return {
      method,
      leverage: !Number.isFinite(lv) ? 1 : Math.min(5, Math.max(0.25, lv)),
      commBps: c ? Math.max(0, Number(c.value) || 0) : 2,
      slippageBps: s ? Math.max(0, Number(s.value) || 0) : 5,
    };
  }

  /** @returns {PortfolioUiV1} */
  function getEffectivePortfolioUi() {
    if (selectedId === "portfolio-mix") {
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
    const lr = /** @type {HTMLInputElement | null} */ ($("port-lev"));
    const c = /** @type {HTMLInputElement | null} */ ($("port-comm"));
    const s = /** @type {HTMLInputElement | null} */ ($("port-slip"));
    if (a) {
      a.value = u.method;
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
    if (!lastSeekJson || selectedId !== "portfolio-mix") {
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
    if (selectedId === "portfolio-mix") {
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
    const t = NPANEL_TEXT[id] || { title: "Node", body: "—", extra: "" };
    if (id === "market-data") {
      return (
        `<h4 class="npanel-item-h">${t.title}</h4>` +
        `<p class="npanel-item-p">${t.body}</p>` +
        MARKET_NPANEL_MD +
        `<p class="npanel-item-x">${t.extra}</p>`
      );
    }
    if (id === "signal-otl") {
      return (
        `<h4 class="npanel-item-h">${t.title}</h4>` +
        `<p class="npanel-item-p">${t.body}</p>` +
        UBER_NPANEL_FORM +
        `<p class="npanel-item-x">${t.extra}</p>`
      );
    }
    if (id === "analysis-metrics") {
      return (
        `<h4 class="npanel-item-h">${t.title}</h4>` +
        `<p class="npanel-item-p">${t.body}</p>` +
        `<p class="npanel-item-p npanel-ana-pipe mono" id="npanel-ana-pipeline"></p>` +
        ANALYSIS_NPANEL_FORM +
        `<p class="npanel-item-x">${t.extra}</p>`
      );
    }
    if (id === "portfolio-mix") {
      return (
        `<h4 class="npanel-item-h">${t.title}</h4>` +
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

  function setNodePosition(g, x, y) {
    g.setAttribute("transform", `translate(${x},${y})`);
  }

  function nodeCenter(g) {
    return parseTranslate(g);
  }

  function socketPoint(id, which) {
    const g = document.querySelector(`g.mlab-node[data-id="${id}"]`);
    if (!g) {
      return { x: 0, y: 0 };
    }
    const p = nodeCenter(g);
    const s = NET[id];
    if (!s) {
      return p;
    }
    const o = s[which];
    if (!o) {
      return p;
    }
    return { x: p.x + o.x, y: p.y + o.y };
  }

  function wirePath(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const c = Math.max(48, Math.abs(dx) * 0.4);
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + c).toFixed(1)} ${y1.toFixed(1)} ${(x2 - c).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }

  function updateWires() {
    const a = (id) => {
      const el = $(id);
      if (el) {
        return el;
      }
      return null;
    };
    const w1 = a("wire-md-sig");
    const w2 = a("wire-sig-port");
    const w2b = a("wire-sig-port-2");
    const w2c = a("wire-sig-port-3");
    const w3 = a("wire-port-ana");
    const p1a = socketPoint("market-data", "out");
    const p1b = socketPoint("signal-otl", "in");
    const p2a = socketPoint("signal-otl", "out");
    const p2b1 = socketPoint("portfolio-mix", "in1");
    const p2b2 = socketPoint("portfolio-mix", "in2");
    const p2b3 = socketPoint("portfolio-mix", "in3");
    const p3a = socketPoint("portfolio-mix", "outData");
    const p3b = socketPoint("analysis-metrics", "in");
    if (w1) {
      w1.setAttribute("d", wirePath(p1a.x, p1a.y, p1b.x, p1b.y));
    }
    if (w2) {
      w2.setAttribute("d", wirePath(p2a.x, p2a.y, p2b1.x, p2b1.y));
    }
    if (w2b) {
      w2b.setAttribute("d", wirePath(p2a.x, p2a.y, p2b2.x, p2b2.y));
    }
    if (w2c) {
      w2c.setAttribute("d", wirePath(p2a.x, p2a.y, p2b3.x, p2b3.y));
    }
    if (w3) {
      w3.setAttribute("d", wirePath(p3a.x, p3a.y, p3b.x, p3b.y));
    }
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
    if (selectedId === "portfolio-mix") {
      closeLineSeries.applyOptions({
        color: "rgba(212, 180, 90, 0.95)",
      });
    } else if (selectedId === "analysis-metrics") {
      closeLineSeries.applyOptions({
        color: "rgba(186, 104, 200, 0.92)",
      });
    } else {
      closeLineSeries.applyOptions({
        color: "rgba(100, 180, 120, 0.9)",
      });
    }
  }

  function setSelectedNode(id) {
    selectedId = id;
    document.querySelectorAll("g.mlab-node").forEach((g) => {
      g.classList.toggle("selected", g.getAttribute("data-id") === id);
    });
    if (id === "signal-otl" || id === "market-data" || id === "analysis-metrics" || id === "portfolio-mix") {
      setNPanelCollapsed(false);
    }
    const np = $("npanel-item-body");
    if (np) {
      np.innerHTML = npanelHtmlForNode(id);
    }
    if (id === "market-data") {
      syncNpanelMarketPathFromNode();
    }
    if (id === "signal-otl") {
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
    }
    if (id === "analysis-metrics") {
      syncAnalysisPipelineNpanel();
      wireAnalysisDelegation();
      syncAnalysisDashboardNpanel();
      syncAnalysisPreviewNpanel();
    }
    if (id === "portfolio-mix") {
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

    document.querySelectorAll("g.mlab-node").forEach((g) => {
      g.addEventListener(
        "pointerdown",
        (e) => {
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
    });

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
      });
  }

  function onSeekFromHost(/** @type {object} */ j) {
    lastSeekJson = j || null;
    if (j) {
      updateBackdropFromSeek(/** @type {object} */ (j));
    } else {
      refreshBackdropHot();
    }
    if (selectedId === "analysis-metrics") {
      syncAnalysisPipelineNpanel();
      syncAnalysisDashboardNpanel();
      syncAnalysisPreviewNpanel();
    }
    if (selectedId === "portfolio-mix") {
      syncPortfolioStatsNpanel();
    }
  }

  function init() {
    applyStoredNPanel();
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
    });
    initBackdropChart();
    setSelectedNode(selectedId);
    buildUberConfig();
    initBoardInteraction();
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
