#pragma once

#include <cstddef>
#include <vector>

#include "otl/OtlUniverse.hpp"

namespace otl::sandbox {

/// Deterministic, mean-reverting **prices** for Phase 1.5 toy runs:
/// - **Assets 0-31:** upward trend (tends to RSI > 50 for `m1_alpha` "buy" side 1.0).
/// - **Assets 32-63:** downward trend (tends to RSI < 50, side 2.0 in `m1_alpha`).
class SyntheticUniverse {
 public:
  static constexpr int kDefaultAssets = 64;
  static constexpr int kDefaultLen = 120;
  static constexpr int kDefaultBar = 99;

  SyntheticUniverse(int n_assets, int series_len, int bar_index,
                    unsigned int seed = 0x4f544c0Du);

  int asset_count() const { return m_n; }
  int series_len() const { return m_len; }
  int bar() const { return m_bar; }

  /// Bakes `m_close` and VectorTA `m_rsi` into the given universe (and syncs scalars to `bar()`).
  void fill(otl::OtlUniverse& u) const;

  /// Per-asset last-bar close in `m_close` series (at index `m_bar` clamped).
  double last_close(int asset) const;

  /// Baked RSI at current bar (from stored series) after `fill()`.
  double last_rsi(int asset) const;

  std::vector<double> const& close_series(int asset) const {
    return m_close[static_cast<std::size_t>(asset)];
  }
  std::vector<double> const& rsi_series(int asset) const {
    return m_rsi[static_cast<std::size_t>(asset)];
  }

 private:
  int m_n;
  int m_len;
  int m_bar;
  std::vector<std::vector<double>> m_close;
  std::vector<std::vector<double>> m_rsi;
};

}  // namespace otl::sandbox
