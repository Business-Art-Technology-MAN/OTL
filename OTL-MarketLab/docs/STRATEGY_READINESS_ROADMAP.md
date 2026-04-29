# Strategy Readiness Roadmap (GAL, OSL, Multi-Asset, Execution)

This document **addresses the architectural gaps** between the current Market Lab **host** (`otl_marketlab_host`) and “real” strategy readiness: **closed-loop GAL**, **OSL-driven signals**, **multi-asset** topology, and **temporal / execution** fidelity. It does **not** implement those systems in a single pass; it records **ground truth in the repo**, **dependencies**, and a **phased** order of work so implementation can be scheduled deliberately.

| Gap | Priority | Rough complexity | Status in tree today |
|-----|----------|------------------|------------------------|
| OSL in host (ShadingSystem + `MarketDelegate`) | High | Medium–High | **Done**: `OslM1Shading` + `lab.osl_shader_dir` / `OTL_SHADER_DIR` + `telemetry.osl_m1`. **`gal_m1` replay:** `execute(..., asset_id=a)` **per bar per asset** when **N&gt;1** (`HostState.cpp`); SEEK **`osl_m1`** exposes **`per_asset`** plus compat **`fix_signal`** (asset 0). Arbitrary shaders / graph-driven `.oso` — still future. |
| GAL bar loop (`begin_bar` / `commit_post_gal`) | High | High | **In host**: `SET_PORTFOLIO` with **`integrator`:** **`gal_m1`** → `run_gal_m1_replay`, **`equity_tail_gal`**, **`execution_clock`**, SEEK **`telemetry.portfolio`** includes **`current_weights`** / **`osl_prev_weight`** when replay succeeds · **Sandbox** remains M2 reference (`docs/EXECUTION_CLOCK.md`). |
| Multi-asset in bridge / UI (N &gt; 1) | Medium | Medium | **Host + UI (v1)**: **`m_asset_closes`**, bake all, SEEK **`node_states_by_asset`**, **`asset_labels`**, **`per_asset_telemetry`**, **`analysis_asset_index`** for analysis/portfolio column choice. **`close_proxy`** **`telemetry.portfolio`**: aligned tails + **`simulate_portfolio_equity_on_closes_multi`** (EW / risk / strength) when **N&gt;1** (`stats.close_proxy_multi_asset`) · **Covariance-matrix / richer joint rules** beyond proxy math — **open**. |
| Temporal / limit-order / T vs T+1 fill | Lower until core loop is closed | High | **Daily bar** CSV + **close-to-close** style math only; no limit-order book |
| Weight / audit log (telemetry + timeline) | Medium | Low–Medium | **Host**: **`telemetry.analysis.trades`** (`bar`, **`gross_turnover_l1`**, **`delta_w[]`**) on **`gal_m1`** SEEK (FIFO-capped buffer; aligned with **`m_gal_m1_trades_cache`** / replay modes). **Electron**: footer timeline **Replay log** spreadsheet. **Dedicated N-panel blotter** vs **classic entry–exit blotter** — optional / partial. |

---

## 1. Open vs closed loop — GAL (`commit_post_gal`)

**Gap:** `PORT-CALC` in `HostState` is a **post-process** on a close tail: it does **not** run an integrator that updates portfolio state so the **next** bar’s costs see **`m_prev_weight`**.

**What already exists**

- `otl::OtlUniverse` exposes **`begin_bar()`** and **`commit_post_gal(std::vector<double> w)`** and **`osl_prev_weight()`** (see `OTL-Core/otl/OtlUniverse.hpp` / `.cpp`).
- A **full bar loop** with `begin_bar` → rebalance → `set_velocity_bivector` → **`commit_post_gal`** exists in **`OTL-Sandbox/main.cpp`** (Milestone 2 block).

**What the Market Lab host does today**

- `set_playhead` runs `apply_to_asset` for **each loaded asset** using **`m_asset_closes`** (same `OtlNodeSystem` on every asset’s `m_close` series).
- `SET_PORTFOLIO` **`integrator: close_proxy`**: **`append_portfolio_telemetry`** uses **`close_tail`** aligned per asset when **N&gt;1** (**`simulate_portfolio_equity_on_closes_multi`**); **Analysis** summary / preview still keyed by **`analysis_asset_index`** plus buy-hold / wealth tails.
- `SET_PORTFOLIO` **`integrator: gal_m1`**: **OSL M1** (**per-asset** `execute` when **N&gt;1**; single execute on asset 0 when **N==1**) + `rebalance_m2` / one-asset blend + **`commit_post_gal`**, with **`equity_tail_gal`** = ∑_a w_{a,t-1}·r_{a,t} and **`analysis.trades`** weight events (see `EXECUTION_CLOCK.md`).

**Target design (incremental)**

1. **Define a single `HostState` bar-walk** (for scrub at bar `b` or for export) that, for each bar `t` in `0..b` (or a subset for performance):
   - `m_universe.set_bar(t)`.
   - `m_universe.begin_bar()`.
   - Produce **raw weights** (from OSL, rule engine, or current PORT-CALC proxy).
   - Apply **frictions** using **prev vs proposed** (needs portfolio state).
   - **`commit_post_gal(w)`** with the **post-friction** weights.
