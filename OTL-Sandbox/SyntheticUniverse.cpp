#include "SyntheticUniverse.hpp"

#include "otl/VectorTAService.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace otl::sandbox {

// Deterministic 32-bit xorshift (small, no external std::random in header).
static std::uint32_t xorshift32(std::uint32_t& s) {
  s ^= s << 13;
  s ^= s >> 17;
  s ^= s << 5;
  return s;
}

static double unit_noise(std::uint32_t& s) {
  return static_cast<double>(xorshift32(s) & 0x7fffffffu) / 2147483647.0 - 0.5;
}

SyntheticUniverse::SyntheticUniverse(int n_assets, int series_len, int bar_index, unsigned int seed)
    : m_n(std::max(1, n_assets))
    , m_len(std::max(2, series_len))
    , m_bar(bar_index) {
  m_close.resize(static_cast<std::size_t>(m_n));
  m_rsi.resize(static_cast<std::size_t>(m_n));
  std::uint32_t s = seed ? seed : 0x4f544c0Du;
  for (int a = 0; a < m_n; ++a) {
    std::vector<double>& c = m_close[static_cast<std::size_t>(a)];
    c.resize(static_cast<std::size_t>(m_len));
    bool const up = a < 32;
    // Mean-revert around a strong drift: dX = k*(mu - X) + noise
    double const mu = 100.0 + 0.12 * static_cast<double>(a);
    double const drift = up ? 0.045 : -0.045;
    c[0] = mu;
    for (int t = 1; t < m_len; ++t) {
      double const reversion = 0.08 * (mu - c[static_cast<std::size_t>(t - 1)]);
      double w = 0.35 * unit_noise(s);
      c[static_cast<std::size_t>(t)] =
          c[static_cast<std::size_t>(t - 1)] + drift + reversion + w;
    }
  }
  for (int a = 0; a < m_n; ++a) {
    m_rsi[static_cast<std::size_t>(a)] = otl::bake_series("rsi", m_close[static_cast<std::size_t>(a)], 14);
  }
}

void SyntheticUniverse::fill(otl::OtlUniverse& u) const {
  u.resize(m_n);
  u.set_bar(m_bar);
  for (int a = 0; a < m_n; ++a) {
    u.set_m_series(a, "m_close", m_close[static_cast<std::size_t>(a)]);
    if (!m_rsi[static_cast<std::size_t>(a)].empty()) {
      u.set_m_series(a, "m_rsi", m_rsi[static_cast<std::size_t>(a)]);
    }
  }
}

double SyntheticUniverse::last_close(int asset) const {
  if (asset < 0 || asset >= m_n) {
    return 0.0;
  }
  std::vector<double> const& c = m_close[static_cast<std::size_t>(asset)];
  if (c.empty()) {
    return 0.0;
  }
  int b = m_bar;
  if (b < 0) {
    b = 0;
  }
  if (b >= static_cast<int>(c.size())) {
    b = static_cast<int>(c.size()) - 1;
  }
  return c[static_cast<std::size_t>(b)];
}

double SyntheticUniverse::last_rsi(int asset) const {
  if (asset < 0 || asset >= m_n) {
    return 0.0;
  }
  std::vector<double> const& r = m_rsi[static_cast<std::size_t>(asset)];
  if (r.empty()) {
    return 0.0;
  }
  int b = m_bar;
  if (b < 0) {
    b = 0;
  }
  if (b >= static_cast<int>(r.size())) {
    b = static_cast<int>(r.size()) - 1;
  }
  return r[static_cast<std::size_t>(b)];
}

}  // namespace otl::sandbox
