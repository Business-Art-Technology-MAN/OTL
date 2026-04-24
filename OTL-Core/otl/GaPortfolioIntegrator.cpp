#include "GaPortfolioIntegrator.hpp"

#include <algorithm>
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

static double norm2_vec(std::vector<double> const& v) {
  return std::sqrt(std::max(0.0, dot(v, v)));
}

std::vector<double> normalize_l2(std::vector<double> v) {
  double n = norm2_vec(v);
  if (n < 1e-30) {
    if (!v.empty()) {
      v[0] = 1.0;
    }
    return v;
  }
  for (double& x : v) {
    x /= n;
  }
  return v;
}

std::vector<double> wedge_1vector(std::vector<double> const& psi, std::vector<double> const& phi) {
  std::size_t n = psi.size();
  if (phi.size() != n || n < 2) {
    return {};
  }
  std::vector<double> out;
  out.reserve(n * (n - 1) / 2);
  for (std::size_t i = 0; i < n; ++i) {
    for (std::size_t j = i + 1; j < n; ++j) {
      out.push_back(psi[i] * phi[j] - psi[j] * phi[i]);
    }
  }
  return out;
}

void dampen_bivector(std::vector<double>& biv, double lambda) {
  if (lambda < 0.0) {
    return;
  }
  if (lambda > 1.0) {
    lambda = 1.0;
  }
  for (double& x : biv) {
    x *= lambda;
  }
}

std::vector<double> blend_intent_momentum(std::vector<double> const& osl_intent_1, std::vector<double> const& momentum_1, double alpha,
                                          double beta) {
  if (osl_intent_1.size() != momentum_1.size()) {
    return {};
  }
  std::vector<double> t(osl_intent_1.size());
  for (std::size_t k = 0; k < t.size(); ++k) {
    t[k] = alpha * osl_intent_1[k] + beta * momentum_1[k];
  }
  return normalize_l2(t);
}

std::vector<double> rebalance_m2(std::vector<double> const& osl_intent, std::vector<double> const& momentum_1, RiskModel const& rm,
                                 std::size_t i, std::size_t j, double degrees, double alpha, double beta) {
  std::vector<double> const psi = blend_intent_momentum(osl_intent, momentum_1, alpha, beta);
  return rebalance_intent(psi, rm, i, j, degrees);
}

void apply_cash_friction_1vector(std::vector<double>& w, int n, double lambda_cash) {
  if (n <= 0 || w.size() != static_cast<std::size_t>(n)) {
    return;
  }
  if (lambda_cash < 0.0) {
    return;
  }
  if (lambda_cash > 1.0) {
    lambda_cash = 1.0;
  }
  double const invn = 1.0 / static_cast<double>(n);
  for (int k = 0; k < n; ++k) {
    w[static_cast<std::size_t>(k)] =
        (1.0 - lambda_cash) * w[static_cast<std::size_t>(k)] + lambda_cash * invn;
  }
}

}  // namespace otl
