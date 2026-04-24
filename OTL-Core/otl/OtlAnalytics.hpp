#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace otl {

/// Econometric + geometric reporting for the Lab (M3): PnL, turnover, and **Geometric Efficiency**
/// (how well the momentum-adjusted portfolio move aligns with the raw OSL 1-vector).
struct AnalyticsBar {
  int bar{0};
  /// Placeholder: cumulative PnL mark (caller fills when pricing exists).
  double pnl_cumulative{0.0};
  /// L1 norm of (w_new - w_old); “turnover of rebalancing rotors” (spec).
  double turnover_l1{0.0};
  /// Givens (or other) plane rotation in degrees (optional, for forensics).
  double rotation_degrees{0.0};
  /// |cos θ| between raw OSL intent and Δw; **Geometric Efficiency**.
  double geometric_efficiency{0.0};
  /// 1 - efficiency; “waste” in the rotation.
  double geometric_wastage{0.0};
};

class OtlAnalytics {
 public:
  OtlAnalytics() = default;

  void clear();

  /// Record one bar. `w_old` = portfolio before this bar, `w_new` after GAL; `osl_intent_1` = raw OSL 1-vector;
  /// `delta_w` may be w_new - w_old (or pass empty to compute from weights).
  void record_bar(int bar, std::vector<double> const& osl_intent_1, std::vector<double> const& w_old, std::vector<double> const& w_new,
                  double rotation_deg, double pnl_cumulative, std::vector<double> const& delta_w_override = {});

  std::vector<AnalyticsBar> const& rows() const { return m_rows; }

  /// CSV with header (utf-8). Returns false on I/O error.
  bool write_csv(std::string const& path) const;
  /// One JSON object per line (ndjson) for easy frontend ingestion.
  bool write_jsonl(std::string const& path) const;

 private:
  std::vector<AnalyticsBar> m_rows;
};

}  // namespace otl
