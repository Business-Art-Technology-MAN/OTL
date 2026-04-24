#include <cmath>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "otl/OtlUniverse.hpp"
#include "otl/OtlNodeSystem.hpp"

using otl::OtlNodeSystem;
using otl::OtlUniverse;

static std::vector<double> make_uptrend(int n) {
  std::vector<double> v;
  v.reserve(static_cast<std::size_t>(n));
  for (int i = 0; i < n; ++i) {
    v.push_back(100.0 + static_cast<double>(i) * 0.5);
  }
  return v;
}

TEST(OtlNodeSystem, rejects_bad_json) {
  OtlNodeSystem sys;
  EXPECT_FALSE(sys.load_from_string("not json"));
  EXPECT_FALSE(sys.last_error().empty());
}

TEST(OtlNodeSystem, loads_bakes_rsi_sma) {
  std::string const j = R"json({
  "version": 1,
  "source": { "m_attr": "m_close" },
  "shader": { "layer": "m1_alpha", "m_attrs": ["m_close", "m_rsi", "m_sma"] },
  "indicators": [
    { "id": "r14", "indicator": "rsi", "period": 14, "from": "close", "m_attr": "m_rsi" },
    { "id": "s20", "indicator": "sma", "period": 20, "from": "close", "m_attr": "m_sma" }
  ]
})json";
  OtlNodeSystem sys;
  ASSERT_TRUE(sys.load_from_string(j)) << sys.last_error();
  EXPECT_EQ(1, sys.version());
  EXPECT_EQ("m1_alpha", sys.shader_layer());

  int const n = 128;
  auto close = make_uptrend(n);
  OtlUniverse u;
  u.resize(1);
  u.set_bar(100);
  ASSERT_TRUE(sys.apply_to_asset(u, 0, close)) << sys.last_error();

  float v{};
  ASSERT_TRUE(u.try_get_m(0, "m_rsi", false, &v));
  EXPECT_GE(v, 0.0f);
  EXPECT_LE(v, 100.0f);
  ASSERT_TRUE(u.try_get_m(0, "m_sma", false, &v));
  EXPECT_GT(v, 0.0f);
}

TEST(OtlNodeSystem, chains_sma_rsi) {
  std::string const j = R"json({
  "version": 1,
  "indicators": [
    { "id": "s20", "indicator": "sma", "period": 20, "from": "close", "m_attr": "m_sma20" },
    { "id": "r14", "indicator": "rsi", "period": 14, "from": "s20", "m_attr": "m_rsi_sma" }
  ]
})json";
  OtlNodeSystem sys;
  ASSERT_TRUE(sys.load_from_string(j)) << sys.last_error();
  int const n = 128;
  auto close = make_uptrend(n);
  OtlUniverse u;
  u.resize(1);
  u.set_bar(80);
  ASSERT_TRUE(sys.apply_to_asset(u, 0, close)) << sys.last_error();
  float v{};
  ASSERT_TRUE(u.try_get_m(0, "m_rsi_sma", false, &v));
  EXPECT_TRUE(std::isfinite(v));
}
