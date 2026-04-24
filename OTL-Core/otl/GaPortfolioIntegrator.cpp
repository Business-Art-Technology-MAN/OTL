#include "GaPortfolioIntegrator.hpp"

#include <cmath>
#include <cstddef>
#include <vector>

namespace otl {

static double dot(std::vector<double> const& a, std::vector<double> const& b) {
  if (a.size() != b.size()) {
    return 0.0;
  }
  double s = 0.0;
  for (std::size_t k = 0; k < a.size(); ++k) {
    s += a[k] * b[k];
  }
  return s;
}

// Subtract projections onto each (possibly unnormalized) basis row.
static std::vector<double> project_off(std::vector<double> w, std::vector<std::vector<double>> const& basis) {
  for (std::size_t b = 0; b < basis.size(); ++b) {
    std::vector<double> const& e = basis[b];
    if (e.size() != w.size()) {
      continue;
    }
    double s = 0.0, ne = 0.0;
    for (std::size_t k = 0; k < w.size(); ++k) {
      s += w[k] * e[k];
      ne += e[k] * e[k];
    }
    if (ne > 0.0) {
      for (std::size_t k = 0; k < w.size(); ++k) {
        w[k] -= (s / ne) * e[k];
      }
    }
  }
  return w;
}

std::vector<double> project_orthogonal_complement(std::vector<double> const& v, RiskModel const& rm) {
  if (v.empty() || rm.risk_basis.empty()) {
    return v;
  }
  return project_off(v, rm.risk_basis);
}

void apply_plane_rotation(std::vector<double>& v, std::size_t i, std::size_t j, double cos_t, double sin_t) {
  if (i >= v.size() || j >= v.size()) {
    return;
  }
  double const xi = v[i];
  double const xj = v[j];
  v[i] = cos_t * xi - sin_t * xj;
  v[j] = sin_t * xi + cos_t * xj;
}

std::vector<double> rebalance_intent(std::vector<double> psi, RiskModel const& rm, std::size_t i, std::size_t j, double degrees) {
  std::vector<double> w = project_orthogonal_complement(psi, rm);
  double const rad = degrees * (3.14159265358979323846 / 180.0);
  double const c = std::cos(rad);
  double const s = std::sin(rad);
  apply_plane_rotation(w, i, j, c, s);
  return w;
}

}  // namespace otl
