# Market Lab: Software Requirements Document (V2.5)

**Project status:** implementation-ready (decisions ratified)  
**Parent project:** `OTL_Suite` (monorepo)  
**Stack reference:** Corrosion 0.5 (Rust–C++), OSL / `oslexec`, GTest (core verification; Market Lab does not replace tests)

---

## 1. Structural definition and isolation

Market Lab is the **application layer** for `OTL_Suite`. It lives in this repository at `**OTL-MarketLab/`** but is **architecturally isolated** from the math and execution kernels.


| Rule              | Description                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Consumer only** | Market Lab depends on OTL-Core, VectorTA (via a host process), OSL, and lab outputs; it **must not** be imported, linked, or referenced from `OTL-Core/`, `3rdparty/*`, or core CMake targets.                                                                                                                                                                             |
| **Top-down**      | **Market Lab → core** is allowed. **Core → Market Lab** is forbidden.                                                                                                                                                                                                                                                                                                      |
| **Non-intrusive** | UI changes do **not** require re-verification of OSL or the Rust bridge **as long as the public host/API contract stays stable** (the core remains GTest-verified on its own schedule).                                                                                                                                                                                    |
| **Scope**         | Market Lab is responsible for **the visual product**: windowing, tabbed workbench, **interactive** node graph, OTL editing (including **.otl**-specific helpers), NASA-style telemetry, dual-scale timeline, and **wall-clock** time UX. All **runtime integration** with engines goes through a **dedicated host** (see §3), not by `#include` from core into UI sources. |


### 1.1 Repository layout (authoritative)

- `**OTL_Suite/OTL-Core/`** — C++ engine, `OtlUniverse`, `OtlNodeSystem`, `OtlAnalytics`, integrators, OSL registration, etc.  
- `**OTL_Suite/3rdparty/VectorTA/`** + Corrosion / `**vector_ta**` + generated `**otl_vector_ta_cxx**` (build targets, not a top-level source folder).  
- `**OTL_Suite/OTL-MarketLab/**` — this UI/UX product (separate app + assets + docs).  
- **Legacy path names in earlier drafts** (`/OTLSuite/MarketLab`, `otl_vector_ta_cxx` as a path) are **superseded** by the paths above.

---

## 2. Decisions (implementation)

These choices unblock engineering; they are **normative** for V1.


| Topic                         | Decision                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **UI shell (V1)**             | **Electron** in `OTL-MarketLab/electron/` (Node + Electron; no C++ link to core).                                                                                                                                                                                                                                                                                        |
| **Runtime model**             | **Option B:** UI talks to a **separate** `otl_marketlab_host` that loads `vector_ta`, `oslexec` / OSL, and `otl_core` **in-process**.                                                                                                                                                                                                                                    |
| **Host ↔ UI: Command Bridge** | **Named pipes** on Windows, **Unix domain sockets** on POSIX. **Not gRPC** in V1 (local stream IPC: fast, simple). **Line protocol**; JSON payloads on `OK` / `ERR` lines. See `OTL-MarketLab/docs/Command_Bridge.md`.                                                                                                                                                   |
| **Connection order**          | Host **listens** on the bridge at startup; Electron **connects** on launch, then `LOAD_DATA <path_to_csv>`. **Scrub:** UI sends `SEEK <token>`; host returns node states + telemetry for that tick.                                                                                                                                                                      |
| **MVP**                       | **Full SRD V1** — nothing from §5–6 is “later”; tabs, **interactive** graph, script editor w/ hot-reload, telemetry, dual-scale timeline, and scrub modes are all **in** MVP.                                                                                                                                                                                            |
| **Data source of truth (V1)** | **Loaded CSV** produced by the Yahoo / lab ingest (e.g. `OTL_Data/`, `scripts/fetch_market_data.py` outputs). “Live” in the SRD is **live relative to the loaded series** and playback/scrub, not a separate real-time exchange feed in V1. **Index mapping** (timestamp ↔ CSV row) is **owned by the host**; the UI’s timeline uses **wall clock** as the primary axis. |
| **Time UX**                   | The user works in **wall-clock** (dates and times). **Bar index and internal row index** are host concerns; the UI’s scrubbable **timeline** (Canvas) drives `SEEK` in wall-clock terms.                                                                                                                                                                                 |
| **Node system**               | Market Lab uses a **dedicated, richer project graph and node taxonomy** that covers the **full workflow** (see §4). It may **import/export** or map to `OtlNodeSystem` JSON where appropriate but is **not** limited to the current C++ `OtlNodeSystem` v1 JSON alone. V1 is **fully interactive** (add/remove/edit nodes and edges).                                    |
| **Languages**                 | **OTL** in product terms: **.osl** and **.otl** with **.otl-specific** editor helpers, snippets, and validation where specified.                                                                                                                                                                                                                                         |
| **Platforms**                 | **Cross-platform** from day one: Windows, macOS, and Linux. Runtime search paths must abstract OS differences (`PATH` and `.dll` on Windows, `LD_LIBRARY_PATH` / rpath on Linux, `DYLD` / bundling on macOS).                                                                                                                                                            |
| **Build**                     | Market Lab is **independently** buildable in its own directory but **participates** in the monorepo “build everything” story (e.g. optional top-level target or `cmake --target market_lab` / scripted CI step that builds host + UI **without** adding reverse dependencies in core).                                                                                   |


