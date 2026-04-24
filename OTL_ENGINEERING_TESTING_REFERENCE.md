# OTL Phase 1.5: Verification & Unit Testing

**Objective:** Create a hermetic testing environment for cross-language logic (Rust/C++/OSL) and an end-to-end "Toy App" to simulate a single market cycle.

## 1. The Testing Framework: GTest + Crate Tests

Claude should implement a dual-layer testing strategy:

- **Rust Layer:** Standard `cargo test` in `3rdparty/VectorTA` to verify indicator accuracy (SMA/RSI) before they ever hit C++.
- **C++ Layer:** Use **GoogleTest (GTest)** (available via your `vcpkg`) to verify the `MarketDelegate` and `GaPortfolioIntegrator`.

### Claude Instructions: GTest Integration

1. Add `find_package(GTest REQUIRED)` to the root `CMakeLists.txt`.
2. Create `tests/IntegratorTests.cpp`.
3. **Test Case:** Verify that projecting an **Intent Vector** onto a **Risk Bivector** results in a vector with zero magnitude in the restricted subspace.
4. **Test Case:** Verify that a **Givens Rotor** of $180^\circ$ ($\pi$ radians) correctly flips the sign of a basis vector in the $\mathcal{Cl}_{n}$ manifold.

## 2. The "Toy App" (OTL-Sandbox)

The "Toy App" should be a simplified version of `main.cpp` that uses a known, deterministic dataset to verify the end-to-end pipeline.

### Component 1: The Synthetic Universe

Claude must implement a `SyntheticUniverse` class that generates a "Mean Reverting" price series for 64 assets.

- **Asset 0-31:** Trending up (should trigger "Buy" in OSL).
- **Asset 32-63:** Trending down (should trigger "Sell" in OSL).

### Component 2: The Logic Check

The Toy App must output a CSV or console log showing:

1. **Raw Close** $\rightarrow$ **VectorTA RSI** $\rightarrow$ **OSL Signal**.
2. **The Resultant Multivector:** Print the coordinates of the portfolio 1-vector before and after the GA rotation.

## 3. OSL Reference for Claude

Claude will need to verify the closure registration. Direct it to reference the OSL source you already have:

- **Source:** `3rdparty/osl/src/testshade/testshade.cpp`
- **Focus:** Look at how `testshade` registers custom closures and handles the `OSL::RendererServices` overrides.
- **Task:** Claude must mirror the closure registration logic so `fix_signal` is recognized as a valid return type by the OSL compiler (`oslc`) and runtime.

## 4. End-to-End Validation Script

Provide Claude with this "Success Criteria" for the Toy App:

> **Success Scenarios:**
>
> 1. **Data Integrity:** Does the value `m_close` inside the OSL shader match the value in the C++ `OtlUniverse` for the current bar?
> 2. **GA Orthogonality:** If a "Risk Blade" is defined for "Sector A," does the Integrator successfully zero out trades for Asset 0-10 if they belong to that sector?
> 3. **Closure Recovery:** Does the `MarketDelegate` successfully catch the `fix_signal` and extract the `float` price/quantity?

