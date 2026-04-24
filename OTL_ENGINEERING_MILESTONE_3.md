# OTL Project Specification: Milestone 3

**Phase:** The Laboratory Environment (Data, Nodes, & Analytics)

**Goal:** Implement real-world data ingest, a directed acyclic graph (DAG) for strategy assembly, and an econometric reporting layer.

## 1. The Data Ingestor (Yahoo Finance Bridge)

We replace `SyntheticUniverse` with real-world time series.

- **Mechanism:** A Python or C++ utility to fetch OHLCV data via the Yahoo Finance API (using `yfinance` or a direct REST client).
- **Storage:** Data is cached as `.parquet` or `.csv` in `OTL_Data/` to ensure the C++ `OtlUniverse` can load the manifold quickly without hitting API rate limits.
- **Standardization:** All tickers must be reindexed to a common timeline (handling holidays and missing bars) to maintain the integrity of the $\mathcal{Cl}_{n}$ space.

## 2. The Node-Based Strategy Tree

Rather than hard-coding one OSL shader, we move to a **Node Tree** architecture. This allows you to "wire together" different signals.

- **Nodes:**
  - **Source Nodes:** Raw Price/Volume.
  - **Indicator Nodes:** VectorTA-backed (RSI, MACD, etc.).
  - **Logic Nodes:** OSL-based "Alpha" shaders.
  - **Geometric Nodes:** GAL-based Risk/Momentum filters.
- **Execution:** The Lab assembles these nodes into a execution plan that the `MarketDelegate` processes bar-by-bar.

## 3. Econometrics & Visualization

The output of the backtest must move beyond console logs into professional analytics.

- **Charts:** Time-series of Equity Curve, Drawdown, and Portfolio Weights (visualized as a heatmap of the $N$ assets).
- **Metrics:** * **Sharpe/Sortino Ratios:** Risk-adjusted returns.
  - **Geometric Efficiency:** How much of the portfolio rotation was "wasted" (orthogonality of intent vs. actual trade).
  - **Turnover:** The L1-norm of the rebalancing rotors over time.

---

## 4. Implementation Workflow: Milestone 3

### Step A: The Ingestor (`otl_ingest`)

Claude will create a utility to pull $N$ tickers and save them into a binary format that `OtlUniverse` can "mmap" (memory map) for high-speed backtesting.

### Step B: The Results Schema (`OtlAnalytics`)

Implement a C++ class that captures every trade, every rotor rotation, and the resulting PnL. This class will export a `.json` or `.csv` designed for a frontend (or a simple Python/Matplotlib script) to plot.

### Step C: The Sandbox to Lab Transition

Update `OTL_Sandbox` to become `OTL_Lab`. It will take a `--config` file (defining the node tree) and a `--data` directory, then run the full historical simulation.