#include "OtlAnalytics.hpp"
#include "OtlGeometricMetrics.hpp"

#include <cmath>
#include <cstddef>
#include <fstream>
#include <string>

namespace otl {

void OtlAnalytics::clear() {
  m_rows.clear();
}

static void vec_sub(std::vector<double> const& a, std::vector<double> const& b, std::vector<double>& out) {
  out.clear();
  if (a.size() != b.size()) {
    return;
  }
  out.resize(a.size());
  for (std::size_t i = 0; i < a.size(); ++i) {
    out[i] = a[i] - b[i];
  }
}

static double l1_norm(std::vector<double> const& v) {
  double s = 0.0;
  for (double x : v) {
    s += std::abs(x);
  }
  return s;
}

void OtlAnalytics::record_bar(int bar, std::vector<double> const& osl_intent_1, std::vector<double> const& w_old,
                              std::vector<double> const& w_new, double rotation_deg, double pnl_cumulative,
                              std::vector<double> const& delta_w_override) {
  AnalyticsBar r;
  r.bar              = bar;
  r.pnl_cumulative  = pnl_cumulative;
  r.rotation_degrees = rotation_deg;
  std::vector<double> dw;
  if (!delta_w_override.empty()) {
    dw = delta_w_override;
  } else {
    vec_sub(w_new, w_old, dw);
  }
  r.turnover_l1 = l1_norm(dw);
  r.geometric_efficiency = geometric_alignment(osl_intent_1, dw);
  r.geometric_wastage   = geometric_wastage(osl_intent_1, dw);
  m_rows.push_back(std::move(r));
}

bool OtlAnalytics::write_csv(std::string const& path) const {
  std::ofstream f(path, std::ios::out | std::ios::trunc);
  if (!f) {
    return false;
  }
  f << "bar,pnl_cumulative,turnover_l1,rotation_deg,geometric_efficiency,geometric_wastage\n";
  f.setf(std::ios::fixed);
  f.precision(9);
  for (AnalyticsBar const& r : m_rows) {
    f << r.bar << ',' << r.pnl_cumulative << ',' << r.turnover_l1 << ',' << r.rotation_degrees << ','
      << r.geometric_efficiency << ',' << r.geometric_wastage << '\n';
  }
  return true;
}

bool OtlAnalytics::write_jsonl(std::string const& path) const {
  std::ofstream f(path, std::ios::out | std::ios::trunc);
  if (!f) {
    return false;
  }
  f.setf(std::ios::fixed);
  f.precision(9);
  for (AnalyticsBar const& r : m_rows) {
    f << '{';
    f << "\"bar\":" << r.bar << ",\"pnl_cumulative\":" << r.pnl_cumulative;
    f << ",\"turnover_l1\":" << r.turnover_l1;
    f << ",\"rotation_deg\":" << r.rotation_degrees;
    f << ",\"geometric_efficiency\":" << r.geometric_efficiency;
    f << ",\"geometric_wastage\":" << r.geometric_wastage;
    f << '}';
    f << '\n';
  }
  return true;
}

}  // namespace otl
