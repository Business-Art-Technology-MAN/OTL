#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace otl {

/// Baked, point-in-time market attributes per asset (e.g. "m_close", "m_rsi"), plus
/// **Milestone-2** persistent portfolio 1-vectors and velocity bivector (for GAL/OSL feedback).
class OtlUniverse {
 public:
  OtlUniverse() = default;

  int asset_count() const { return m_asset_count; }
  void resize(int n);
  int bar() const { return m_bar; }
  void set_bar(int b) { m_bar = b; }

  void set_m_attr(int asset, std::string const& key, float v);
  void set_m_series(int asset, std::string const& key, std::vector<double> series);

  bool try_get_m(int asset, char const* name, bool derivatives, float* val) const;

  /// If a series was stored for `key` on `asset`, points `out` at it (read-only, valid until the series is replaced).
  bool try_get_m_series(int asset, std::string const& key, std::vector<double> const** out) const;
  int last_asset() const { return m_last_asset; }
  void set_thread_asset(int a) { m_last_asset = a; }

  // --- M2: portfolio state (1-vectors in R^N) ---------------------------------
  /// Snapshots of the GAL output: `m_previous` = last committed `m_current` (W_{t-1} at start of step).
  std::vector<double> const& current_portfolio() const { return m_current_portfolio; }
  std::vector<double> const& previous_portfolio() const { return m_previous_portfolio; }
  /// What OSL reads as `m_prev_weight` for this **bar’s** shading: weights after the **previous** bar’s GAL.
  std::vector<double> const& osl_prev_weight() const { return m_osl_prev_portfolio; }

  /// Call at the **start** of a bar, before OSL / GAL: OSL’s `m_prev_weight` = last bar’s GAL result.
  void begin_bar();
  /// Call after GAL: commit `w` as the new portfolio; rolls previous ← current, current ← w.
  void commit_post_gal(std::vector<double> w);
  void clear_portfolio_state();

  /// Grade-2 bivector V_t = Psi_t ∧ Psi_{t-1} (upper-triangular, row-major i<j), damped in-place.
  std::vector<double> const& velocity_bivector() const { return m_velocity_bivector; }
  void set_velocity_bivector(std::vector<double> v);

 private:
  void sync_bivector_storage_size();

  struct PerAsset {
    std::unordered_map<std::string, float> scalars;
    std::unordered_map<std::string, std::vector<double>> series;
  };

  int m_asset_count{0};
  int m_bar{0};
  std::vector<PerAsset> m_per;
  int m_last_asset{0};

  /// After last `commit_post_gal`.
  std::vector<double> m_current_portfolio;
  /// `m_current` at the end of the prior `commit` (W_{t-1} for integrator wedge with new W_t).
  std::vector<double> m_previous_portfolio;
  /// Copy of W_{t-1} for OSL `getattribute("m_prev_weight", ...)` on this bar.
  std::vector<double> m_osl_prev_portfolio;
  /// Last computed Ψ_t ∧ Ψ_{t-1} (damped elsewhere); length n(n-1)/2.
  std::vector<double> m_velocity_bivector;
};

struct OtlRenderState {
  OtlUniverse* universe{nullptr};
  int asset_id{0};
};

}  // namespace otl
