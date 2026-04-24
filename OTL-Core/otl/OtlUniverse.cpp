#include "OtlUniverse.hpp"

#include <algorithm>
#include <cstring>

using otl::OtlUniverse;

void OtlUniverse::resize(int n) {
  m_asset_count = n;
  m_per.resize(std::max(0, n));
}

void OtlUniverse::set_m_attr(int asset, std::string const& key, float v) {
  if (asset < 0 || asset >= m_asset_count) {
    return;
  }
  m_per[static_cast<std::size_t>(asset)].scalars[key] = v;
}

void OtlUniverse::set_m_series(int asset, std::string const& key, std::vector<double> series) {
  if (asset < 0 || asset >= m_asset_count) {
    return;
  }
  m_per[static_cast<std::size_t>(asset)].series[key] = std::move(series);
  // Keep scalar in sync: last valid bar
  if (!m_per[static_cast<std::size_t>(asset)].series[key].empty()) {
    int b = m_bar;
    auto const& s = m_per[static_cast<std::size_t>(asset)].series[key];
    if (b < 0) {
      b = 0;
    }
    if (b >= static_cast<int>(s.size())) {
      b = static_cast<int>(s.size()) - 1;
    }
    m_per[static_cast<std::size_t>(asset)].scalars[key] = static_cast<float>(s[static_cast<std::size_t>(b)]);
  }
}

bool OtlUniverse::try_get_m(int asset, char const* name, bool derivatives, float* val) const {
  if (!val || !name) {
    return false;
  }
  if (asset < 0 || asset >= m_asset_count) {
    return false;
  }
  std::string const k(name);
  auto const& pa = m_per[static_cast<std::size_t>(asset)];

  double out = 0.0;
  bool ok = false;
  auto s_it = pa.series.find(k);
  if (s_it != pa.series.end() && !s_it->second.empty()) {
    int b = m_bar;
    if (b < 0) {
      b = 0;
    }
    if (b >= static_cast<int>(s_it->second.size())) {
      b = static_cast<int>(s_it->second.size()) - 1;
    }
    out = s_it->second[static_cast<std::size_t>(b)];
    ok = true;
  } else {
    auto c_it = pa.scalars.find(k);
    if (c_it != pa.scalars.end()) {
      out = c_it->second;
      ok = true;
    }
  }
  if (!ok) {
    return false;
  }
  val[0] = static_cast<float>(out);
  if (derivatives) {
    val[1] = 0.0f;
    val[2] = 0.0f;
  }
  return true;
}
