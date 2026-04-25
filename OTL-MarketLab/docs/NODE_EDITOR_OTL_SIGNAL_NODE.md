# Market Lab SRD: Part 2 — Signal Nodes & The Uber Shader

## 1. Generic Definition: The "Signal" Node

Signal Nodes are the logic processors of the Market Lab. Unlike Market Data nodes (which produce raw OHLCV), Signal Nodes consume data streams to produce **m_*** (market attributes) or **FixSignals** (trading triggers).

### 1.1 Global Properties (Generic)

- **Execution Semantic:** Every node must map to an `otl::OtlUniverse` state. When the playhead moves (`SIG-BAR`), the node updates its output based on `try_get_m` for the current bar.
- **ABI Contract:** All signal outputs are registered as `float` scalars in the `MarketDelegate` to ensure OSL compatibility (`SIG-OSL-FLOAT`).
- **Visual Metaphor:** Similar to Blender’s **Shader Nodes**. The node calculates a "value" for the current point in time, just as a shader calculates a color for a point in space.

---

## 2. Specific Implementation: The "Uber" Technical Node

The **Uber Technical Node** is a specialized, multi-output node that exposes the entire **VectorTA** suite to the graph. Instead of 50 separate nodes for 50 indicators, this node provides a single "source of truth" for technical analysis.

### 2.1 Component Logic & Controls

- **Indicator Selection (Multi-Toggle):** A list of checkboxes in the node body to enable/disable specific indicators (RSI, SMA, MACD, Bollinger Bands).
  - *Efficiency:* Only enabled indicators are "baked" into the `OtlUniverse` and registered via `register_m_attribute` (`SIG-OSL-REG`).
- **Parameter Sliders:** Dynamic input fields for indicator periods (e.g., "RSI Period: 14").
- **Execution Path:** 1. The node calls `otl::bake_series` (via the Rust bridge) for all enabled indicators.
  1. It populates the `OtlUniverse` with the resulting series.
  2. It registers the names (e.g., `m_rsi_14`) with the `MarketDelegate`.

### 2.2 Input/Output Sockets

- **Input (Lime Green):** `MarketDataChunk` — Receives OHLCV data from a Market Data Node.
- **Output (Grey/Float):** Individual sockets for each enabled indicator (e.g., `m_close`, `m_rsi`).
- **Output (Purple/Signal):** A specialized **OTL Closure** socket that carries the full "Technical State" to downstream Portfolio Nodes.

---

## 3. OSL Integration: The "Scripted" Signal

While the Uber Node provides pre-baked indicators, the **OSL Script Node** allows for custom "Alpha" logic using the **MarketDelegate**.

### 3.1 The "Uber" OSL Shader Context

When a user writes an OSL script in the Market Lab tabbed editor:

- **The Bridge:** The `MarketDelegate` maps OSL `getattribute("m_rsi", val)` calls directly to the `OtlUniverse::try_get_m` lookup provided by the Uber Node.
- **RenderState Handling:** The Market Lab host automatically manages the `OtlRenderState` to ensure the shader sees the correct `asset_id` and `universe` pointer for the current calculation (`SIG-ASSET`).

### 3.2 Visualizing Intermediate States (Blender Metaphor)

- **Socket Inspection:** Hovering over the `m_rsi` output on the Uber Node shows the current value (e.g., `68.5`) at the playhead's position.
- **The "Backdrop" Preview:** If the Uber Node is selected, a "Shadow Trace" of the primary indicator (e.g., the SMA) is overlaid on the main Price Chart in the backdrop.

---

## 4. Technical Traceability (Bridge to OTL-Core)


|                 |                        |                                                                                                                         |
| --------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **ID**          | **Requirement**        | **Market Lab Implementation**                                                                                           |
| **SIG-UNI**     | Port to `m`_* Mapping  | Every Uber Node socket is bound to a `ustring` in the `MarketDelegate`.                                                 |
| **SIG-BAR**     | Time-Index Sync        | Moving the Electron Scrubber calls `HostState::set_playhead`, updating the node's local display values.                 |
| **SIG-OSL-REG** | Attribute Registration | Adding an indicator to the Uber Node automatically calls `register_m_attribute` in the C++ host.                        |
| **ARCH**        | Isolation              | The UI represents the graph as JSON; the C++ host instantiates the actual `OtlNodeSystem` to perform the heavy lifting. |


---

## 5. Basic Analytic Node Preview (V1)

Following the Signal Nodes, the graph terminates in **Analysis Nodes** which consume these `m_`* values:

- **Signal Visualizer:** A "Viewer" node that plots the `m_rsi` or `m_macd` in a separate sub-window, identical to Blender's "Split View" compositor logic.
- **Performance Table:** Consumes the `FixSignal` closure to calculate real-time CAGR and Win Rate in the Sidebar (N-Panel).

