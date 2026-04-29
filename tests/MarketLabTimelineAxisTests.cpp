#include "mlab/TimelineAxisJson.hpp"

#include <gtest/gtest.h>

#include <sstream>
#include <string>
#include <vector>

TEST(TimelineAxisJson, BarsZero_HasEmptyTicks) {
  nlohmann::json const axis = mlab::host::make_timeline_axis_json(0, {});
  ASSERT_TRUE(axis.contains("bars"));
  EXPECT_EQ(axis["bars"].get<int>(), 0);
  ASSERT_TRUE(axis.contains("ticks"));
  ASSERT_TRUE(axis["ticks"].is_array());
  EXPECT_EQ(axis["ticks"].size(), std::size_t{0});
}

TEST(TimelineAxisJson, BarsOne_HasSingleTickBarZero) {
  std::vector<std::string> const labels{"2024-01-01 10:00:00"};
  nlohmann::json const axis = mlab::host::make_timeline_axis_json(1, labels);
  EXPECT_EQ(axis["bars"].get<int>(), 1);
  ASSERT_EQ(axis["ticks"].size(), std::size_t{1});
  EXPECT_EQ(axis["ticks"][0]["bar"].get<int>(), 0);
  EXPECT_EQ(axis["ticks"][0]["wall"].get<std::string>(), labels[0]);
}

TEST(TimelineAxisJson, NineSamplesOnTwoBars_HasBothEndpoints) {
  std::vector<std::string> const labels{"A", "B"};
  nlohmann::json const axis = mlab::host::make_timeline_axis_json(2, labels);
  ASSERT_EQ(axis["ticks"].size(), std::size_t{2});
  EXPECT_EQ(axis["ticks"][0]["bar"].get<int>(), 0);
  EXPECT_EQ(axis["ticks"][1]["bar"].get<int>(), 1);
  EXPECT_EQ(axis["ticks"][0]["wall"].get<std::string>(), "A");
  EXPECT_EQ(axis["ticks"][1]["wall"].get<std::string>(), "B");
}

TEST(TimelineAxisJson, ManyBars_StrictIncreasingBarAndMatchingWall) {
  int const nb = 100;
  std::vector<std::string> labels(static_cast<std::size_t>(nb));
  for (int i = 0; i < nb; ++i) {
    std::ostringstream o;
    o << "DAY-" << i;
    labels[static_cast<std::size_t>(i)] = o.str();
  }
  nlohmann::json const axis = mlab::host::make_timeline_axis_json(nb, labels);
  EXPECT_EQ(axis["bars"].get<int>(), nb);
  auto const& ticks = axis["ticks"];
  ASSERT_GE(ticks.size(), std::size_t{2});
  int prev = -999;
  for (auto const& t : ticks) {
    int const bar = t["bar"].get<int>();
    std::string const w = t["wall"].get<std::string>();
    ASSERT_GT(bar, prev);
    prev = bar;
    EXPECT_EQ(w, labels.at(static_cast<std::size_t>(bar)));
  }
}

TEST(TimelineAxisJson, LabelsTooShortProducesNoTicks) {
  std::vector<std::string> const labels{"only", "two"};
  nlohmann::json const axis = mlab::host::make_timeline_axis_json(50, labels);
  EXPECT_EQ(axis["bars"].get<int>(), 50);
  ASSERT_TRUE(axis["ticks"].is_array());
  EXPECT_EQ(axis["ticks"].size(), std::size_t{0});
}

TEST(TimelineAxisJson, SeventeenBars_MatchesUniformlySpacedRounding) {
  int const nb = 17;
  std::vector<std::string> labels(static_cast<std::size_t>(nb));
  for (int i = 0; i < nb; ++i) {
    labels[static_cast<std::size_t>(i)] = "b" + std::to_string(i);
  }
  nlohmann::json const axis = mlab::host::make_timeline_axis_json(nb, labels);

  ASSERT_EQ(axis["ticks"].size(), std::size_t{9});

  auto const collect_bars = [&]() -> std::vector<int> {
    std::vector<int> bs;
    for (auto const& t : axis["ticks"]) {
      bs.push_back(t["bar"].get<int>());
    }
    return bs;
  };
  ASSERT_EQ(collect_bars(), (std::vector<int>{0, 2, 4, 6, 8, 10, 12, 14, 16}));
}
