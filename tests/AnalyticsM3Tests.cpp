#include "otl/OtlAnalytics.hpp"
#include "otl/OtlGeometricMetrics.hpp"
#include "gtest/gtest.h"

#include <cmath>
#include <vector>

TEST(AnalyticsM3, GeometricAlignment_Parallel) {
  std::vector<double> a = {1.0, 2.0, 3.0};
  std::vector<double> b = {2.0, 4.0, 6.0};
  EXPECT_NEAR(otl::geometric_alignment(a, b), 1.0, 1e-9);
  EXPECT_NEAR(otl::geometric_wastage(a, b), 0.0, 1e-9);
}

TEST(AnalyticsM3, GeometricAlignment_Orthogonal) {
  std::vector<double> a = {1.0, 0.0, 0.0};
  std::vector<double> b = {0.0, 1.0, 0.0};
  EXPECT_NEAR(otl::geometric_alignment(a, b), 0.0, 1e-9);
  EXPECT_NEAR(otl::geometric_wastage(a, b), 1.0, 1e-9);
}

TEST(AnalyticsM3, OtlAnalytics_RecordAndCsv) {
  otl::OtlAnalytics an;
  std::vector<double> w0(3, 0.0);
  std::vector<double> w1 = {0.3, 0.0, 0.0};
  std::vector<double> osl = {1.0, 0.0, 0.0};
  an.record_bar(0, osl, w0, w1, 2.0, 0.0, {});
  ASSERT_EQ(an.rows().size(), 1u);
  EXPECT_NEAR(an.rows()[0].geometric_efficiency, 1.0, 1e-6);
  EXPECT_NEAR(an.rows()[0].turnover_l1, 0.3, 1e-6);
}
