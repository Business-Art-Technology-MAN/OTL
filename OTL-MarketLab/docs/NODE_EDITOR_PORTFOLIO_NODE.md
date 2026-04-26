# Market Lab SRD: Part 4 — Portfolio & Compositor Nodes

## 1. Generic Definition: The "Aggregator" Node

The Portfolio Node is the terminal logic processor in the "Execution" stack. Its job is to take one or more Signal streams and apply **Money Management** rules to generate a single "Target Exposure" or "Weight" for the instrument.

### 1.1 Global Properties (Generic)

- **Capital Awareness:** Maintains state for starting equity, current margin, and cumulative PnL.
- **Execution Logic:** Converts `m_`* attributes into `m_weight` (the percentage of capital allocated to the asset).
- **Feedback Loop:** In an M2/GAL context, it can look back at `m_prev_weight` to calculate transaction costs and slippage.

---

## 2. Specific Implementation: The "Multi-Signal Compositor"

This node acts as the **Mix Shader** of the financial stack, blending different technical signals into a unified position.

### 2.1 Component Logic & Controls

- **Allocation Method (Enum):** A dropdown to select the weighting logic:
  - *Equal Weight:* All active signals share the target leverage equally.
  - *Signal Strength:* Leverage is scaled by the raw value of the input (e.g., higher RSI = higher weight).
  - *Risk Parity:* Scaling based on the inverse of the asset's volatility (baked via `VectorTA`).
- **Leverage Slider:** A global multiplier (e.g., `1.0x` to `5.0x`) applied to the final output.
- **Cost Controls:** Input fields for **Commission per trade** and **Slippage (bps)** to ensure the backtest is realistic.

### 2.2 Input/Output Sockets

- **Input (Grey/Float):** Multiple "Signal" sockets (e.g., RSI, SMA) connected from the Uber Node.
- **Output (Purple/Closure):** The **Portfolio Closure**—a complex object containing the trade history and equity curve data.
- **Output (Green/Data):** A feed for **Analysis Nodes** to consume the PnL series.

---

## 3. UI/UX: The "Backdrop" Result

Following the Blender Compositor metaphor, the Portfolio Node is usually the node "connected" to the Viewer.

- **The Backdrop Preview:** When the Portfolio Node is selected, the **Backdrop** of the entire node editor transforms. It displays the **Equity Curve** (Wealth Growth) as a primary line, with **Drawdown** shaded in red underneath.
- **The "N-Panel" Statistics:** Selecting this node populates the Sidebar with the definitive performance summary:
  - Total Return (%)
  - Max Drawdown (%)
  - Sharpe / Sortino Ratios
  - Profit Factor

---

## 4. Technical Integration (Host ↔ UI)


|               |                   |                                                                                                                    |
| ------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| **ID**        | **Requirement**   | **Market Lab Implementation**                                                                                      |
| **PORT-CALC** | PnL Integrity     | The Host calculates PnL in C++ using the `OtlUniverse` state to ensure high-performance scrubbing.                 |
| **PORT-SYNC** | Playhead Context  | As the Electron Scrubber moves, the Portfolio Node displays the "Unrealized PnL" for that specific moment in time. |
| **PORT-COST** | Friction Modeling | Slippage and commissions are applied at the `commit_post_gal` stage in the Host.                                   |


---

### **Visualizing the Connection**

In the UI, you would see a wire from the **Uber Node's** `m_sma_20` socket plugging into the **Portfolio Node's** `Signal 1` socket. A second wire from `m_rsi_14` plugs into `Signal 2`. The Portfolio Node then "Composites" these into the final wealth curve you see in the background.