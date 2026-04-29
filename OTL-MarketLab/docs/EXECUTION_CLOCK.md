# Execution clock (host precedence)

The Market Lab C++ host follows a **fixed order** so OSL, VectorTA, and the portfolio (GAL) do not read the wrong bar or “hallucinate” `m_prev_weight` / PnL.

Each **bar** in a **`gal_m1` replay** (`bars 0..playhead`) runs the **inner** sequence below. **`close_proxy`** does **not** replay this loop for portfolio state; it only uses VectorTA + synthetic PORT-CALC on tails (see **Integrator**).

| Step | Name | What runs |
|------|------|------------|
| 1 | **VectorTA bake** | Before replay: `OtlNodeSystem::apply_to_asset` is run **for every asset** loaded from the close matrix; each `m_attr` **series** covers the full CSV; point reads use the current `OtlUniverse` bar. |
| 2 | **SEEK / `seek_set_bar`** | `OtlUniverse::set_bar(t)` (replay index **t**). |
| 3 | **`begin_bar`** (GAL path) | `OtlUniverse::begin_bar` — copies **current** book to **`m_osl_prev_portfolio`**, so OSL’s exposure to prior weights is **GAL from the previous bar** (or zero at bar 0). |
| 4 | **OSL M1 `execute`** | **`gal_m1`:** **`OslM1Shading::execute(u, a, …)`** once **per asset** **`a = 0..N-1`** when **N > 1** (same **`m1_alpha.oso`**, distinct **`OtlRenderState::asset_id`**). When **N == 1**, a **single** **`execute(u, 0, …)`**. **MarketDelegate** serves `fetch_m` / `getattribute` at **(asset, m_bar)**. **`close_proxy` SEEK** (no replay): one **`execute(u, 0)`** for **`telemetry.osl_m1`** only — **not** coupled to GAL book updates. |
| 5 | **Intent + GAL + replay row** | Map each asset’s M1 JSON to a **full intent 1-vector** (**`osl_m1_intent_from_per_asset_json`** when **N > 1**, else **`osl_m1_intent_from_json`** on asset **0** only); **`rebalance_m2`** (or 1-asset blend); **`commit_post_gal(w)`**; append one weight sample **`{ bar, gross_turnover_l1, delta_w[] }`** to **`m_gal_m1_trades_cache`** (**`analysis.trades`** on SEEK mirrors this buffer). |

After a **successful `gal_m1` replay**, **`telemetry.osl_m1`** carries the **playhead** OSL bundle (merged **`per_asset`** + compat **`fix_signal`** from asset **0** — **not** a second **`execute`** unless replay failed and the host fell back to **`set_playhead`** only). **`telemetry.portfolio`** fills **`equity_tail_gal`**, **`stats`**, **`current_weights`**, **`osl_prev_weight`**.

## `integrator` in `SET_PORTFOLIO` JSON

- **`"close_proxy"`** (default) — `telemetry.portfolio` uses **`append_portfolio_telemetry`** on aligned **close tails**. When **N > 1**, **`simulate_portfolio_equity_on_closes_multi`** can build **EW / risk / strength** proxy curves across assets (no GAL bar walk); **`telemetry.portfolio.stats`** may include **`close_proxy_multi_asset`**. One M1 **`execute(u, 0)`** may run for **`telemetry.osl_m1`** at the playhead; **`m_prev_weight`** is **not** advanced by **`gal_m1`** unless you switch **`integrator`**.

- **`"gal_m1"`** — On each **`SEEK`**, the host replays **`0..b`** (**steps 2–5** each bar **t**, with step 1 satisfied by the bake **before** the loop). Per-bar equity uses **`gal_m1_portfolio_return_for_step`**: **opening** portfolio weights for bar **t** (post-**`commit_post_gal`** from **t−1**) times each asset’s simple return **t−1 → t**. **`telemetry.portfolio`** carries **`equity_tail_gal`**, **`current_weights`**, **`osl_prev_weight`**. **`telemetry.analysis.trades`** is the capped **weight-event** history (**FIFO** overflow trim); **`m_gal_m1_*`** cache fields match **full** \| **forward** \| **cached_same_bar** replay modes.

Optional **`m2`** object: `alpha`, `beta`, `biv_lambda`, `degrees`, `i_rot`, `j_rot`, `cash_friction` (see **`GaPortfolioIntegrator`** and **`OTL-Sandbox`** M2 flags).

### `seek_json` · `execution_clock`

Object fields (non-exhaustive): **`integrator`**, **`bar`**, **`note`**, **`ordered_steps`** (below), **`gal_m1_replay_ok`** / **`gal_m1_replay_mode`** / **`replay_bars`** / **`error`** when **`integrator`** is **`gal_m1`**.

**`ordered_steps`** — Fixed-length array (**same ordering** on every SEEK). Tokens map to the precedence table (*VectorTA bake* is implicit before each replay or playhead finalize; **`gal_commit`** aggregates intent extraction, **`rebalance_m2`**, **`commit_post_gal`**, and the **replay weight sample** appended to **`m_gal_m1_trades_cache`** inside **`gal_m1`** replay):

| # | Token | Document step |
|--:|-------|----------------|
| 1 | `vector_ta_bake` | VectorTA bake |
| 2 | `seek_set_bar` | SEEK / `seek_set_bar` |
| 3 | `begin_bar` | `begin_bar` (GAL path) |
| 4 | `osl_m1_execute` | OSL M1 `execute` (**N** passes when **N > 1** in **`gal_m1`** replay; one pass for **`close_proxy`** OSL telemetry) |
| 5 | `gal_commit` | Intent + GAL + replay weight row (**`gal_m1`** replay only — **book** untouched under **`close_proxy`**; see **`note`**) |

**Schema:** **`ordered_steps`** always has exactly **five** strings. **`execution_clock.note`** disambiguates which steps apply (**`gal_m1`**: **`run_gal_m1_replay`** runs **tokens 2–5** for each replay bar **`t`** **after** **token 1** has baked indicators; **`close_proxy`**: no GAL bar loop — **`telemetry.osl_m1`** still uses **`osl_m1_execute`** at the playhead; **`gal_commit`** is **not** applied to **`OtlUniverse`** portfolio state).

## Multi-asset payloads (same `SEEK`)

- **`asset_labels`**: CSV header names for each universe column (or `Asset k`).
- **`per_asset_telemetry`**: array length **N** — each entry has **`close_tail`**, scalar **`m_close`**, and **`shadow_overlay`** `{ m_attr, tail }` where applicable.
- **`SET_PORTFOLIO`** **`analysis_asset_index`**: **`telemetry.analysis`** (wealth / buy-hold tails / CSV-style preview / summary) for **`close_proxy`** is keyed off that asset; **`append_portfolio_telemetry`** may still derive **multi-asset proxy** **`equity_tail`** when **N > 1** as above.

**`gal_m1` (+ successful replay):** **`telemetry.analysis.trades`** — JSON array aligned with **`HostState`** **`m_gal_m1_trades_cache`**. See **`STRATEGY_READINESS_ROADMAP.md`** §5. Electron footer **Replay log** consumes this array.

## Cost note

**`gal_m1`:** **forward** / **same-bar** incremental replay when path + playhead allow (**`m_gal_m1_cache_key`**, **`m_gal_m1_end_bar`**, **`m_gal_m1_eq_cache`**, **`m_gal_m1_trades_cache`**). Worst-case work per SEEK is **O(b·N)** **`OslM1Shading::execute`** calls (**b** bars × **N** assets when **N > 1**) plus **`rebalance_m2`** each bar. Large **b·N** may warrant batching or caching later.
