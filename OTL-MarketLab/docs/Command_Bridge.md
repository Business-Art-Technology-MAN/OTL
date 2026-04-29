# Command Bridge (Market Lab v1)

Lightweight, line-based protocol between the **Electron** front end and the **otl\_marketlab\_host** (C++). No gRPC in V1.

## Transport

| OS | Transport | Default path |
|----|------------|--------------|
| Windows | **Named pipe** (byte stream) | `\\.\pipe\OTL_MarketLab_CommBridge` (see `kDefaultPipeName` in `host/include/mlab/BridgeConstants.h`) |
| Linux / macOS | **Unix domain socket** (AF\_UNIX, SOCK\_STREAM) | `/tmp/OTL_MarketLab_CommBridge.sock` (override with env `MARKET_LAB_SOCKET` in future) |

**Electron** uses `net.createConnection` with the same path (see `electron/bridgeConfig.cjs`).

**Lifecycle:** the host process creates the server and blocks until **one** client (the Electron `net` client) connects. The UI should connect on launch. Sending `QUIT` ends the host loop for that connection.

## Framing

- **UTF-8** text, one **command per line** terminated by `\n` (LF).  
- **Responses** are one line per reply, terminated by `\n`.  
- Prefix: **`OK `** = success, JSON payload may follow. **`ERR `** = failure, JSON with `error` field.

## Commands (UI → host)

| Line | Meaning |
|------|---------|
| `PING` | Liveness; response documents bridge version. |
| `LOAD_DATA <path>` | Absolute or repo-relative path to Yahoo-style CSV (same shape as `scripts/fetch_market_data.py` / `MarketDataCsv`). Host loads universe + boots default `OtlNodeSystem` (RSI on `m_close` in V1). Response JSON includes **`asset_labels`**: trimmed CSV header cells for each close column (fallback `Asset k`). Includes **`timeline_axis`**: `{ "bars": <int>, "ticks": [ { "bar": <int>, "wall": "<timestamp string from CSV>" }, … ] }` so the Electron footer can render a **dual-scale** wall-clock overview + scrub band (MarketLab_SRD §6.3). |
| `SEEK <time>` | Wall-clock navigation. `<time>` can be: bar index, ISO date `YYYY-MM-DD` prefix, or a full timestamp string; host maps to a bar, updates playhead, returns telemetry JSON (close tail, `m_rsi`, bridge heartbeat). JSON includes **`assets`**, **`asset_labels`**, **`node_states_by_asset`**, **`node_states`** / **`node_states_primary`** (0), **`per_asset_telemetry`** (per column: **`close_tail`**, **`shadow_overlay`**, **`m_close`**), and **`execution_clock`**; see `docs/EXECUTION_CLOCK.md` for **`gal_m1`**. |
| `SET_UBER_SIGNAL <json>` | Reconfigure UBER (nodes / wiring) from JSON; use a follow-up `SEEK` to refresh `node_states` and telemetry. The top-level object may include **`lab`**, a UI-only block stripped before the host feeds `OtlNodeSystem` — e.g. **`lab.primary_overlay`** (backdrop) and optional **`lab.osl_shader_dir`** (absolute or repo-relative path to a folder containing `m1_alpha.oso`; see OSL below). |
| `SET_PORTFOLIO <json>` | Host-side portfolio config (allocations, costs, rebalancing, etc.); on success, issue `SEEK` to refresh `telemetry.portfolio` in `seek` responses. Optional **`"integrator": "close_proxy" \| "gal_m1"`** (default: `close_proxy`). Optional integer **`analysis_asset_index`** (0…N−1 when **N>1**): which asset’s **close** and **signal** series feed **`telemetry.analysis`** (wealth, buy&hold, preview) and **`EXPORT_CSV`** for **`close_proxy`** runs; defaults to **0**. **`gal_m1`** runs **`run_gal_m1_replay`** (bar **`0`**… **`SEEK` bar**) following **`execution_clock.ordered_steps`**: **`vector_ta_bake`**, **`seek_set_bar`**, **`begin_bar`**, **`osl_m1_execute`**, **`gal_commit`** — see **`docs/EXECUTION_CLOCK.md`** (**`telemetry.execution_clock`** in **`SEEK` JSON**, including **`gal_m1_replay_mode`**). |
| `EXPORT_CSV <json>` | Analysis export (ANLY-CSV). JSON must include `"path"`: the absolute path to create/overwrite. Host writes `Timestamp,Price,Signal,Weight,Daily_Return,Cumulative_Wealth,Drawdown` (see `HostState::export_analysis_csv`). If JSON parse fails, the rest of the line is treated as a raw path (no spaces, or use JSON). |
| `QUIT` | Graceful end of client session. |

## Example

```
PING
OK {"event":"PING","bridge":"CommandBridge v1"}
LOAD_DATA C:\data\project\OTL_Data\universe_close_matrix.csv
OK {"ok":true,"path":"...","bars":100,"timeline_axis":{"bars":100,"ticks":[{"bar":0,"wall":"..."},...]},...}
SEEK 2024-01-15
OK {"bar":42,"node_states":{...},"telemetry":{...}}
QUIT
OK {"event":"QUIT"}
```

## Heartbeat and VectorTA

`load_data_json` / `seek_json` include `bridge_heartbeat` with `host`, `vector_ta`, and `cxx` for the NASA panel’s pre-attentive status colors.

## OSL (optional M1)

The host resolves a shader **search path** in this order: non-empty **`lab.osl_shader_dir`** from the last `SET_UBER` JSON, else environment **`OTL_SHADER_DIR`**. The chosen directory should contain **`m1_alpha.oso`**. On each **`SEEK`**, **`telemetry.osl_m1`** may include `executed`, `init_ok`, `shader_dir`, optional **`shader_dir_source`** (`"lab"` or `"env"`), and `fix_signal` (side, quantity, price) from the M1 OSL path (`ShadingSystem` + `MarketDelegate`, same as `OTL_Engine`). If neither path is set or the shader is missing, `telemetry.osl_m1.enabled` is false with a short hint. **`LOAD_DATA`** JSON includes optional **`osl_m1_shader_path`** and **`osl_m1_shader_path_source`** echoing the same resolution.

## Versioning

Increment the bridge string in responses when adding breaking commands. Document new verbs here.
