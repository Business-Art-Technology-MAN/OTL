// OTL Phase 1.5: GaPortfolioIntegrator — projection, Givens / rotor slice, and risk-subspace tests.
// "Risk bivector" in the spec is represented as a span of grade-1 basis vectors in R^N (sector blades).

#include <gal/vga.hpp>

#include <cmath>
#include <cstddef>
#include <vector>

#include "otl/GaPortfolioIntegrator.hpp"
#include "gtest/gtest.h"

namespace {

double dot(std::vector<double> const& a, std::vector<double> const& b) {
  double s = 0.0;
  for (std::size_t i = 0; i < a.size() && i < b.size(); ++i) {
    s += a[i] * b[i];
  }
  return s;
}

double norm2(std::vector<double> const& v) {
  return std::sqrt(dot(v, v));
}

/// Component of `v` lying in `span(rm.risk_basis)` (assumes given basis; not necessarily orthogonal).
std::vector<double> project_onto_risk_subspace(std::vector<double> const& v, otl::RiskModel const& rm) {
  std::size_t n = v.size();
  std::vector<double> acc(n, 0.0);
  for (auto const& b : rm.risk_basis) {
    if (b.size() != n) {
      continue;
    }
    double nb = dot(b, b);
    if (nb > 0.0) {
      double s = dot(v, b) / nb;
      for (std::size_t k = 0; k < n; ++k) {
        acc[k] += s * b[k];
      }
    }
  }
  return acc;
}

}  // namespace

// Intent projected off the risk (sector) subspace: residual has zero magnitude in the restricted
// (risk) subspace — equivalently dot(w, b)=0 for every risk direction b in an orthonormal model.
TEST(Integrator, ProjectedIntentZeroInRiskSubspace) {
  int const n = 12;
  otl::RiskModel rm;
  for (int k = 0; k < 3; ++k) {
    std::vector<double> e(n, 0.0);
    e[static_cast<std::size_t>(k)] = 1.0;
    rm.risk_basis.push_back(std::move(e));
  }
  std::vector<double> intent(n, 0.0);
  for (int i = 0; i < n; ++i) {
    intent[static_cast<std::size_t>(i)] = 0.1 * static_cast<double>(i - 3) + 0.4;
  }
  std::vector<double> w = otl::project_orthogonal_complement(intent, rm);
  for (int k = 0; k < 3; ++k) {
    std::vector<double> e(n, 0.0);
    e[static_cast<std::size_t>(k)] = 1.0;
    EXPECT_NEAR(dot(w, e), 0.0, 1e-10) << "not orthogonal to risk basis " << k;
  }
  std::vector<double> w_r = project_onto_risk_subspace(w, rm);
  EXPECT_NEAR(norm2(w_r), 0.0, 1e-9) << "projected intent should have no component in risk span";
}

// Givens "rotor" at π radians: in the (i,j) plane, e_i → −e_i (and e_j is unchanged for v = e_i).
TEST(Integrator, Givens180FlipsStandardBasisInSlice) {
  int const n = 7;
  std::size_t i = 2, j = 4;
  std::vector<double> e_i(n, 0.0);
  e_i[i] = 1.0;
  otl::RiskModel const empty{};
  std::vector<double> out = otl::rebalance_intent(e_i, empty, i, j, 180.0);
  ASSERT_EQ(out.size(), e_i.size());
  for (std::size_t k = 0; k < out.size(); ++k) {
    double ex = 0.0;
    if (k == i) {
      ex = -1.0;
    }
    EXPECT_NEAR(out[k], ex, 1e-9) << "k=" << k;
  }
}

TEST(Integrator, GAL_ThreeD_Orthogonality) {
  otl::RiskModel rm;
  std::vector<double> e0 = {0.0, 0.0, 1.0};
  rm.risk_basis.push_back(e0);
  std::vector<double> v = {1.0, 2.0, 3.0};
  std::vector<double> w = otl::project_orthogonal_complement(v, rm);
  gal::vga::vector<double> g_e(0, 0, 1);
  gal::vga::vector<double> g_w(w[0], w[1], w[2]);
  double gal_dot = 0.0;
  for (std::size_t d = 0; d < 3; ++d) {
    gal_dot += static_cast<double>(g_e[d] * g_w[d]);
  }
  EXPECT_NEAR(gal_dot, 0.0, 1e-12);
}

TEST(Integrator, RebalanceEmptyRiskMatchesGivens) {
  std::vector<double> v = {3.0, 4.0, 5.0};
  otl::RiskModel rm;
  std::vector<double> out = otl::rebalance_intent(v, rm, 0, 1, 33.0);
  double const rad = 33.0 * (3.14159265358979323846 / 180.0);
  double const c = std::cos(rad);
  double const s = std::sin(rad);
  std::vector<double> ref = v;
  double xi = ref[0], xj = ref[1];
  ref[0] = c * xi - s * xj;
  ref[1] = s * xi + c * xj;
  for (std::size_t k = 0; k < out.size(); ++k) {
    EXPECT_NEAR(out[k], ref[k], 1e-9) << "k=" << k;
  }
}

TEST(Integrator, NormPreservedAfterProjectAndRotate) {
  otl::RiskModel rm;
  std::vector<double> e0(5, 0.0);
  e0[2] = 1.0;
  rm.risk_basis.push_back(e0);
  std::vector<double> v = {2.0, 7.0, 1.0, 0.0, 2.0};
  std::vector<double> w = otl::rebalance_intent(v, rm, 1, 3, 12.0);
  std::vector<double> p = otl::project_orthogonal_complement(v, rm);
  EXPECT_NEAR(norm2(p), norm2(w), 1e-9);
}

TEST(Integrator, Determinism) {
  otl::RiskModel rm;
  std::vector<double> e0(5, 0.0);
  e0[2] = 1.0;
  rm.risk_basis.push_back(e0);
  std::vector<double> u(5, 0.0);
  for (int i = 0; i < 5; ++i) {
    u[static_cast<std::size_t>(i)] = 0.1 * static_cast<double>(i * i) - 0.3;
  }
  auto a = otl::rebalance_intent(u, rm, 0, 4, 5.0);
  auto b = otl::rebalance_intent(u, rm, 0, 4, 5.0);
  ASSERT_EQ(a.size(), b.size());
  for (std::size_t i = 0; i < a.size(); ++i) {
    EXPECT_EQ(a[i], b[i]) << "i=" << i;
  }
}
