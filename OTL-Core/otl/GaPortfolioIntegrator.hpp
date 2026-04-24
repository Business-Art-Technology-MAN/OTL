#pragma once

#include <cstddef>
#include <vector>

namespace otl {

/// Risk-blade (low-dimensional) subspace in R^N, plus a basis for the orthogonal part.
struct RiskModel {
  /// Orthonormal basis `rows[k][i] = e_k` for the risk subspace; empty => no risk constraint.
  std::vector<std::vector<double>> risk_basis;
};

/// Project intent vector `v` onto the orthogonal complement of `span(risk_basis)` (inner product in R^N).
std::vector<double> project_orthogonal_complement(std::vector<double> const& v, RiskModel const& rm);

/// Apply a Givens rotation in the (i, j) plane (continuous rotation; sandwich `RΨR̃` in that subalgebra slice).
void apply_plane_rotation(std::vector<double>& v, std::size_t i, std::size_t j, double cos_t, double sin_t);

/// N-dimensional rebalancing: project risk, then rotate a pair of coordinates (Milestone-1 “rotor in manifold” slice).
std::vector<double> rebalance_intent(std::vector<double> psi, RiskModel const& rm, std::size_t i, std::size_t j, double degrees);

// --- Milestone 2: momentum, wedge, friction --------------------------------

/// Bivector Ψ ∧ Φ in the standard basis (e_i ∧ e_j, i < j, row-major); length n(n-1)/2.
std::vector<double> wedge_1vector(std::vector<double> const& psi, std::vector<double> const& phi);

void dampen_bivector(std::vector<double>& biv, double lambda);

/// Unit vector: scale to ℓ2-norm 1, or (1,0,..0) if norm ~ 0.
std::vector<double> normalize_l2(std::vector<double> v);

/// Ψ_target = normalize(α·intent + β·momentum) with momentum a 1-vector (e.g. Ψ_{t-1} or finite-difference).
std::vector<double> blend_intent_momentum(std::vector<double> const& osl_intent_1, std::vector<double> const& momentum_1,
                                          double alpha, double beta);

/// M2 pipeline: blend → same risk projection + plane rotation as M1; intended for post-blend rebalancing.
std::vector<double> rebalance_m2(std::vector<double> const& osl_intent, std::vector<double> const& momentum_1, RiskModel const& rm,
                                 std::size_t i, std::size_t j, double degrees, double alpha, double beta);

/// Damped linear “cash” decay on weights: w ← (1-λ) w + (λ/N) 1  (friction test / neutral target).
void apply_cash_friction_1vector(std::vector<double>& w, int n, double lambda_cash);

}  // namespace otl
