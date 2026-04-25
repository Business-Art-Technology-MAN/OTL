#pragma once

#include "otl/OtlNodeSystem.hpp"
#include "otl/OtlUniverse.hpp"

#include <cstdint>
#include <string>
#include <vector>

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

  /// Load `OTL_Data/.../universe_close_matrix.csv` style; fills bar labels and `m_close0`.
  bool load_data(std::string const& path, std::string& err);
  int  find_bar_index_for_seek(std::string const& time_token) const;
  void set_playhead(int bar);

  /// Apply `m_uber_config_json` to m_node_system and rebake (requires data loaded). On failure leaves previous system if any.
  bool apply_uber_config(std::string& err);
  /// Replace Uber JSON and, if a CSV is loaded, rebake immediately. Returns `apply_uber_config` result on loaded state.
  bool set_uber_signal_json(std::string json, std::string& err);

  /// JSON for LOAD_DATA result.
  std::string load_data_json();
  /// JSON for SEEK: node states, telemetry, bridge heartbeat.
  std::string seek_json(std::string const& time_token);
};

}  // namespace mlab::host
