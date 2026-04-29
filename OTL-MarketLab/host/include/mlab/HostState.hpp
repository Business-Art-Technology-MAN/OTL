#pragma once

#include "mlab/OslM1Shading.hpp"
#include "otl/OtlNodeSystem.hpp"
#include "otl/OtlUniverse.hpp"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace mlab::host {

/// In-process state for the Market Lab C++ host: loaded Yahoo CSV, wall-clock bar labels, universe + optional node system.
struct HostState {
  otl::OtlUniverse         m_universe;
  otl::OtlNodeSystem       m_node_system;
  std::string              m_path;
  int                      m_bars{0};
  std::vector<std::string> m_bar_labels;
  /// Per-asset close series, length `m_bars` each (from CSV / `OtlUniverse`); mirrors column order.
  std::vector<std::vector<double>> m_asset_closes;
  /// Asset 0 closes (convenience; same as `m_asset_closes[0]` when N>=1).
  std::vector<double>       m_close0;
  /// CSV header names for asset columns (`header[1]..`; same order as universe assets).
  std::vector<std::string>  m_asset_column_labels;

  /// Full Uber Technical node JSON (includes optional top-level "lab" for UI-only keys). Drives OtlNodeSystem.
  std::string              m_uber_config_json;
  /// Backdrop "shadow" trace: `m_attr` name in `OtlUniverse` (e.g. m_sma_20) from `lab.primary_overlay` in m_uber_config_json.
  std::string              m_primary_overlay;
  /// JSON: method (equal|strength|risk), leverage, comm_bps, slippage_bps — applied on SEEK for `telemetry.portfolio`.
  std::string              m_portfolio_config_json;

  /// Optional: `lab.osl_shader_dir` from `SET_UBER` JSON (trimmed). Empty = fall back to `OTL_SHADER_DIR`.
  std::string                 m_osl_shader_dir_override;

  /// Optional OSL M1 (`m1_alpha.oso`); search path: `m_osl_shader_dir_override` if set, else `OTL_SHADER_DIR`.
  std::unique_ptr<OslM1Shading> m_osl_m1;
  std::string                 m_osl_shader_dir_init;

  /// `integrator: gal_m1` only: O(b) work reduction — forward scrub from last playhead, same-bar no-op, or full replay when scrubbing back or config changes.
  std::string                 m_gal_m1_cache_key;
  int                         m_gal_m1_end_bar{-1};
  std::vector<double>          m_gal_m1_eq_cache;
  nlohmann::json               m_gal_m1_last_osl;
  /// Weight-change events for bars `0..end_bar` matching `m_gal_m1_eq_cache` span (gal_m1 SEEK / analysis).
  std::vector<nlohmann::json>  m_gal_m1_trades_cache;
  /// Last `run_gal_m1_replay` path: `full` | `forward` | `cached_same_bar` (debug / NASA).
  std::string                  m_gal_m1_last_replay_mode;

  /// If `precomputed_osl_m1` is set, that JSON is used as `telemetry.osl_m1` (execution clock already ran OSL).
  void append_osl_m1_telemetry(
      nlohmann::json& telem, int playhead_bar, nlohmann::json const* precomputed_osl_m1 = nullptr);

  /// Load `OTL_Data/.../universe_close_matrix.csv` style; fills bar labels and `m_close0`.
  bool load_data(std::string const& path, std::string& err);
  int  find_bar_index_for_seek(std::string const& time_token) const;
  void set_playhead(int bar);

  /// Apply `m_uber_config_json` to m_node_system and rebake (requires data loaded). On failure leaves previous system if any.
  bool apply_uber_config(std::string& err);
  /// Replace Uber JSON and, if a CSV is loaded, rebake immediately. Returns `apply_uber_config` result on loaded state.
  bool set_uber_signal_json(std::string json, std::string& err);
  /// Portfolio compositor parameters from the UI; drives `telemetry.portfolio` in SEEK (host-side PnL path).
  bool set_portfolio_json(std::string json, std::string& err);

  /// JSON for LOAD_DATA result.
  std::string load_data_json();
  /// JSON for SEEK: node states, telemetry, bridge heartbeat.
  std::string seek_json(std::string const& time_token);

  /// ANLY-CSV: write `Timestamp,Price,Signal,Weight,Daily_Return,Cumulative_Wealth,Drawdown` for the loaded series.
  bool export_analysis_csv(std::string const& path, std::string& err);
};

}  // namespace mlab::host
