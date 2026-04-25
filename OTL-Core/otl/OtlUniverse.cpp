#include "OtlUniverse.hpp"

#include <algorithm>
#include <cstring>

using otl::OtlUniverse;

void OtlUniverse::resize(int n) {
  m_asset_count = n;
  m_per.resize(std::max(0, n));
  m_current_portfolio.assign(static_cast<std::size_t>(std::max(0, n)), 0.0);
  m_previous_portfolio.assign(static_cast<std::size_t>(std::max(0, n)), 0.0);
  m_osl_prev_portfolio.assign(static_cast<std::size_t>(std::max(0, n)), 0.0);
  sync_bivector_storage_size();
}

void OtlUniverse::sync_bivector_storage_size() {
  int n = m_asset_count;
  if (n < 2) {
    m_velocity_bivector.clear();
    return;
  }
  std::size_t const pairs = static_cast<std::size_t>(n * (n - 1) / 2);
  m_velocity_bivector.assign(pairs, 0.0);
}

void OtlUniverse::begin_bar() {
  m_osl_prev_portfolio = m_current_portfolio;
}

void OtlUniverse::commit_post_gal(std::vector<double> w) {
  if (m_asset_count <= 0) {
    return;
  }
  if (w.size() != static_cast<std::size_t>(m_asset_count)) {
    w.assign(static_cast<std::size_t>(m_asset_count), 0.0);
  }
  m_previous_portfolio = m_current_portfolio;
  m_current_portfolio  = std::move(w);
}

void OtlUniverse::clear_portfolio_state() {
  for (double& x : m_current_portfolio) {
    x = 0.0;
  }
  for (double& x : m_previous_portfolio) {
    x = 0.0;
  }
  for (double& x : m_osl_prev_portfolio) {
    x = 0.0;
  }
  for (double& x : m_velocity_bivector) {
    x = 0.0;
  }
}

void OtlUniverse::set_velocity_bivector(std::vector<double> v) {
  m_velocity_bivector = std::move(v);
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

bool OtlUniverse::try_get_m_series(int asset, std::string const& key, std::vector<double> const** out) const {
  if (!out || asset < 0 || asset >= m_asset_count) {
    return false;
  }
  auto const& pa = m_per[static_cast<std::size_t>(asset)];
  auto s_it = pa.series.find(key);
  if (s_it == pa.series.end() || s_it->second.empty()) {
    return false;
  }
  *out = &s_it->second;
  return true;
}

bool OtlUniverse::try_get_m(int asset, char const* name, bool derivatives, float* val) const {
  if (!val || !name) {
    return false;
  }
  if (asset < 0 || asset >= m_asset_count) {
    return false;
  }
  std::string const k(name);
  if (k == "m_prev_weight") {
    if (static_cast<std::size_t>(asset) >= m_osl_prev_portfolio.size()) {
      val[0] = 0.0f;
    } else {
      val[0] = static_cast<float>(m_osl_prev_portfolio[static_cast<std::size_t>(asset)]);
    }
    if (derivatives) {
      val[1] = 0.0f;
      val[2] = 0.0f;
    }
    return true;
  }
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