2. **SET_PORTFOLIO** should evolve from “static JSON of friction knobs” to “**config for the integrator**” (leverage limits, max turnover, cash leg, or a flag for **proxy** vs **GAL**), without breaking the existing JSON: prefer **versioned** fields, e.g. `{"version":2,"integrator":"gal_proxy",...}`.
3. **SEEK** telemetry surfaces **`osl_prev_weight`** / **`current_portfolio()`** (**`telemetry.portfolio`**) when **`gal_m1`** replay succeeds; **Analysis CSV** / export can consume those fields where wired.

**Dependencies:** (2) and (3) are easier if **weights are N-asset** (see section 3).

---

## 2. OSL runtime — `ShadingSystem` + `MarketDelegate`

**Gap:** **Uber** bakes **hard-coded** indicators via `OtlNodeSystem` + VectorTA. **Custom `.osl` / `.oso`** is not yet driven from the **node graph** or **Command Bridge** (UI path to arbitrary shaders is still future work).

**Milestone (host, `gal_m1`):** **`otl_marketlab_host`** runs the same **M1** path as `OTL_Engine` when the shader path (**`lab.osl_shader_dir`**, then **`OTL_SHADER_DIR`**) contains **`m1_alpha.oso`**. When **`integrator`** is **`gal_m1`** and **N &gt; 1**, `run_gal_m1_replay` calls **`OslM1Shading::execute(u, a, …)`** once per asset per bar and builds intent from each JSON (**`osl_m1_intent_from_per_asset_json`**); **N == 1** uses a single **`execute(..., 0)`** as before. **Telemetry** at the playhead merges **`per_asset`** payloads with backward-compatible top-level **`fix_signal`**.

**What already exists (suite-wide)**

- **`MarketDelegate`** (`OTL-Core/otl/MarketDelegate.*`) — `RendererServices` + `fetch_m` / `getattribute` into **`OtlUniverse`**.
- **End-to-end M1** pattern: `ShadingSystem`, `searchpath:shader`, `ShaderGroup`, **`execute`**, with `OtlRenderState` pointing at `OtlUniverse` — see **`OTL-Core/main.cpp`** (env `OTL_SHADER_DIR` + `m1_alpha`).

**What the host needs**

1. **Process lifetime:** one **`ShadingSystem`** + **`MarketDelegate`** (or minimal renderer) + optional `TextureSystem`, matching how `OTL-Core` does it, but **tolerate missing OSL** (same as M1: skip if no shader path).
2. **Bridge / Uber JSON** extension: **`lab.osl_shader_dir`** (done for M1 search path) can grow toward richer `osl: { path, group, ... }` for arbitrary shaders — **v2** schema when that lands.
3. **Per-asset M1 in `gal_m1` (done for same shader on all assets):** **`OtlRenderState::asset_id`** set per **`execute`**. **Multiple distinct `.oso`** layers or graph-selected shaders — **future**.
4. **Security:** shader path must be **user-controlled and validated** (absolute path, optional allowlist); document that **MVP** = local dev only.

**Suggested order (remaining):** richer **`osl: { path, group, … }`** in Uber JSON; optional **per-asset shader map** if designs require different **`.oso`** per symbol.

---

## 3. Multi-asset “universe” topology

**Gap (narrowing):** **Cross-asset covariance** and a **single joint optimizer** in **PORT-CALC / UI** remain **not** wired; **close_proxy** **portfolio** tails are **multi-asset synthetic** (EW/risk/strength heuristic in **`simulate_portfolio_equity_on_closes_multi`**). **Analysis** summary / preview remains **per `analysis_asset_index`** for primary curves. **GAL+`gal_m1` wealth** and **VectorTA** use **N** when the matrix has N columns.

**What already exists**

- **`load_universe_close_matrix`** fills **`OtlUniverse`**; **`load_data_json`** reports **`assets`**. The host keeps **`m_asset_closes`**, bakes **all** assets on **`set_playhead`**, and **`SEEK`** returns **`node_states_by_asset`**, **`node_states`**, and **`node_states_primary`** (0).

**Target design (remaining)**

1. **Host (done, first cut):** loop **`a` in `0..N-1`** for **`apply_to_asset`**; performance profiling and batching remain possible (profiling TBD).
2. **SEEK (done, first cut):** **`node_states_by_asset`**, top-level **`assets`**. **Optional follow-ups:** `telemetry.symbols` / per-**symbol** labels from CSV header.
3. **Node editor (in progress):** **+ Frame** layout nodes (persisted, non-bridge); freeform **data** nodes / multiple pipelines — **not started**.
4. **SET_PORTFOLIO / GAL:** **risk parity / covariance** and richer joint rules should consume **N×** series explicitly; can live in `otl` or `HostState` — **extends** today’s **proxy** + **`gal_m1`**, not a replacement for the current **multi** heuristics.

---

