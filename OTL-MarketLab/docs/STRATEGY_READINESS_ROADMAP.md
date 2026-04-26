# Strategy Readiness Roadmap (GAL, OSL, Multi-Asset, Execution)

This document **addresses the architectural gaps** between the current Market Lab **host** (`otl_marketlab_host`) and “real” strategy readiness: **closed-loop GAL**, **OSL-driven signals**, **multi-asset** topology, and **temporal / execution** fidelity. It does **not** implement those systems in a single pass; it records **ground truth in the repo**, **dependencies**, and a **phased** order of work so implementation can be scheduled deliberately.

| Gap | Priority | Rough complexity | Status in tree today |
|-----|----------|------------------|------------------------|
| OSL in host (ShadingSystem + `MarketDelegate`) | High | Medium–High | **Proven in `OTL-Core/main.cpp`**, not in `HostState` |
| GAL bar loop (`begin_bar` / `commit_post_gal`) | High | High | **Proven in `OTL-Sandbox/main.cpp` (M2)**, not in `HostState` |
| Multi-asset in bridge / UI (N &gt; 1) | Medium | Medium | `load_universe_close_matrix` + `OtlUniverse` support **N**; **host and UI** still **single-asset (asset 0)** for bake + PORT-CALC |
| Temporal / limit-order / T vs T+1 fill | Lower until core loop is closed | High | **Daily bar** CSV + **close-to-close** style math only; no limit-order book |
| Trade log in Analysis N-panel | Low | Low | **Preview/CSV** exist; not a per-trade **audit** API yet |

---

## 1. Open vs closed loop — GAL (`commit_post_gal`)

**Gap:** `PORT-CALC` in `HostState` is a **post-process** on a close tail: it does **not** run an integrator that updates portfolio state so the **next** bar’s costs see **`m_prev_weight`**.

**What already exists**

- `otl::OtlUniverse` exposes **`begin_bar()`** and **`commit_post_gal(std::vector<double> w)`** and **`osl_prev_weight()`** (see `OTL-Core/otl/OtlUniverse.hpp` / `.cpp`).
- A **full bar loop** with `begin_bar` → rebalance → `set_velocity_bivector` → **`commit_post_gal`** exists in **`OTL-Sandbox/main.cpp`** (Milestone 2 block).

**What the Market Lab host does today**

- `set_playhead` + `apply_to_asset(m_universe, 0, m_close0)`: bakes **VectorTA** for **one** asset.
- Portfolio / analysis **equity** paths use a **synthetic** integrator on the **first asset’s** close series, not `commit_post_gal`.

**Target design (incremental)**

1. **Define a single `HostState` bar-walk** (for scrub at bar `b` or for export) that, for each bar `t` in `0..b` (or a subset for performance):
   - `m_universe.set_bar(t)`.
   - `m_universe.begin_bar()`.
   - Produce **raw weights** (from OSL, rule engine, or current PORT-CALC proxy).
   - Apply **frictions** using **prev vs proposed** (needs portfolio state).
   - **`commit_post_gal(w)`** with the **post-friction** weights.
2. **SET_PORTFOLIO** should evolve from “static JSON of friction knobs” to “**config for the integrator**” (leverage limits, max turnover, cash leg, or a flag for **proxy** vs **GAL**), without breaking the existing JSON: prefer **versioned** fields, e.g. `{"version":2,"integrator":"gal_proxy",...}`.
3. **SEEK** telemetry should surface **`osl_prev_weight` / `current_portfolio()`** (even if scalars) when the closed loop is active so the **Analysis** and **CSV** can show **book state**, not just price-derived curves.

**Dependencies:** (2) and (3) are easier if **weights are N-asset** (see section 3).

---

## 2. OSL runtime — `ShadingSystem` + `MarketDelegate`

**Gap:** **Uber** bakes **hard-coded** indicators via `OtlNodeSystem` + VectorTA. **Custom `.osl` / `.oso`** is not yet driven from the **node graph** or **Command Bridge** (UI path to `.oso` is still future work).

**Milestone (done):** `otl_marketlab_host` runs the same **M1** path as `OTL_Engine` when the shader search path is set: **`lab.osl_shader_dir`** in `SET_UBER` JSON (takes precedence) or environment **`OTL_SHADER_DIR`**, pointing at a directory containing **`m1_alpha.oso`**. `mlab::OslM1Shading` (see `OTL-MarketLab/host/src/OslM1Shading.cpp`) builds the group `otl_m1_marketlab` / layer `m1_alpha`, executes per **`SEEK`**, and appends **`telemetry.osl_m1`** (`executed`, optional **`fix_signal`** {side, quantity, price}, or error text). Source shader: `OTL-Core/shaders/m1_alpha.osl` (compile with `oslc` to `.oso` and place on `searchpath:shader`).

**What already exists (suite-wide)**

- **`MarketDelegate`** (`OTL-Core/otl/MarketDelegate.*`) — `RendererServices` + `fetch_m` / `getattribute` into **`OtlUniverse`**.
- **End-to-end M1** pattern: `ShadingSystem`, `searchpath:shader`, `ShaderGroup`, **`execute`**, with `OtlRenderState` pointing at `OtlUniverse` — see **`OTL-Core/main.cpp`** (env `OTL_SHADER_DIR` + `m1_alpha`).

**What the host needs**

