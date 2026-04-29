#include "mlab/TimelineAxisJson.hpp"

#include <cmath>
#include <set>

using json = nlohmann::json;

namespace mlab::host {

nlohmann::json make_timeline_axis_json(int bars, std::vector<std::string> const& bar_labels) {
  json axis = json::object();
  axis["bars"] = bars;
  json ticks = json::array();
  if (bars > 0 && static_cast<std::size_t>(bars) <= bar_labels.size()) {
    int const maxB = bars - 1;
    std::set<int> uniq;
    for (int k = 0; k <= 8; ++k) {
      double const u = static_cast<double>(k) / 8.0;
      int b =
          maxB <= 0 ? 0 : static_cast<int>(std::lround(u * static_cast<double>(maxB)));
      if (b < 0) {
        b = 0;
      }
      if (b > maxB) {
        b = maxB;
      }
      uniq.insert(b);
    }
    for (int const b : uniq) {
      json t = json::object();
      t["bar"] = b;
      t["wall"] = bar_labels[static_cast<std::size_t>(b)];
      ticks.push_back(std::move(t));
    }
  }
  axis["ticks"] = std::move(ticks);
  return axis;
}

}  // namespace mlab::host
