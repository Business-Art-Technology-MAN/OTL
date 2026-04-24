// Milestone 2: hysteresis (momentum vs noisy OSL) and bivector friction (λ).

#include "otl/GaPortfolioIntegrator.hpp"
#include "gtest/gtest.h"

#include <cmath>
#include <vector>

namespace {

double sum_abs(std::vector<double> const& v) {
  double s = 0.0;
  for (double x : v) {
    s += std::abs(x);
  }
  return s;
}

}  // namespace

TEST(Phase2, WedgeAntisymmetry) {
  std::vector<double> a = {1.0, 0.0, 0.0};
  std::vector<double> b = {0.0, 1.0, 0.0};
  auto w1 = otl::wedge_1vector(a, b);
  auto w2 = otl::wedge_1vector(b, a);
  ASSERT_EQ(w1.size(), w2.size());
  for (std::size_t k = 0; k < w1.size(); ++k) {
    EXPECT_NEAR(w1[k], -w2[k], 1e-12);
  }
}

TEST(Phase2, BivectorFrictionDampsNorm) {
  std::vector<double> v(6, 1.0);
  double const n0 = sum_abs(v);
  otl::dampen_bivector(v, 0.5);
  double const n1 = sum_abs(v);
  EXPECT_LT(n1 + 1e-12, n0);
  otl::dampen_bivector(v, 0.0);
  EXPECT_LT(sum_abs(v), 1e-12);
}

// OSL = "Buy" (intent) one bar, then "Neutral" (zero intent); high β on W_{t-1} keeps target aligned with prior long.
TEST(Phase2, Hysteresis_MomentumHoldsLongAfterNeutralOsl) {
  otl::RiskModel rm;  // no risk
  std::vector<double> w_prev(4, 0.0);
  w_prev[0] = 0.5;
  std::vector<double> osl_buys(4, 0.0);
  osl_buys[0] = 1.0;
  std::vector<double> osl_zero(4, 0.0);
  // Bar 1: follow strong buy
  std::vector<double> w1 = otl::rebalance_m2(osl_buys, w_prev, rm, 0, 1, 0.5, 1.0, 0.2);
  // Bar 2: OSL neutral, momentum = previous committed portfolio (w1) — still long asset 0
  std::vector<double> w2 = otl::rebalance_m2(osl_zero, w1, rm, 0, 1, 0.5, 0.0, 1.0);
  EXPECT_GT(w2[0], 0.1) << "momentum bivector / prior state should not flip to zero after one quiet bar";
}

// Without new intent, push weights toward equal cash; repeated decay drives toward 1/n.
TEST(Phase2, CashFrictionDrivesToNeutral) {
  int n = 5;
  std::vector<double> w(n, 0.0);
  w[0] = 1.0;  // concentrated
  for (int t = 0; t < 100; ++t) {
    otl::apply_cash_friction_1vector(w, n, 0.2);
  }
  double const target = 1.0 / static_cast<double>(n);
  for (int k = 0; k < n; ++k) {
    EXPECT_NEAR(w[static_cast<std::size_t>(k)], target, 0.02);
  }
}