## 4. Temporal fidelity (bar vs tick, T vs T+1 fill, limit orders)

**Gap:** **SEEK** is **bar**-indexed; “execution at T+1” and **limit** price are not modeled. Slippage today is a **small bps** term in the **proxy** path, not an **order** model.

**Target design (after GAL + multi-asset)**

- **State machine per bar:** **signal time** (e.g. close) vs **fill time** (next bar open) with explicit **prices** from OHLC when CSV is extended to **HLOC** or a second series.
- **Analysis:** add **slippage stats** (realized vs mid, not only `comm_bps` / `slippage_bps` constants) in **`telemetry.analysis`**.
- **Bridge:** no change to **SEEK** line format required initially; new fields in JSON (`fill_bar`, `fill_price`).

**Dependencies:** needs **infrastructure** in (1) and (3) first; otherwise “limit order” is cosmetic.

---

## 5. Event log (weight / trade audit)

**Achieved (v1):** **`telemetry.analysis.trades`** on **`gal_m1`** SEEK — per replay bar **`{ bar, gross_turnover_l1, delta_w[] }`**, capped and consistent with **`run_gal_m1_replay`** cache (**`m_gal_m1_trades_cache`**). Not a classical **entry/exit blotter**; it is **weight-change / turnover** telemetry for QA and Animator-style review.

**UI:** Electron **footer timeline** (**Replay log**) renders the array as a **scrollable spreadsheet** (playhead row highlighted).

**Remaining:** richer semantics **`{ t_entry, t_exit, tag, fees, … }`** when/if the execution model exposes discrete round-trips; optional **mirror** into Analysis **N-panel** beyond timeline.

---

## Recommended implementation order (status)

1. ~~**OSL in host (minimal):** M1, bridge shader path, `telemetry.osl_m1`~~ **Done** — **extended:** **per-asset** **`execute`** in **`gal_m1`** when **N&gt;1**.
2. ~~**GAL + execution clock** (`gal_m1` optional integrator)~~ **Done** — **N-vector** wealth, **weights** on SEEK, **`analysis.trades`** buffer.
3. ~~**Multi-asset bake + `seek_json` + backdrop/metrics/analysis ref column**~~ **Done (v1)** — **multi-asset `close_proxy` portfolio** (`simulate_portfolio_equity_on_closes_multi`) **done** · **covariance / joint optimizer** — **open**.
4. **Execution model** (T+1, limits) and **slippage statistics** — **not started** (lower priority until (3) covariance / joint rules are richer).
5. ~~**Weight-audit events** in **`telemetry.analysis.trades`** + timeline table~~ **Done (v1)** — **N-panel blotter** / **entry–exit blotter** — **optional / not started**.
6. ~~**Performance:** `gal_m1` **`SEEK`** — incremental / same-bar cache~~ — **Done (first cut)** in `run_gal_m1_replay` (`execution_clock.gal_m1_replay_mode`).

---

## References in this repo

| Area | File / symbol |
|------|----------------|
| GAL M2 loop | `OTL-Sandbox/main.cpp` (`begin_bar`, `commit_post_gal`, `rebalance_m2`, …) |
| OSL M1 + `MarketDelegate` | `OTL-Core/main.cpp` · Market Lab: `OslM1Shading.cpp` |
| OSL ↔ universe | `OTL-Core/otl/MarketDelegate.*`, `OtlRenderState` in `OtlUniverse.hpp` |
| Multi-asset closes / bake | `HostState::m_asset_closes`, `host_apply_node_system_to_all_assets`, `set_playhead` |
| Uber JSON / bridge | `HostState::set_uber_signal_json`, `CommandBridge` |
| PORT-CALC (close tail) | `HostState.cpp` — `simulate_portfolio_equity_on_closes`, **`simulate_portfolio_equity_on_closes_multi`**, **`append_portfolio_telemetry`**, `json_array_to_double_vec` / `tail_num` |
| `gal_m1` replay + trades | `run_gal_m1_replay`, **`m_gal_m1_trades_cache`**, `osl_m1_fix_signal_scalar` / `osl_m1_intent_from_per_asset_json` |
| GAL+OSL clock | `docs/EXECUTION_CLOCK.md`, `SET_PORTFOLIO` `integrator` |
| Timeline **Replay log** | `electron/index.html` (`.timeline-dopesheet-*`), `electron/renderer.js` — `renderTimelineTradesSheet` |
| Default Uber JSON | `kDefaultUberConfig` in `HostState.cpp` |

---

## Summary

**Today:** **`otl_marketlab_host`** runs **`gal_m1`** with **per-asset OSL** when **N&gt;1**, **PORT-CALC** **`close_proxy`** can use **aligned multi-asset tails**, **SEEK** exposes **weights**, **`analysis.trades`**, and **Execution** metadata; **Electron** shows a **timeline spreadsheet** for weight deltas. **Next** major gaps: **covariance / joint allocation**, **T+1 / limits**, **optional** **N-panel** / **blotter** UX, and **node-graph**-driven OSL beyond **`m1_alpha`** for all assets.
