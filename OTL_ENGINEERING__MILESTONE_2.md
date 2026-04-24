# OTL Project Specification: Milestone 2

**Phase:** Multi-Period Persistence & Geometric Momentum

**Goal:** Transition the manifold from static snapshots to a stateful, dynamic system with "Mass" and "Inertia."

## 1. The Persistence Logic

In Phase 1, the manifold was "stateless"—recalculated from zero or target each bar. Phase 2 introduces **Stateful Feedback**, where the previous state ($\Psi_{t-1}$) influences the current transformation.

- **Portfolio State Persistence:** The `OtlUniverse` must now maintain a persistent `PortfolioVector` member that survives the `run_iteration` loop.
- **The Velocity Bivector ($V_t$):** We define the "direction of travel" as the bivector formed by the wedge product of the last two states: $V_t = \Psi_t \wedge \Psi_{t-1}$.

## 2. Component Updates

### A. OtlUniverse (C++)

- **Persistent Storage:** Add `m_current_portfolio` (1-vector) and `m_previous_portfolio` (1-vector).
- **OSL Feedback:** Register and expose `m_prev_weight` as an attribute. This allows OSL shaders to "see" their current position in the manifold, enabling **path-dependent logic** (e.g., "only exit if we currently hold > 2%").

### B. GaPortfolioIntegrator (C++)

We move from a "Rotate-to-Target" model to a **Momentum-Adjusted Rebalance**.

- **The Intent Blend:**
$$\Psi_{target} = \text{Normalize}(\alpha \cdot \text{OSLIntent} + \beta \cdot \text{MomentumVector})$$
- **Geometric Friction:** Implement a scalar decay $\lambda \in [0, 1]$ that damps the velocity bivector every bar to prevent the manifold from "spinning" indefinitely on old signals.

### C. OSL Shaders (Alpha Logic)

- **Attribute Usage:** Shaders should now utilize `getattribute("m_prev_weight", ...)` to calculate **Trade Urgency**.
- **Constraint:** Shaders remain technically stateless regarding *time*, but they now react to the *state* of the capital.

## 3. Implementation Workflow: Milestone 2

1. **State Hook:** Update `MarketDelegate` to initialize `OtlUniverse` state on the first bar and persist it.
2. **Bivector Calculation:** Implement the Wedge Product logic in `GaPortfolioIntegrator` to extract the plane of trade.
3. **Feedback Loop:** Verify that the OSL shader correctly receives the `m_prev_weight` from the previous bar's GAL resolution.
4. **Sandbox Expansion:** Update `OTL_Sandbox` to run for $T > 100$ bars to observe how momentum builds and decays.

## 4. Verification (GTest Phase 2)

- **The Hysteresis Test:** Verify that if OSL signals "Buy" for one bar but "Neutral" for the next, the **Momentum Bivector** keeps the portfolio in a "Buy" orientation (filtering noise).
- **The Friction Test:** Verify that in the absence of new OSL signals, the portfolio weight eventually decays toward a "Cash" basis (Neutral) due to $\lambda$.

---

### **How to use this with Claude/Cursor:**

1. **Context:** "We are moving to Phase 2. Here is the new `OTL_ENGINEERING_PHASE_2.md`. Do not modify the existing `MarketDelegate` plumbing unless it breaks the persistence requirements."
2. **Instruction:** "Start by updating `OtlUniverse` to store the 1-vector state and expose it to OSL via the `m_prev_weight` attribute."