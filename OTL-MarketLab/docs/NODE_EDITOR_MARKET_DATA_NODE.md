# Market Lab SRD: Part 1 — Market Data Nodes

## 1. Generic Definition: The "Source" Node

In the Market Lab ecosystem, the Market Data Node is the fundamental **Leaf Node**. It is the only node type that generates data without requiring an input connection. It serves as the bridge between external storage/streams and the internal OTL-Core execution environment.

### 1.1 Global Properties (Generic)

- **Data Integrity:** Must normalize disparate data formats (CSV, Parquet, FIX, SQL) into the internal **OHLCV Bivector** format used by the OSL kernels.
- **Caching Layer:** Implements a local "Tick Cache" to prevent redundant API calls or disk I/O during heavy scrubbing.
- **Symbol Persistence:** The node must serialize its configuration (Ticker, Timeframe, Source) into the `.otl` project file.

### 1.2 Interface Metaphor (Blender "Object Info")

Just as a Blender *Object Info* node points to a 3D Mesh in the database, the Market Data node points to a **Financial Instrument** in the data provider's database.

---

## 2. Specific Implementation: The YFinance Node

The **YFinance Node** is the default input for Market Lab V1, designed for rapid backtesting using the Yahoo Finance API.

### 2.1 Component Logic & Controls

The UI of the node is designed for high-density interaction without needing to open the Sidebar (N-Panel).

- **Ticker Input Field:** A text string field (e.g., "AAPL" or "ES=F") that triggers a validation check against the API upon focus-loss.
- **Temporal Pickers (Start/End):** Dual calendar widgets.
  - *Blender Metaphor:* Similar to setting the "Start" and "End" frames of an animation.
  - *Logic:* Changing these dates invalidates the node’s downstream cache and triggers a re-fetch.
- **Interval Enum:** A dropdown to select bar frequency (`1m`, `5m`, `1h`, `1d`, `1wk`).
- **Status Indicator:** A small LED icon in the node header.
  - *Spinning Blue:* Fetching data via YFinance API.
  - *Steady Green:* Data successfully loaded into the Host memory buffer.
  - *Red:* API Error (e.g., invalid ticker or network timeout).

### 2.2 Data Visualization: The Intermediate State

Following the "Procedural Texture" metaphor, the YFinance node visualizes its state to the network through:

- **Header Value:** Displays the "Current Price" at the playhead's timestamp directly in the node title.
- **Socket Tooltip:** Hovering over the output socket shows a summary: `[OHLCV | 2500 Bars | Float64]`.
- **Node Preview (Mini-Chart):** A small, low-resolution line chart at the bottom of the node body showing the price action for the selected range. This chart updates as you scrub the timeline.

---

## 3. Technical Implementation Details (Host ↔ UI)

### 3.1 The "Option B" Handshake

1. **UI Trigger:** The user enters "BTC-USD" in the Electron UI.
2. **IPC Packet:** The UI sends a `FETCH_YF_DATA {symbol: "BTC-USD", start: ..., end: ...}` command to the C++ Host.
3. **Host Execution:** The C++ Host invokes the YFinance Python wrapper (or native equivalent), downloads the CSV/JSON, and populates the `otl_core` memory buffer.
4. **UI Update:** The Host returns a `DATA_READY` signal with a pointer to the cache. The Electron node header turns Green.

### 3.2 Output Sockets (The "Bridge" Connection)

The YFinance node provides a single **Data Stream** socket (Color: **Lime Green**).

- **Type:** `MarketDataChunk`
- **Contents:** A serialized stream that the **Signal Nodes** will later unpack into `rust::Slice<double const>` for indicator calculation.

---

## 4. Analysis & Telemetry Integration

When the YFinance Node is selected, the **N-Panel (Sidebar)** displays:

- **Data Health:** Missing bar count, gap analysis, and total data points.
- **Adjustments Toggle:** Checkboxes for "Adjust for Splits" and "Adjust for Dividends."
- **Metadata:** Sector, Industry, and Exchange info retrieved during the initial fetch.