---

## 3. Runtime architecture (Option B) + Command Bridge

```text
┌─────────────────────┐   Named pipe / UDS (Command Bridge)   ┌──────────────────────────┐
│  Market Lab UI     │  ────────────────────────────────►   │  otl_marketlab_host     │
│  (Electron)         │  ◄────────────────────────────────   │  loads otl_core,         │
│  OTL-MarketLab/     │  OK/ERR + JSON (LOAD_DATA, SEEK, PING) │  vector_ta, oslexec,     │
│  electron/          │                                       │  Yahoo CSV bar mapping   │
└─────────────────────┘                                       └──────────────────────────┘
```

- **UI:** **Electron**; no native engine symbols. Connects to the **same** bridge path the host created (config via `bridgeConfig.cjs` / env; defaults in C++ and docs must agree).  
- **Host:** **Listens** first; **single client** in V1 is sufficient. Resolves `vector_ta` and OSL, maps **wall clock ↔ bar** for the loaded Yahoo-style CSV, runs node system updates, returns JSON for `SEEK`.  
- **Contract:** `Command_Bridge.md` is normative for wire format; version field in JSON as needed for host v1+.

### 3.1 V1 implementation priority (shell regions)

Satisfy MVP scope by building **three** main regions in the Electron shell (layout may evolve into full tabs later):


| Priority | Region                         | Notes                                                                                                                                                                                                                                                   |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A**    | **NASA dashboard (telemetry)** | CSS Grid (or later docking) for “pinned” metrics; **monospaced** numbers so `vector_ta` values do not jiggle layout; **pre-attentive color** (green / yellow / red) from **bridge heartbeat** and host health, not from guessing `cxx` directly.        |
| **B**    | **Node graph (DCC-style)**     | Map **OtlNodeSystem** / project stages to a visual canvas: data ingest, OSL kernel blocks, backtest/integrator nodes. **Drag from socket to socket** to create edges; **right-click a connection** (future) for **visual diff** between kernel outputs. |
| **C**    | **Scrubbable timeline**        | **Custom Canvas** at bottom; **wall clock** primary axis. **Index mapping** stays in the host: UI scrubs in time, sends `SEEK`, host returns data for the correct bar.                                                                                  |


---

## 4. Workflow and node graph (full pipeline)

The Market Lab **graph model** must support an end-to-end **storyboard**, not only indicator wiring:

