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

}  // namespace otl
