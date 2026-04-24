#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace otl {

class OtlUniverse;

/// Milestone-3: load a small JSON plan that bakes **multiple VectorTA** series and registers them
/// on an `OtlUniverse` asset as `m_*` keys for OSL `getattribute` (e.g. `m_close`, `m_rsi`, `m_sma`).
///
/// Schema (v1) — see `OTL-Core/config/otl_node_example.json`.
class OtlNodeSystem {
 public:
  OtlNodeSystem() = default;

  void clear();
  void clear_error();

  /// Parse JSON from disk. Returns false on I/O/parse/validation errors; see `last_error()`.
  bool load_from_file(std::string const& path);
  /// Parse JSON from a string (tests / in-memory).
  bool load_from_string(std::string const& json);

  int version() const { return m_version; }
  /// Target OSL group/layer name (optional in JSON, informational for Lab runners).
  std::string const& shader_layer() const { return m_shader_layer; }
  /// `m_` series names the config expects a shader to read (optional).
  std::vector<std::string> const& shader_m_attrs() const { return m_shader_m_attrs; }
  /// Where the **close** series is published (e.g. `m_close`).
  std::string const& source_m_attr() const { return m_source_m_attr; }

  /// Per-indicator row (in execution order; `from` = `"close"` or a prior node `id`).
  struct IndicatorNode {
    std::string id;
    std::string indicator_id;
    int32_t     period{14};
    std::string from;
    std::string m_attr;
  };

  std::vector<IndicatorNode> const& indicator_nodes() const { return m_indicators; }

  /// Bake **source** + all indicators, write series into `u` for `asset`, using `close` as the
  /// **close** path. `from` can chain prior outputs by node `id`.
  /// Returns false if validation/baking fails; see `last_error()`.
  bool apply_to_asset(OtlUniverse& u, int asset, std::vector<double> const& close) const;

  std::string const& last_error() const { return m_last_error; }

 private:
  bool parse_json(std::string const& json_text);

  int                     m_version{0};
  std::string             m_source_m_attr{"m_close"};
  std::string             m_shader_layer;
  std::vector<std::string> m_shader_m_attrs;
  std::vector<IndicatorNode> m_indicators;
  mutable std::string     m_last_error;
};

}  // namespace otl
