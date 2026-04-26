# Market Lab (UI / UX)

**Market Lab** is the *look-development-style* experience for **authoring and inspecting trading portfolios**—a single place to bring data ingest, analytics, and strategy assembly together for users, analogous to how technical directors use look development tools for imagery.

## Placement in OTL_Suite

- This tree lives at `**OTL-MarketLab/`** in the `OTL_Suite` repository.
- Implementation (front end, local services, bundling) is developed **here**, not under `OTL-Core/`, `3rdparty/`, or the existing engine targets.

## Dependency rule (one direction only)


| Direction                                                                                                    | Allowed                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **Market Lab →** OTL_Suite (engine, CLIs, data paths, `OTL_Data/`, shared scripts, documented APIs)          | **Yes** — Market Lab **consumes** these.                                                                                          |
| **← Market Lab** (anything in `OTL-MarketLab/`) from engine / `otl_core` / VectorTA / OSL / GAL / submodules | **No** — those projects must **not** add dependencies on Market Lab, imports from this directory, or build steps that require it. |


So: **Market Lab is an optional “cap”** on the stack. The core can be built, tested, and shipped without this folder.

## Requirements

- **SRD (ratified for implementation):** `docs/MarketLab_SRD.md` (V2.5) — Electron, **Command Bridge** (named pipe / UDS), full MVP, CSV+wall clock, interactive graph, OTL/.otl, cross-platform, monorepo build without reverse dependencies.

## Run (dev)

1. Build `otl_marketlab_host` from the suite (e.g. `OTL_BUILD_MARKET_LAB=ON`) and start it so the bridge server is listening.
2. (Optional) **OSL M1:** set **`OTL_SHADER_DIR`** to a folder containing **`m1_alpha.oso`** (compile `OTL-Core/shaders/m1_alpha.osl` with `oslc`) so each **`SEEK` returns `telemetry.osl_m1`** (see `docs/Command_Bridge.md` and `docs/STRATEGY_READINESS_ROADMAP.md`).
3. In `electron/`, run `npm install` if needed, then `npm start`. The UI connects to the same bridge path as the host (see `bridgeConfig.cjs` and `docs/Command_Bridge.md`).

## Status

- **Electron** shell: `electron/` (NASA telemetry stub, DCC graph placeholder, Canvas timeline placeholder) wired to `PING` / `LOAD_DATA` / `SEEK` via the bridge. **SRD V2.5** is the current contract.
- **Strategy-readiness (GAL, OSL, multi-asset, execution):** the gap analysis and **phased roadmap** is in **`docs/STRATEGY_READINESS_ROADMAP.md`**. **OSL M1** (`ShadingSystem` + `m1_alpha.oso` when `OTL_SHADER_DIR` is set) is wired in the host; **closed-loop GAL** and **Uber JSON → custom `.oso` path** are still future work; that document is the working backlog.