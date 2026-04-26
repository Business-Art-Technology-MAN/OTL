# Market Lab SRD: Part 5 — Analysis & Persistence Nodes

## 1. Generic Definition: The "Viewer" Node

The Analysis Node is a non-destructive evaluator. It does not modify the market state or the signal logic; instead, it observes the `m_weight` and `m_close` series to derive performance statistics. In our Blender metaphor, this is the **Viewer Node** that drives the Backdrop and the **Composite Output** node that saves the final "render" (data).

### 1.1 Global Properties (Generic)

- **Sampling Rate:** Operates on the full series provided by the upstream Portfolio Node.
- **Non-Reactive:** While Signal nodes are per-tick, Analysis nodes are "Series-Aware"—they require the full lookback buffer to calculate metrics like Drawdown or CAGR.
- **Multi-Format Export:** Supports flattening the complex `OtlUniverse` state into standard tabular formats (CSV, Parquet).

---

## 2. Specific Implementation: The "Performance Viewer"

This node provides the primary visual and statistical feedback for any backtest or live monitoring session.

### 2.1 Component Logic: The Analytics Engine

The node automatically calculates the "Common Suite" of financial metrics whenever the upstream data changes.

- **Wealth Growth (Cumulative Return):** Calculated as $W_t = W_{t-1} \times (1 + r_t)$, where $r_t$ is the weighted return of the asset at time $t$.
- **Drawdown Analysis:** Tracks the percentage drop from the historical "High Water Mark" of the wealth curve.
- **Risk Metrics:**
  - **Sharpe Ratio:** (Mean Excess Return / StdDev of Returns).
  - **Sortino Ratio:** Focuses on downside deviation only.
  - **Profit Factor:** Gross Gains / Gross Losses.
- **Trade Statistics:** Win rate, average trade duration, and expectancy.

### 2.2 UI/UX: Visualization & Interaction

- **The Wealth Growth Graph (Backdrop):**
  - When selected, the Node Editor background displays a high-performance **Log-Scale Line Chart**.
  - **Baseline Comparison:** A secondary grey line shows the "Buy & Hold" benchmark (raw price growth).
- **The N-Panel (Sidebar) Dashboard:**
  - Displays a "Financial Summary" table with bold headers for key metrics (CAGR, Max DD, Sharpe).
  - Includes a **"Save to CSV"** button with a file-path picker.

---

## 3. Data Persistence: CSV Export Specification

The "Save to CSV" functionality flattens the multidimensional OTL state into a portable format.

### 3.1 CSV Column Mapping

The exported file must include the following headers to allow for external audit in Excel or R:

1. **Timestamp:** ISO-8601 Wall-clock time.
2. **Price:** The `m_close` value at that tick.
3. **Signal:** The raw OSL/OTL signal value (e.g., `m_rsi_14`).
4. **Weight:** The target leverage/allocation (`m_weight`).
5. **Daily_Return:** The percentage change for that period.
6. **Cumulative_Wealth:** The growth of a $1.00 unit.
7. **Drawdown:** The current % decline from peak.

---

## 4. Technical Integration (Host ↔ UI)


|               |                  |                                                                                                                                       |
| ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**        | **Requirement**  | **Market Lab Implementation**                                                                                                         |
| **ANLY-CALC** | Series Reduction | The C++ Host performs the heavy lifting (CAGR/Sharpe) and sends a single "Summary JSON" to Electron.                                  |
| **ANLY-CSV**  | Headless Export  | Clicking "Save" in the UI sends a `EXPORT_CSV <path>` command. The Host writes the file directly to disk for speed (`SIG-HOST-JSON`). |
| **ANLY-VIS**  | Responsive Scrub | As the playhead moves, the Analysis Node highlights the current "Data Row" in the CSV export preview.                                 |


---

## 5. Visualizing the Terminal State

In the Node Editor, your graph will now reach its "Conclusion":

1. **Market Data (YFinance)** $\rightarrow$ **Uber Signal (VectorTA)** $\rightarrow$ **Portfolio (Aggregator)** $\rightarrow$ **Analysis (Viewer)**.
2. The user sees the Price (Market Data), the RSI (Signal), the Allocation (Portfolio), and the final Wealth Curve (Analysis) all stacked in a cohesive, Blender-inspired spatial layout.

