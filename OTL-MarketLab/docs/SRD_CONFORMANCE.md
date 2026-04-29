# SRD conformance (Market Lab)

This matrix ties **`MarketLab_SRD.md` (V2.5)** and **`NODE_EDITOR_UI_UX.md`** to **shipping behavior** so “meets SRD” is reviewable rather than asserted.

| ID | Requirement (source) | Status | Evidence / notes |
|----|----------------------|--------|------------------|
| **ISO-CONSUMER** | Market Lab depends on OTL-Core/UI only; core does not depend on Market Lab (`MarketLab_SRD.md` §1) | **Met** | No `OTL-MarketLab` / `MarketLab` references under `OTL-Core/` **CMakeLists**; core remains consumer-only |
| **BRIDGE** | Named pipe (Windows) / UDS (POSIX); line + JSON on OK/ERR (`§2`, `Command_Bridge.md`) | **Met** | `host/CommandBridge.cpp`, `electron/main.cjs`, `docs/Command_Bridge.md` |
| **HOST-LOADS-ENGINES** | `otl_marketlab_host` loads `otl_core`, VectorTA, OSL in-process (`§2–3`) | **Met** | Top-level `CMakeLists` + `OTL-MarketLab/host/CMakeLists.txt` link `otl_core`; DLL copy post-build |
| **CONNECTION ORDER** | Host listens; Electron connects; `LOAD_DATA`; `SEEK` for scrub (`§2`) | **Met** | Host server loop; preload connects; renderer `pickCsv` / `loadData` / `seek` |
| **WALL CLOCK AXIS** | Host owns timestamp ↔ row; UI scrubs primary wall clock (`§2`, `§6.3`) | **Met** | `HostState::find_bar_index_for_seek` + CSV bar labels; **`LOAD_DATA.timeline_axis`** supplies scrub tick samples (`bar`, `wall`); footer **`#timeline-macro-canvas`** (overview seek) stacked above **`#timeline-canvas`** (fine scrub); wall-derived labels |
| **NASA telemetry** | Monospace metrics; heartbeat color (`§6.2`, Node doc `§N-Panel`) | **Met** | `.telemetry-grid` / `.metric-tile`; `setConn`/heartbeat bridges `vector_ta` / `cxx` |
| **TEMPORAL SYNCHRONY §5** | Design + results aligned on unified time; historical scrub visually distinct (“shadow”) (`§5`) | **Met** | `body.timeline-historical` desaturates workspace when the playhead is before the final bar (`electron/renderer.js` + `styles/shell.css`) |
| **REGIONS A/B/C §3.1** | Dashboard / node graph / timeline (`MarketLab_SRD.md` §3.1) | **Met layout** | N-Panel telemetry; `workbench.js` node editor; **`#timeline-macro-canvas`** + **`#timeline-canvas`** + replay table |
| **NODE GRAPH pipeline** | Four kinds; interactive graph (`NODE_EDITOR_UI_UX.md`, `MarketLab_SRD` §4) | **Met** | Four kinds (`data-kind`); typed sockets / pairing and drag-to-connect in `electron/js/workbench.js`; **`#graph-add-kind`** adds duplicate shells (`createPipelineNode`); edges + pan/zoom in **`localStorage`** key `mlab.graphLayoutV1`; **Alt+click** wire to disconnect; extra nodes share canonical N-panel by role; host / bridge remains global |
| **ANALYSIS / VIEWER** | Equity/drawdown/metrics tables (`NODE_EDITOR §3`, `NODE_EDITOR_ANALYTIC_PERSISTENCE.md`) | **Met** | Host `append_analysis_telemetry` + `EXPORT_CSV`; N-panel: ANLY-CALC summary (key metrics + `n_periods`), ANLY-VIS preview with playhead row; log-scale backdrop (strategy wealth vs buy and hold). Trade-level duration/expectancy vs bar-return stats: **not** modeled — see N-panel copy for win-rate definition |
| **SCRIPT TAB + MONACO** | OSL/OTL editor with hot recompile (`MarketLab_SRD` §6.1) | **Not met (ack backlog)** | Uber JSON + host `SET_UBER_SIGNAL`; no separate Monaco script tab in this build — **V1+** |
| **DUAL-SCALE EXPLICIT** | Macro strip + micro scrub (`§6.3`) | **Met** | **`#timeline-macro-canvas`** + **`#timeline-canvas`** with shared bar mapping (`renderer.js`); `LOAD_DATA.timeline_axis.ticks` on macro |
| **BACKDROP EQUITY** | Viewer active → equity on canvas (`NODE_EDITOR §4.3`) | **Met** | With **Analysis** viewer: faded **reference close** (`close_tail` / price strip, **left · linear**) behind **strategy wealth + buy & hold** from `telemetry.analysis` (**right · log**) — dual Y scales in `workbench.js`. Uber / Portfolio selections keep their existing overlays (shadow, DD, equity strip). |
| **BUILD** | Market Lab buildable in monorepo without reverse includes (`§7–8`) | **Met** | `cmake --build … --target otl_marketlab_host`; Electron `npm` app under `electron/` |

## How to use this doc

1. Treat rows **Not met / Partial** as **product backlog** unless **`MarketLab_SRD.md`** is formally revised.

2. When behavior changes (`SEEK` JSON, bridge lines), update **`docs/Command_Bridge.md`**, **`docs/EXECUTION_CLOCK.md`**, and this matrix in the **same PR** when feasible.

3. Structural rule **ISO-CONSUMER** should be guarded in **code review**: no new `#include`/link from OTL-Core targets into OTL-MarketLab sources.
