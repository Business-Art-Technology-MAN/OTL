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
  std::vector<double>      m_close0;  // first-asset close series (bars)

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

  void append_osl_m1_telemetry(nlohmann::json& telem, int playhead_bar);

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