1. **Data** — Ingest / select Yahoo-derived CSV, universe, calendar alignment.
2. **OTL** — Strategy graph, closures, and shading logic (.osl / .otl).
3. **Integrators** — GAL / portfolio / GA integration steps.
4. **Back test** — Deterministic run over loaded bars, with **wall-clock** alignment in the UI.
5. **Output data** — Series, weights, trades, and intermediate buffers exposed as **sockets** for telemetry.
6. **Analytics & econometrics** — Otl-style metrics, CSV dashboards, and plots (aligned with `OtlAnalytics` and lab scripts).

**Accommodation strategy:**

- A **first-class “pipeline stage”** or **node category** in the project file (e.g. DataSource, OtlGroup, Integrator, Backtest, OutputSink, Analytics).  
- **Typed edges** and validation rules so illegal wiring is caught before run.  
- **Serialization** of the project as JSON (or equivalent) **owned by Market Lab**; export paths to C++ `OtlNodeSystem` v1 only where a strict subset exists.

(Full node catalog and file schema: separate **Node Spec** or appendix when implementation starts.)

---

## 5. UX: temporal synchrony

The UI is a **time-aware** execution environment: **Design state** (graph + scripts) and **result state** (telemetry, PnL, metrics) stay aligned on a **unified** wall-clock axis.

- **Live mode (relative to data):** Playhead on the **latest** bar in the loaded dataset (or current playback end).  
- **Historical scrub mode:** “Shadow” chrome (e.g. desaturation or accent) while the playhead is not at the live end; all panels show values at the **selected wall-clock** instant.

---

## 6. UI components (MVP)

### 6.1 Tabbed workspace (node and code)

- **Node graph tab:** **Interactive**; nested OTL context via breadcrumbs; “spark” mini-curves on ports where specced.  
- **Script tab:** OSL/OTL with **.otl** helpers, completion, and **save → hot recompile** in the **host** (errors surfaced in the editor).  
- **Bridge heartbeat:** Reflects health of the **host ↔ VectorTA** path (or whole host) — *not* a direct UI link to `cxx`.

### 6.2 NASA-style telemetry (high density)

- Drag from graph outputs into tiles; functional color (green/yellow/red per SRD).  
- Monospaced numerics to reduce jitter on updates.

### 6.3 Dual-scale timeline

- **Macro** strip: full loaded range, heat / activity.  
- **Micro** scrub: fine resolution for wall-clock **scrub and snap**.

---

## 7. Technical integration and build (no reverse deps)

- **OS resolution:** The **host** (not the raw browser process) is responsible for OS-specific library discovery (e.g. Windows `0xc0000135` class failures). The UI may pass **configurable paths** to the host.  
- **Headers:** The UI codebase does not compile against `3rdparty/osl/...` directly; the **host** does.  
- **Verification story:** GTest in `tests/` remains the **source of truth** for core math; the host adds **smoke** or **integration** tests for the API.

**Monorepo build:** An optional top-level target or script (e.g. `market_lab` / `all`) may build **(1)** OTL host binary and **(2)** UI bundle, **without** any `add_subdirectory` from `OTL-Core` into `OTL-MarketLab` sources.

---

## 8. Visual reference (mood)

**Functional precision** — dark `#121212`, Katana/Nuke/node discipline, Open MCT modularity, Blender-like property regions, Gaffer-style procedural feel.

DCC node editor and parameter panel reference

---

**Conformance checklist** (requirements ↔ code): **`docs/SRD_CONFORMANCE.md`** — update when changing bridge semantics, SEEK JSON contracts, or host/UI UX that traces to §§1–8 in this SRD.

---

**Document history:** V2.3 structural draft; **V2.4** path corrections, Option B, full MVP, CSV+wall clock, interactive graph, OTL/.otl, cross-platform, monorepo build note. **V2.5** — Electron, Command Bridge (named pipe / UDS, no gRPC V1), connection order, `LOAD_DATA` / `SEEK`, host-owned bar mapping, and **A / B / C** shell implementation priority.