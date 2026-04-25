This **Market Lab SRD V2.5** is specifically designed to bridge the gap between your verified C++ logic and a high-performance Electron interface using the **Blender Node Editor** as the functional blueprint.

---

# Market Lab: Node Editor Software Requirements Document (V1.0)

**Project Architecture:** Option B (Electron UI $\leftrightarrow$ Headless C++ Host)

**UX Paradigm:** Blender-Style Node Logic

[https://docs.blender.org/manual/en/latest/interface/controls/nodes/index.html](https://docs.blender.org/manual/en/latest/interface/controls/nodes/index.html)

## 1. The Core UI Metaphor: The Integrated Workspace

The interface is divided into three primary zones, mirroring the Blender 3D workflow to manage the "Market Data to Analytics" pipeline.

- **The Node Editor (Center):** The spatial logic builder where data flow is constructed.
- **The Sidebar (N-Panel):** Context-sensitive property editing and high-density telemetry.
- **The Spreadsheet/Timeline (Bottom):** A unified temporal control for scrubbing Yahoo CSV datasets.

## 2. Functional Node Classifications

To map your C++ `OtlNodeSystem` to the UI, we categorize all nodes into four distinct types. Each type has a unique visual header color and behavior.

### 2.1 Market Data Nodes (The "Inputs")

- **Purpose:** Ingest and normalize financial instruments from CSV or memory buffers.
- **Metaphor:** Similar to Blender’s *Object Info* or *Attribute* nodes.
- **UI Features:** A "Search" dropdown for ticker selection and an Enum for timeframe (1m, 5m, Daily).
- **Outputs:** A "Data Stream" socket (Green) containing OHLCV bivectors.

### 2.2 Signal Nodes (The "Processing")

- **Purpose:** Execute OSL/OTL kernels to generate signals (RSI, Regimes, GA-based Rotors).
- **Metaphor:** Blender’s *Shader Nodes* or *Script Nodes*.
- **UI Features:** A direct "Edit Script" button that opens the integrated **Monaco Editor** tab.
- **Inputs/Outputs:** Floating-point (Grey) and Multi-dimensional Vector/Matrix (Cyan/Purple) sockets.

### 2.3 Portfolio Nodes (The "Composition")

- **Purpose:** Aggregating multiple signals into a single strategy with risk-parity or equal-weighting.
- **Metaphor:** Blender’s *Compositor Nodes* (Mix/Overlay logic).
- **UI Features:** Multi-input sockets that allow the user to "stack" signals. Internal sliders for leverage and tilt.

### 2.4 Analysis Nodes (The "Viewers")

- **Purpose:** Final data transformation into econometrics and performance metrics.
- **Metaphor:** Blender’s *Viewer* and *Composite Output* nodes.
- **Visualizations:** When selected, these nodes populate the **N-Panel** with specific telemetry.

---

## 3. Basic Analytic & Visualization Set

Market Lab must support these specific Analysis Nodes in V1 to validate the `OtlM3Node` outputs.


|                    |                        |                                                 |
| ------------------ | ---------------------- | ----------------------------------------------- |
| **Node Name**      | **Visualization Type** | **Metric Outputs**                              |
| **Equity Curve**   | Line Chart (Backdrop)  | Growth of $1.00 vs. Benchmark.                  |
| **Drawdown**       | Filled Area Chart      | Peak-to-trough decline over time.               |
| **Metric Table**   | High-Density Grid      | Sharpe, Sortino, CAGR, and Win Rate.            |
| **Signal Heatmap** | Matrix Visualization   | Frequency and intensity of OSL kernel triggers. |


---

## 4. UX Patterns: The "Blender Style" Workflow

To ensure the codebase maps to these workflows, the following interface patterns are mandatory:

### 4.1 Node Property Sidebar (The N-Panel)

In Blender, pressing 'N' opens a sidebar. In Market Lab, this panel is the **Primary Telemetry Hub**.

- If a **Signal Node** is selected, the N-Panel shows the OSL parameters and a "Mini-Curve" of the current signal.
- If an **Analysis Node** is selected, it shows the full econometric table.

### 4.2 Progressive Disclosure (Socket Logic)

- Nodes do not show all OTL parameters by default.
- Users must click a "Diamond" icon next to a parameter in the Sidebar to "drive" that value with a node connection (identical to Blender's Geometry Nodes).

### 4.3 The "Backdrop" Preview

The Node Editor background acts as a live canvas. When a **Viewer Node** is active, a faded but readable Equity Curve or Heatmap is rendered *behind* the nodes, providing immediate visual feedback during logic tweaks.

---

## 5. Technical Connectivity (For Claude)

- **Transport:** The Electron UI sends a JSON payload to the C++ Host describing the node tree topology.
- **Evaluation:** The Host executes the OSL kernels and returns a binary stream of result buffers (via `rust::Slice` patterns).
- **Scrubbing:** When the UI Scrub-Bar moves, the UI sends a `GOTO_TIMESTAMP` command. The Host responds by updating the "Active Value" displays on every node socket.

---

## 6. Visual Style

- **Color Palette:** Dark-Grey (`#1E1E1E`), Node Headers (Dynamic by type), Wires (Color-coded by data type).
- **Font:** JetBrains Mono for all numeric values and code blocks.
- **Spacing:** High-density with minimal padding to maximize information on a single screen.