1. **Process lifetime:** one **`ShadingSystem`** + **`MarketDelegate`** (or minimal renderer) + optional `TextureSystem`, matching how `OTL-Core` does it, but **tolerate missing OSL** (same as M1: skip if no shader path).
2. **Bridge / Uber JSON** extension: **`lab.osl_shader_dir`** (done for M1 search path) can grow toward richer `osl: { path, group, ... }` for arbitrary shaders — **v2** schema when that lands.
3. **Per bar:** for each asset (when multi-asset is wired), set **ShaderGlobals** + **`OtlRenderState`**, `execute`, then read **output** (e.g. `fix_signal` / Ci) into **proposal weights** before GAL.
4. **Security:** shader path must be **user-controlled and validated** (absolute path, optional allowlist); document that **MVP** = local dev only.

**Suggested order:** wire **one** OSL **execute** in `seek` or a **dedicated** “dry run” bar step **after** `apply_to_asset`, **before** GAL, with **one** asset, then scale to N.

---

## 3. Multi-asset “universe” topology

**Gap:** **Telemetry and PORT-CALC** are centered on **asset 0** with **`m_close0`**; cross-asset covariance / joint allocation is not exposed.

**What already exists**

- **`load_universe_close_matrix`** fills **`OtlUniverse`** with **multiple** assets; **`load_data_json`** already reports `assets` count.
- **Single-asset** bake: `m_node_system.apply_to_asset(m_universe, 0, m_close0)`.

**Target design**

1. **Host:** loop **`a` in `0..asset_count-1`**, with either per-asset `apply_to_asset` or batch rules (performance profiling required).
2. **SEEK / telemetry:** either **per-asset** `node_states` (nested) or a **list**; avoid breaking the UI by **versioning** `seek_json` or adding **`telemetry.symbols`**, **`telemetry.by_asset`**.
3. **Node editor:** add a **“stack”** or **group** metaphor (per SRD) so **multiple** market streams feed one **Portfolio**; that maps to **one** `OtlUniverse` with **N** assets and a **vector** of weights, not N independent PORT-CALC tails.
4. **SET_PORTFOLIO** / GAL: joint allocation (risk parity across N, etc.) should consume **N×** series; covariance can live in `otl` or a small `HostState` helper once **N** is first-class in the sim loop.

---

## 4. Temporal fidelity (bar vs tick, T vs T+1 fill, limit orders)

**Gap:** **SEEK** is **bar**-indexed; “execution at T+1” and **limit** price are not modeled. Slippage today is a **small bps** term in the **proxy** path, not an **order** model.

**Target design (after GAL + multi-asset)**

- **State machine per bar:** **signal time** (e.g. close) vs **fill time** (next bar open) with explicit **prices** from OHLC when CSV is extended to **HLOC** or a second series.
- **Analysis:** add **slippage stats** (realized vs mid, not only `comm_bps` / `slippage_bps` constants) in **`telemetry.analysis`**.
- **Bridge:** no change to **SEEK** line format required initially; new fields in JSON (`fill_bar`, `fill_price`).

**Dependencies:** needs **infrastructure** in (1) and (3) first; otherwise “limit order” is cosmetic.

---

## 5. Event log (trade log) in Analysis

**Gap:** Audit trail of every **entry/exit**; preview table today is **bar-aligned** rows, not a **trade blotter**.

**Target:** emit **`telemetry.analysis.trades`** (array of `{ t_entry, t_exit, ... }`) from the **GAL+OSL** path once exits are defined, or a **simplified** log from **weight changes** in `commit_post_gal` (delta threshold). **Low** effort compared to (1)–(3); good **fast follow** once weights are real.

---

## Recommended implementation order (matches your “close OSL loop first” if read narrowly)

1. **OSL in host (minimal):** `ShadingSystem` + `MarketDelegate` + optional `OTL_SHADER_DIR` or **path in Uber JSON**, **one** asset, **one** `execute` per `SEEK` (or per scrub bar), no GAL change yet — proves **.oso** in the same process as the bridge.
2. **GAL loop:** port the **M2** pattern from `OTL-Sandbox` into **`HostState`** (or a dedicated `MlabBarSimulation` class), replacing the **post-hoc** equity path for **one** asset when a flag is on.
3. **Multi-asset** bake + `seek_json` shape + UI wiring.
4. **Execution model** (T+1, limits) and **slippage statistics**.
5. **Trade log** in telemetry + N-panel.

---

## References in this repo

| Area | File / symbol |
|------|----------------|
| GAL M2 loop | `OTL-Sandbox/main.cpp` (`begin_bar`, `commit_post_gal`, `rebalance_m2`, …) |
| OSL M1 + `MarketDelegate` | `OTL-Core/main.cpp` |
| OSL ↔ universe | `OTL-Core/otl/MarketDelegate.*`, `OtlRenderState` in `OtlUniverse.hpp` |
| Uber JSON / bridge | `HostState::set_uber_signal_json`, `CommandBridge` |
| Current PORT-CALC | `HostState.cpp` — `simulate_portfolio_equity_on_closes`, `append_portfolio_telemetry` |
| Default Uber JSON | `kDefaultUberConfig` in `HostState.cpp` |

---

## Summary

**Addressing** these issues in software terms means: **(a)** adopting the **existing** GAL and OSL **patterns** from `OTL-Sandbox` and `OTL-Core/main.cpp` into **` otl_marketlab_host`**, **(b)** extending **SET_UBER_SIGNAL / SET_PORTFOLIO / SEEK** contracts in **versioned** steps, and **(c)** evolving the **node editor** only after the **host** exposes **N-asset** and **stateful** data. This roadmap is the **agreed** backlog for that work; **implementation** should be **merged as separate PRs** by phase, not a single monolithic change.
