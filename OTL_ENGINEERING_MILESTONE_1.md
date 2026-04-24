# OTL Project Specification: Milestone 1

**Domain:** High-Performance Quant Manifold ($\ge 50$ Assets)

**Stack:** C++20, Rust (VectorTA), OSL (Alpha Logic), GAL (Clifford Algebra $\mathcal{Cl}_{n}$)

## 1. Architectural Philosophy

Open Trading Language (OTL) treats the market as a **Manifold** where:

- **MarketDelegate** is the Orchestrator (Implementation of `OSL::RendererServices`).
- **VectorTA** is the Data Baker (Texture Engine for indicators).
- **OSL Shaders** are the Alpha Logic (Stateless Materials).
- **GAL** is the Risk/Portfolio Resolver (High-dimensional Geometric Algebra).

## 2. Infrastructure & Environment

- **Root Directory:** `C:\Users\joeff\OTL_Suite`
- **Submodules:**
  - `3rdparty/osl`: Custom Windows-patched fork.
  - `3rdparty/VectorTA`: Rust `staticlib` for CUDA/SIMD indicators.
  - `3rdparty/gal`: Header-only C++20 Geometric Algebra library.
- **Build System:** CMake Superbuild.
  - Links: `oslexec`, `VectorTA_rust` (Corrosion alias), and GAL headers.
  - Flags: MSVC `/arch:AVX2` (or `/arch:AVX512`) and `/fp:fast`.

## 3. Component Interface Mandates

### A. The MarketDelegate (C++)

This class inherits from `OSL::RendererServices`. It is the "bridge" between time-series data and the shading runtime.

- **Requirement:** Implement `get_userdata` to resolve attributes prefixed with `m`_ (e.g., `m_rsi`, `m_close`).
- **Data Flow:** Use the `cxx` bridge to fetch pre-calculated `f64` buffers from the `VectorTA_rust` static library and provide them to OSL as `float` attributes.
- **Scale:** Must handle a variable universe ($N \ge 50$) by managing the `ShadingSystem` and `PerThreadContext` to execute shaders across the entire manifold in a single parallel pass.

### B. The Alpha Shader (OSL)

- **Constraint:** **Strictly Stateless.** No look-back loops or static state within the `.osl` code.
- **Logic:** All temporal history (SMA, RSI, etc.) must be baked in the Rust layer and passed to the shader as a point-in-time attribute.
- **Output:** Must return a `closure fix_signal` containing `side`, `quantity`, and `price`.

### C. The GA Portfolio Integrator (GAL)

- **Space:** $N$-dimensional Euclidean Space $\mathcal{Cl}_{N,0,0}$.
- **Mechanism:**
  1. Aggregate the $N$ individual shader outputs into a single **Intent Multivector**.
  2. Perform rebalancing using a **Geometric Rotor** ($R$).
  3. Formula: $\Psi_{new} = R \Psi_{old} \tilde{R}$.
- **Mandate:** Rebalancing must be performed via the **Geometric Product**. This ensures the portfolio transformation is treated as a continuous rotation/scaling within the manifold rather than a discrete array operation.

## 4. Implementation Workflow for Milestone 1

1. **Header Synchronization:** Define the `MarketDelegate` and initialize the OSL `ShadingSystem`.
2. **Bridge Integration:** Implement the logic in `VectorTA` to populate buffers that the `MarketDelegate` can query during the shading pass.
3. **Closure Handling:** Define the C++ structure for the `fix_signal` closure to capture shader output.
4. **Integration Pass:** Use **GAL** to resolve the final portfolio state after all shaders in the universe have executed.

## 5. Risk Subspace Projection

When calculating the final intent, the Integrator must support "Risk Blades" (Bivectors). If the **Intent Vector** has a non-zero exterior product ($\wedge$) with a **Risk Blade**, the Integrator must project the intent onto the orthogonal complement of the risk subspace using the Inner Product.

## 6. How to run M1

This section is the **operator checklist** for the Milestone-1 driver (`OTL_Engine`).

### 6.1 Prerequisites

- **CMake** 3.20+ and a working **C++20** toolchain (MSVC 2022 is the primary target on Windows).
- **vcpkg** (or your own prefix) with everything **OSL** needs (LLVM, OpenImageIO, Imath, pugixml, etc.). Set `CMAKE_TOOLCHAIN_FILE` to your `vcpkg.cmake`, or let the top-level `CMakeLists.txt` pick up the default path under `C:\Users\joeff\vcpkg\...` if that tree exists.
- **Rust** (for Corrosion) so `3rdparty/VectorTA` can build with the `**cxx-bridge`** feature. No separate `cargo` step is required if you only build through CMake, but a Rust toolchain must be on `PATH`.
- **Corrosion** is fetched by CMake if it is not already installed; optional: install Corrosion and add it to `CMAKE_PREFIX_PATH` so `find_package(Corrosion CONFIG)` succeeds.

### 6.2 Configure and build (from repo root)

```text
cd C:\Users\joeff\OTL_Suite
cmake -B build -S . -G Ninja -DCMAKE_TOOLCHAIN_FILE="C:\Users\joeff\vcpkg\scripts\buildsystems\vcpkg.cmake"
cmake --build build
```

Use your actual vcpkg path if it differs. The output binary is the `**OTL_Engine**` target (location depends on generator, e.g. `build\OTL_Engine.exe` on MSVC).

### 6.3 Run (minimal: bake + GAL only)

`OTL_Engine` always runs the **VectorTA bake** and **GAL rebalancing** demo on a **64-asset** synthetic universe. No OSL is required for this path.

```text
build\Release\OTL_Engine.exe
```

(or the path your configuration uses for the executable). You should see a short log line with the text `**M1: baked 64 assets**` and a **GA rebalance sample sum**. If the **OSL** block is skipped, the program prints that `**OTL_SHADER_DIR` is not set**—that is expected for this mode.

### 6.4 Run (full M1: include OSL)

1. **Compile the alpha shader** with `**oslc`** from your OSL build/install (so `stdosl` and the usual includes resolve):
  ```text
   oslc -I<path-to-osl-stdosl> OTL-Core\shaders\m1_alpha.osl
  ```
   This produces `**m1_alpha.oso**` in the current directory (or next to the `.osl` if you pass `-o`).
2. **Point the runtime** at a folder that contains `**m1_alpha.oso`** (the filename the `ShadingSystem` layer requests):
  ```text
   set OTL_SHADER_DIR=C:\path\to\folder\containing\m1_alpha.oso
   build\Release\OTL_Engine.exe
  ```
3. The engine registers the `**fix_signal**` closure, builds a small **surface** group (`m1_alpha`), and executes one **shade** on **asset 0** using the same baked `**OtlUniverse`** as the C++ path. If something is wrong (missing OSO, JIT, or search path), the log will report `**ShaderGroupEnd failed`** or `**execute failed**`.

### 6.5 Troubleshooting

- `**vector_ta/src/bridge.rs.h` not found** — the Corrosion / `**otl_vector_ta_cxx`** target must build first; the generated header lives under the Cargo build’s cxxbridge include path. A clean `cmake --build` after enabling `**cxx-bridge`** on `vector_ta` usually fixes it.
- **Link errors for `bake_indicator_buffer`** — the exact `cxx` C++ name may differ slightly by bridge layout; adjust `**OTL-Core/otl/VectorTAService.cpp**` to match the declaration in the generated `bridge` header.
- **OSL** configure fails in CMake — the failure is almost always a missing **vcpkg** dependency for **oslexec**; install the OSL port stack or use a prefix where OSL and its dependencies were built.

