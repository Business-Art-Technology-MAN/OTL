#include "mlab/HostState.hpp"

#include "otl/VectorTAService.hpp"
#include "otl/MarketDataCsv.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <set>
#include <sstream>
#include <string>

#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace mlab::host {

namespace {

static void trim(std::string& s) {
  while (!s.empty() && (s.back() == '\r' || s.back() == '\n' || s.back() == ' ')) {
    s.pop_back();
  }
  while (!s.empty() && s.front() == ' ') {
    s.erase(0, 1);
  }
}

static std::vector<std::string> split_csv_line(std::string const& line_in) {
  std::string line = line_in;
  trim(line);
  std::vector<std::string> f;
  for (std::size_t a = 0, p = 0; a <= line.size();) {
    p = line.find(',', a);
    if (p == std::string::npos) {
      f.push_back(line.substr(a));
      break;
    }
    f.push_back(line.substr(a, p - a));
    a = p + 1;
  }
  return f;
}

/// Default “Uber Technical” OtlNodeSystem: RSI(14) + SMA(20) on close; `lab.primary_overlay` for backdrop shadow.
static char const* kDefaultUberConfig = R"json({
  "version": 1,
  "lab": { "primary_overlay": "m_sma_20" },
  "source": { "m_attr": "m_close" },
  "shader": {
    "m_attrs": ["m_close", "m_rsi_14", "m_sma_20"]
  },
  "indicators": [
    {"id": "r14", "indicator": "rsi", "period": 14, "from": "close", "m_attr": "m_rsi_14"},
    {"id": "s20", "indicator": "sma", "period": 20, "from": "close", "m_attr": "m_sma_20"}
  ]
})json";

static bool json_for_node_system(std::string const& full, json& out_stripped, std::string& err) {
  err.clear();
  try {
    out_stripped = json::parse(full);
  } catch (json::parse_error const& e) {
    err = std::string("Uber JSON: ") + e.what();
    return false;
  }
  if (!out_stripped.is_object()) {
    err = "Uber JSON: root must be an object";
    return false;
  }
  if (out_stripped.contains("lab")) {
    out_stripped.erase("lab");
  }
  return true;
}

}  // namespace

static std::int64_t rough_date_key(std::string const& s) {
  if (s.size() < 10) {
    return 0;
  }
  int y = 0, mo = 0, d = 0;
  if (std::sscanf(s.c_str(), "%d-%d-%d", &y, &mo, &d) != 3) {
    return 0;
  }
  return static_cast<std::int64_t>(y) * 10000LL + static_cast<std::int64_t>(mo) * 100LL + d;
}

bool HostState::apply_uber_config(std::string& err) {
  err.clear();
  std::string const& src = m_uber_config_json.empty() ? std::string(kDefaultUberConfig) : m_uber_config_json;
  json                     stripped;
  if (!json_for_node_system(src, stripped, err)) {
    return false;
  }
  m_primary_overlay.clear();
  try {
    json full = json::parse(src);
    if (full.is_object() && full.contains("lab") && full["lab"].is_object() && full["lab"].contains("primary_overlay")
        && full["lab"]["primary_overlay"].is_string()) {
      m_primary_overlay = full["lab"]["primary_overlay"].get<std::string>();
    }
  } catch (...) {
  }

  m_node_system = otl::OtlNodeSystem{};
  if (!m_node_system.load_from_string(stripped.dump())) {
    err = m_node_system.last_error();
    return false;
  }
  if (m_bars > 0 && !m_close0.empty()) {
    set_playhead(m_universe.bar());
  }
  return true;
}

bool HostState::set_uber_signal_json(std::string json, std::string& err) {
  trim(json);
  m_uber_config_json = std::move(json);
  if (m_bars <= 0 || m_path.empty()) {
    err.clear();
    return true;  // applied when the next CSV loads
  }
  return apply_uber_config(err);
}

bool HostState::set_portfolio_json(std::string json_in, std::string& err) {
  err.clear();
  trim(json_in);
  if (json_in.empty()) {
    err = "empty portfolio json";
    return false;
  }
  try {
    json const jin = json::parse(json_in);
    if (!jin.is_object()) {
      err = "portfolio json must be an object";
      return false;
    }
  } catch (std::exception const& e) {
    err = e.what();
    return false;
  }
  m_portfolio_config_json = std::move(json_in);
  return true;
}

bool HostState::load_data(std::string const& path, std::string& err) {
  err.clear();
  m_bar_labels.clear();
  m_close0.clear();
  m_path.clear();
  m_bars   = 0;
  m_portfolio_config_json.clear();
  m_osl_shader_dir_init.clear();
  m_osl_m1.reset();
  m_universe = otl::OtlUniverse{};

  std::ifstream f(path, std::ios::in);
  if (!f) {
    err = "cannot open file";
    return false;
  }
  std::string line;
  if (!std::getline(f, line)) {
    err = "empty file";
    return false;
  }
  auto const header = split_csv_line(line);
  if (header.size() < 2) {
    err = "bad header";
    return false;
  }
  while (std::getline(f, line)) {
    if (line.empty()) {
      continue;
    }
    std::vector<std::string> row = split_csv_line(line);
    if (row.size() < 2) {
      continue;
    }
    std::string lab = row[0];
    trim(lab);
    m_bar_labels.push_back(lab);
    m_close0.push_back(std::strtod(row[1].c_str(), nullptr));
  }
  f.close();

  int b = 0;
  if (!otl::data::load_universe_close_matrix(path, m_universe, b)) {
    err = "load_universe_close_matrix failed";
    m_bar_labels.clear();
    m_close0.clear();
    m_bars = 0;
    m_osl_shader_dir_init.clear();
    m_osl_m1.reset();
    return false;
  }
  m_bars  = b;
  m_path  = path;
  m_node_system = otl::OtlNodeSystem{};
  if (!apply_uber_config(err)) {
    m_bar_labels.clear();
    m_close0.clear();
    m_bars = 0;
    m_osl_shader_dir_init.clear();
    m_osl_m1.reset();
    m_universe = otl::OtlUniverse{};
    return false;
  }
  set_playhead(m_bars > 0 ? m_bars - 1 : 0);
  return true;
}

int HostState::find_bar_index_for_seek(std::string const& time_token) const {
  std::string t = time_token;
  trim(t);
  if (t.empty() || m_bars <= 0) {
    return -1;
  }
  for (std::size_t i = 0; i < m_bar_labels.size(); ++i) {
    if (m_bar_labels[i] == t) {
      return static_cast<int>(i);
    }
  }
  char*         e   = nullptr;
  long const idx = std::strtol(t.c_str(), &e, 10);
  if (e && e != t.c_str() && *e == 0) {
    if (idx >= 0 && idx < m_bars) {
      return static_cast<int>(idx);
    }
  }
  std::int64_t const want = rough_date_key(t);
  if (want > 0) {
    int          best  = 0;
    std::int64_t bestd = 0;
    for (int i = 0; i < m_bars; ++i) {
      std::int64_t d = rough_date_key(m_bar_labels[static_cast<std::size_t>(i)]);
      if (d > bestd && d <= want) {
        bestd = d;
        best  = i;
      }
    }
    return best;
  }
  for (std::size_t i = 0; i < m_bar_labels.size(); ++i) {
    if (m_bar_labels[i].rfind(t, 0) == 0) {
      return static_cast<int>(i);
    }
  }
  return 0;
}

void HostState::set_playhead(int bar) {
  if (bar < 0) {
    bar = 0;
  }
  if (m_bars > 0 && bar >= m_bars) {
    bar = m_bars - 1;
  }
  m_universe.set_bar(bar);
  if (m_bars > 0 && !m_close0.empty()) {
    (void)m_node_system.apply_to_asset(m_universe, 0, m_close0);
  }
}

static json tail_num(std::vector<double> const& v, int from, int len) {
  json a = json::array();
  if (v.empty() || from < 0) {
    return a;
  }
  int const s  = static_cast<int>(v.size());
  int         i0 = from - len + 1;
  if (i0 < 0) {
    i0 = 0;
  }
  for (int i = i0; i <= from && i < s; ++i) {
    a.push_back(v[static_cast<std::size_t>(i)]);
  }
  return a;
}

static double vol_of_portfolio(int i, std::vector<double> const& closes, int win) {
  if (i < 1) {
    return 0.02;
  }
  int const a  = std::max(1, i - win + 1);
  double  mean = 0;
  int     cnt  = 0;
  for (int k = a; k <= i; ++k) {
    double pr = closes[static_cast<std::size_t>(k)] / closes[static_cast<std::size_t>(k - 1)] - 1.0;
    mean += pr;
    ++cnt;
  }
  if (cnt <= 0) {
    return 0.02;
  }
  mean /= static_cast<double>(cnt);
  double v = 0;
  for (int k = a; k <= i; ++k) {
    double pr = closes[static_cast<std::size_t>(k)] / closes[static_cast<std::size_t>(k - 1)] - 1.0;
    double d  = pr - mean;
    v += d * d;
  }
  double st = (cnt > 1) ? std::sqrt(v / static_cast<double>(cnt - 1)) : 0.0;
  if (st < 1e-4) {
    st = 1e-4;
  }
  return st;
}

static char const* kDefaultPortfolioCfg = R"({"method":"equal","leverage":1,"comm_bps":2,"slippage_bps":5})";

static json parse_portfolio_cfg_json(std::string const& cfg_json) {
  std::string const& use_s = cfg_json.empty() ? std::string(kDefaultPortfolioCfg) : cfg_json;
  try {
    return json::parse(use_s);
  } catch (...) {
    return json::parse(kDefaultPortfolioCfg);
  }
}

/// Shared PORT-CALC path: `eq_curve` / `dd_curve` length == `closes.size()`; max drawdown fraction in `max_dd_frac_out`.
static void simulate_portfolio_equity_on_closes(
    std::vector<double> const& closes,
    json const&                jc,
    std::vector<double>&         eq_curve,
    std::vector<double>&         dd_curve,
    double&                      max_dd_frac_out) {
  eq_curve.clear();
  dd_curve.clear();
  int const n = static_cast<int>(closes.size());
  if (n < 2) {
    max_dd_frac_out = 0.0;
    return;
  }
  std::string method = "equal";
  if (jc.contains("method") && jc["method"].is_string()) {
    method = jc["method"].get<std::string>();
  }
  double leverage = 1.0;
  if (jc.contains("leverage") && jc["leverage"].is_number()) {
    leverage = jc["leverage"].get<double>();
  }
  if (leverage < 0.25) {
    leverage = 0.25;
  }
  if (leverage > 5.0) {
    leverage = 5.0;
  }
  double comm_bps = 2.0;
  double slip_bps = 5.0;
  if (jc.contains("comm_bps") && jc["comm_bps"].is_number()) {
    comm_bps = jc["comm_bps"].get<double>();
  }
  if (jc.contains("slippage_bps") && jc["slippage_bps"].is_number()) {
    slip_bps = jc["slippage_bps"].get<double>();
  }
  if (comm_bps < 0) {
    comm_bps = 0;
  }
  if (slip_bps < 0) {
    slip_bps = 0;
  }
  int const           vol_win = 20;
  double                peak  = 100.0;
  double                eq    = 100.0;
  double                max_d = 0.0;
  eq_curve.push_back(100.0);
  dd_curve.push_back(0.0);
  for (int i = 1; i < n; ++i) {
    double r         = closes[static_cast<std::size_t>(i)] / closes[static_cast<std::size_t>(i - 1)] - 1.0;
    double v         = vol_of_portfolio(i - 1, closes, vol_win);
    double exp       = leverage;
    if (method == "strength") {
      double s = 0.5 + std::min(1.2, std::abs(r) * 100.0);
      exp    = std::min(leverage * 1.5, std::max(leverage * 0.3, (leverage * s) / 1.2));
    } else if (method == "risk") {
      double const target = 0.12;
      exp                 = (leverage * target) / std::max(1e-4, v * std::sqrt(252.0));
      exp                 = std::min(leverage * 1.5, std::max(leverage * 0.25, exp));
    }
    double fric_bps    = comm_bps * 0.1 + slip_bps * std::min(1.0, std::abs(r) * 12.0);
    double d_eq        = r * exp - fric_bps / 10000.0;
    eq                 = eq * (1.0 + d_eq);
    if (eq > peak) {
      peak = eq;
    }
    double ddp = (peak > 0) ? (peak - eq) / peak : 0.0;
    if (ddp > max_d) {
      max_d = ddp;
    }
    eq_curve.push_back(eq);
    dd_curve.push_back(ddp);
  }
  max_dd_frac_out = max_d;
}

static void fill_portfolio_stats_from_eq_curve(
    std::vector<double> const& eq_curve,
    double                      max_dd_frac,
    json&                      stats) {
  int const     n  = static_cast<int>(eq_curve.size());
  double        eq = 100.0;
  if (n > 0) {
    eq = eq_curve[static_cast<std::size_t>(n - 1)];
  }
  std::vector<double> d_ret;
  for (int i = 1; i < n; ++i) {
    double a = eq_curve[static_cast<std::size_t>(i)];
    double b = eq_curve[static_cast<std::size_t>(i - 1)];
    d_ret.push_back(b > 0 ? a / b - 1.0 : 0.0);
  }
  double m = 0;
  for (double x : d_ret) {
    m += x;
  }
  if (!d_ret.empty()) {
    m /= static_cast<double>(d_ret.size());
  }
  double var_sum = 0;
  for (double x : d_ret) {
    double d = x - m;
    var_sum += d * d;
  }
  int const dz  = static_cast<int>(d_ret.size());
  double    st  = (dz > 1) ? std::sqrt(var_sum / static_cast<double>(dz - 1)) : 0.0;
  std::vector<double> neg;
  for (double x : d_ret) {
    if (x < 0) {
      neg.push_back(x);
    }
  }
  int const nn  = static_cast<int>(neg.size());
  double d_varr = 0;
  for (double x : neg) {
    d_varr += x * x;
  }
  double d_st  = (nn > 1) ? std::sqrt(d_varr / static_cast<double>(nn - 1)) : 0.0;
  double sharpe = (st > 1e-12) ? (m / st) * std::sqrt(252.0) : 0.0;
  double sortv  = (d_st > 1e-12) ? (m / d_st) * std::sqrt(252.0) : 0.0;
  double pos    = 0;
  double neg_a  = 0;
  for (double x : d_ret) {
    if (x > 0) {
      pos += x;
    }
    if (x < 0) {
      neg_a += x;
    }
  }
  double profit_factor = 0;
  if (neg_a < -1e-12) {
    profit_factor = pos / -neg_a;
  } else if (pos > 0) {
    profit_factor = 99.99;
  }
  int win = 0;
  for (double x : d_ret) {
    if (x > 0) {
      ++win;
    }
  }
  double win_rate = (!d_ret.empty()) ? (100.0 * static_cast<double>(win) / static_cast<double>(d_ret.size())) : 0.0;

  double total_return_pct   = (eq / 100.0 - 1.0) * 100.0;
  double max_drawdown_pct   = max_dd_frac * 100.0;
  double pnl_tail_end_pct   = (eq / 100.0 - 1.0) * 100.0;
  double years              = (n > 1) ? static_cast<double>(n - 1) / 252.0 : 0.0;
  double cagr_pct           = 0.0;
  if (years > 1e-6 && eq > 0) {
    cagr_pct = (std::pow(eq / 100.0, 1.0 / years) - 1.0) * 100.0;
  }
  stats["total_return_pct"]   = total_return_pct;
  stats["max_drawdown_pct"]   = max_drawdown_pct;
  stats["sharpe"]             = sharpe;
  stats["sortino"]            = sortv;
  stats["profit_factor"]      = profit_factor;
  stats["pnl_tail_end_pct"]   = pnl_tail_end_pct;
  stats["cagr_pct"]           = cagr_pct;
  stats["win_rate_pct"]       = win_rate;
  stats["n_periods"]          = static_cast<int>(d_ret.size());
}

/// Host-computed portfolio series for SEEK. Electron renders `telemetry.portfolio` as-is.
static void append_portfolio_telemetry(json& telem, std::string const& cfg_json) {
  if (!telem.contains("close_tail") || !telem["close_tail"].is_array()) {
    return;
  }
  json const& cj = telem["close_tail"];
  std::vector<double> closes;
  closes.reserve(cj.size());
  for (auto const& x : cj) {
    if (x.is_number()) {
      closes.push_back(x.get<double>());
    }
  }
  int const n = static_cast<int>(closes.size());
  if (n < 2) {
    return;
  }
  json   jc  = parse_portfolio_cfg_json(cfg_json);
  double mxd = 0;
  std::vector<double> eq_curve;
  std::vector<double> dd_curve;
  simulate_portfolio_equity_on_closes(closes, jc, eq_curve, dd_curve, mxd);

  json   stats = json::object();
  fill_portfolio_stats_from_eq_curve(eq_curve, mxd, stats);

  json j_eq = json::array();
  json j_dd = json::array();
  for (double e : eq_curve) {
    j_eq.push_back(e);
  }
  for (double d : dd_curve) {
    j_dd.push_back(d);
  }

  json port = json::object();
  port["equity_tail"]   = std::move(j_eq);
  port["drawdown_tail"] = std::move(j_dd);
  port["stats"]         = std::move(stats);
  telem["portfolio"]    = std::move(port);
}

static std::string pick_signal_m_attr(otl::OtlNodeSystem const& ns) {
  for (auto const& in : ns.indicator_nodes()) {
    if (in.m_attr.rfind("m_rsi", 0) == 0) {
      return in.m_attr;
    }
  }
  for (auto const& in : ns.indicator_nodes()) {
    return in.m_attr;
  }
  return "m_rsi_14";
}

static void append_analysis_telemetry(
    json&                      telem,
    int                        playhead,
    std::vector<double> const& m_close0,
    std::vector<std::string> const& m_bar_labels,
    std::string const&         m_portfolio_config_json,
    otl::OtlUniverse const&    u,
    otl::OtlNodeSystem const&  ns) {
  if (m_close0.size() < 2 || playhead < 0) {
    return;
  }
  int const bmax = static_cast<int>(m_close0.size()) - 1;
  int         b  = playhead;
  if (b > bmax) {
    b = bmax;
  }
  std::vector<double> closes(m_close0.begin(), m_close0.begin() + static_cast<std::size_t>(b) + 1U);
  int const n = static_cast<int>(closes.size());
  if (n < 2) {
    return;
  }
  json  jc  = parse_portfolio_cfg_json(m_portfolio_config_json);
  double mxd = 0;
  std::vector<double> eq_curve;
  std::vector<double> dd_curve;
  simulate_portfolio_equity_on_closes(closes, jc, eq_curve, dd_curve, mxd);

  std::vector<double> bh(n, 100.0);
  for (int i = 1; i < n; ++i) {
    double prev = closes[static_cast<std::size_t>(i - 1)];
    double c    = closes[static_cast<std::size_t>(i)];
    if (prev > 1e-12) {
      bh[static_cast<std::size_t>(i)] = bh[static_cast<std::size_t>(i - 1)] * (c / prev);
    } else {
      bh[static_cast<std::size_t>(i)] = bh[static_cast<std::size_t>(i - 1)];
    }
  }

  std::string const sig_attr = pick_signal_m_attr(ns);
  std::vector<double> const* sig_ser = nullptr;
  (void)u.try_get_m_series(0, sig_attr, &sig_ser);
  if (!sig_ser || sig_ser->size() < m_close0.size()) {
    sig_ser = nullptr;
  }
  double weight_scalar = 1.0;
  if (jc.contains("leverage") && jc["leverage"].is_number()) {
    weight_scalar = jc["leverage"].get<double>();
  }

  json summary = json::object();
  fill_portfolio_stats_from_eq_curve(eq_curve, mxd, summary);
  double bh_tr = (bh[static_cast<std::size_t>(n - 1)] / 100.0 - 1.0) * 100.0;
  summary["buy_hold_total_return_pct"] = bh_tr;

  int const   kTailLen = 32;
  int         i0       = b - kTailLen + 1;
  if (i0 < 0) {
    i0 = 0;
  }
  json        jw = json::array();
  json        jb = json::array();
  for (int i = i0; i <= b; ++i) {
    jw.push_back(eq_curve[static_cast<std::size_t>(i)]);
    jb.push_back(bh[static_cast<std::size_t>(i)]);
  }
  telem["analysis"]                = json::object();
  telem["analysis"]["signal_attr"]   = sig_attr;
  telem["analysis"]["summary"]       = std::move(summary);
  telem["analysis"]["wealth_tail"]   = jw;
  telem["analysis"]["buy_hold_tail"] = jb;

  // Preview table (last 48 rows up to playhead)
  int const prev_n = 48;
  int       p0     = b - (prev_n - 1);
  if (p0 < 0) {
    p0 = 0;
  }
  json prev = json::array();
  for (int i = p0; i <= b; ++i) {
    std::string ts;
    if (i < static_cast<int>(m_bar_labels.size())) {
      ts = m_bar_labels[static_cast<std::size_t>(i)];
    }
    double pr = closes[static_cast<std::size_t>(i)];
    double sg = 0.0;
    if (sig_ser && i < static_cast<int>(sig_ser->size())) {
      sg = (*sig_ser)[static_cast<std::size_t>(i)];
    }
    double wgt = weight_scalar;
    double dret  = 0.0;
    if (i > 0) {
      double pa = eq_curve[static_cast<std::size_t>(i - 1)];
      double cu = eq_curve[static_cast<std::size_t>(i)];
      dret     = (pa > 1e-12) ? 100.0 * (cu / pa - 1.0) : 0.0;
    }
    double cwl = eq_curve[static_cast<std::size_t>(i)];
    double ddw = 100.0 * dd_curve[static_cast<std::size_t>(i)];
    json row   = json::object();
    row["bar"]     = i;
    row["timestamp"] = ts;
    row["price"]   = pr;
    row["signal"]  = sg;
    row["weight"]  = wgt;
    row["daily_return_pct"] = dret;
    row["cumulative_wealth"]  = cwl;
    row["drawdown_pct"]  = ddw;
    prev.push_back(std::move(row));
  }
  telem["analysis"]["preview"]                  = std::move(prev);
  telem["analysis"]["preview_start_bar"]       = p0;
  telem["analysis"]["preview_playhead_index"]  = b - p0;
}

void HostState::append_osl_m1_telemetry(json& telem, int playhead_bar) {
  (void)playhead_bar;
  char const* env = std::getenv("OTL_SHADER_DIR");
  if (env == nullptr || env[0] == '\0') {
    telem["osl_m1"] = json::object(
        {{"enabled", false},
         {"hint",
          "Set OTL_SHADER_DIR to a directory containing m1_alpha.oso (same M1 sample as OTL_Engine / OTL-Core)."}});
    return;
  }
  std::string const dir(env);
  if (!m_osl_m1) {
    m_osl_m1 = std::make_unique<OslM1Shading>();
  }
  if (m_osl_shader_dir_init != dir || !m_osl_m1->is_ready()) {
    m_osl_m1->clear();
    std::string ie;
    if (!m_osl_m1->try_init(dir, ie)) {
      telem["osl_m1"] =
          json::object({{"enabled", true}, {"init_ok", false}, {"shader_dir", dir}, {"error", ie}});
      m_osl_shader_dir_init.clear();
      return;
    }
    m_osl_shader_dir_init = dir;
  }
  std::string ee;
  json         oj;
  if (m_osl_m1->execute(m_universe, 0, oj, ee)) {
    oj["enabled"]    = true;
    oj["init_ok"]    = true;
    oj["shader_dir"] = dir;
    telem["osl_m1"]  = std::move(oj);
  } else {
    telem["osl_m1"]  = json::object({{"enabled", true},
                                    {"init_ok", true},
                                    {"shader_dir", dir},
                                    {"executed", false},
                                    {"error", ee},
                                    {"detail", oj}});
  }
}

static void fill_node_states(otl::OtlUniverse const& u, otl::OtlNodeSystem const& ns, json& out) {
  out            = json::object();
  float     v    = 0;
  if (u.try_get_m(0, "m_close", false, &v)) {
    out["m_close"] = v;
  } else {
    std::string const& src = ns.source_m_attr();
    if (u.try_get_m(0, src.c_str(), false, &v)) {
      out[src] = v;
    }
  }
  for (auto const& in : ns.indicator_nodes()) {
    v = 0;
    if (u.try_get_m(0, in.m_attr.c_str(), false, &v)) {
      out[in.m_attr] = v;
    }
  }
  out["map_from"] = "OtlNodeSystem+VectorTA";
}

std::string HostState::seek_json(std::string const& time_token) {
  if (m_bars <= 0) {
    return R"({"error":"no data loaded"})";
  }
  int b = find_bar_index_for_seek(time_token);
  if (b < 0) {
    b = 0;
  }
  set_playhead(b);

  json j;
  j["bar"] = b;
  j["bar_label"] =
      (b < static_cast<int>(m_bar_labels.size())) ? json(m_bar_labels[static_cast<std::size_t>(b)]) : json(nullptr);
  j["wall_time"] = j["bar_label"];

  json       node_states;
  fill_node_states(m_universe, m_node_system, node_states);
  j["node_states"]    = std::move(node_states);
  {
    j["m_attrs_for_osl"]   = json::array();
    std::set<std::string>   seen;
    for (std::string const& s : m_node_system.shader_m_attrs()) {
      if (seen.insert(s).second) {
        j["m_attrs_for_osl"].push_back(s);
      }
    }
    for (auto const& in : m_node_system.indicator_nodes()) {
      if (seen.insert(in.m_attr).second) {
        j["m_attrs_for_osl"].push_back(in.m_attr);
      }
    }
  }

  float m_close = 0;
  m_universe.try_get_m(0, "m_close", false, &m_close);
  json telem = json::object({{"close_tail", tail_num(m_close0, b, 32)}, {"m_close", m_close}});
  for (auto const& in : m_node_system.indicator_nodes()) {
    float v = 0;
    if (m_universe.try_get_m(0, in.m_attr.c_str(), false, &v)) {
      telem[in.m_attr] = v;
    }
    std::vector<double> const* ser = nullptr;
    if (m_universe.try_get_m_series(0, in.m_attr, &ser) && ser != nullptr) {
      telem["tail_" + in.m_attr] = tail_num(*ser, b, 32);
    }
  }

  std::string shadow_key = m_primary_overlay;
  if (shadow_key.empty()) {
    for (auto const& in : m_node_system.indicator_nodes()) {
      if (in.indicator_id == "sma" || in.m_attr.rfind("m_sma", 0) == 0) {
        shadow_key = in.m_attr;
        break;
      }
    }
  }
  if (!shadow_key.empty()) {
    std::vector<double> const* ser = nullptr;
    if (m_universe.try_get_m_series(0, shadow_key, &ser) && ser != nullptr) {
      json sh = json::object();
      sh["m_attr"] = shadow_key;
      sh["tail"]   = tail_num(*ser, b, 32);
      j["shadow_overlay"] = sh;
    }
  }

  append_portfolio_telemetry(telem, m_portfolio_config_json);
  append_analysis_telemetry(
      telem, b, m_close0, m_bar_labels, m_portfolio_config_json, m_universe, m_node_system);
  append_osl_m1_telemetry(telem, b);
  j["telemetry"] = std::move(telem);
  j["bridge_heartbeat"] =
      json::object({{"host", "ok"}, {"vector_ta", "linked"}, {"cxx", "ok"}});
  return j.dump();
}

bool HostState::export_analysis_csv(std::string const& path, std::string& err) {
  err.clear();
  if (m_bars <= 0 || m_close0.empty() || m_close0.size() != static_cast<std::size_t>(m_bars)) {
    err = "no data loaded";
    return false;
  }
  set_playhead(m_bars - 1);
  json  jc  = parse_portfolio_cfg_json(m_portfolio_config_json);
  std::string const sig_attr = pick_signal_m_attr(m_node_system);
  std::vector<double> const* sig_ser = nullptr;
  (void)m_universe.try_get_m_series(0, sig_attr, &sig_ser);
  if (!sig_ser || sig_ser->size() < static_cast<std::size_t>(m_bars)) {
    sig_ser = nullptr;
  }
  double   mxd = 0;
  std::vector<double> eq_curve;
  std::vector<double> dd_curve;
  simulate_portfolio_equity_on_closes(m_close0, jc, eq_curve, dd_curve, mxd);
  if (static_cast<int>(eq_curve.size()) != m_bars) {
    err = "export: equity length mismatch";
    return false;
  }
  std::vector<double> bh(static_cast<std::size_t>(m_bars), 100.0);
  for (int i = 1; i < m_bars; ++i) {
    double prev = m_close0[static_cast<std::size_t>(i - 1)];
    double c    = m_close0[static_cast<std::size_t>(i)];
    if (prev > 1e-12) {
      bh[static_cast<std::size_t>(i)] = bh[static_cast<std::size_t>(i - 1)] * (c / prev);
    } else {
      bh[static_cast<std::size_t>(i)] = bh[static_cast<std::size_t>(i - 1)];
    }
  }
  double wgt = 1.0;
  if (jc.contains("leverage") && jc["leverage"].is_number()) {
    wgt = jc["leverage"].get<double>();
  }
  std::ofstream f(path, std::ios::out);
  if (!f) {
    err = "cannot open path for write";
    return false;
  }
  f.setf(std::ios::fixed);
  f << "Timestamp,Price,Signal,Weight,Daily_Return,Cumulative_Wealth,Drawdown\n";
  f << std::setprecision(10);
  for (int i = 0; i < m_bars; ++i) {
    std::string ts;
    if (i < static_cast<int>(m_bar_labels.size())) {
      ts = m_bar_labels[static_cast<std::size_t>(i)];
    }
    double pr = m_close0[static_cast<std::size_t>(i)];
    double sg = 0.0;
    if (sig_ser) {
      sg = (*sig_ser)[static_cast<std::size_t>(i)];
    }
    double dret = 0.0;
    if (i > 0) {
      double pa = eq_curve[static_cast<std::size_t>(i - 1)];
      double cu = eq_curve[static_cast<std::size_t>(i)];
      dret = (pa > 1e-12) ? 100.0 * (cu / pa - 1.0) : 0.0;
    }
    double cwl  = eq_curve[static_cast<std::size_t>(i)];
    double ddw  = 100.0 * dd_curve[static_cast<std::size_t>(i)];
    f << ts << ',' << pr << ',' << sg << ',' << wgt << ',' << dret << ',' << cwl << ',' << ddw;
    f << "\n";
  }
  f.close();
  if (!f) {
    err = "write failed";
    return false;
  }
  return true;
}

std::string HostState::load_data_json() {
  json j;
  j["ok"]   = true;
  j["path"] = m_path;
  j["bars"] = m_bars;
  if (!m_bar_labels.empty()) {
    j["time_range"] = json::object(
        {{"start", m_bar_labels.front()}, {"end", m_bar_labels.back()}});
  } else {
    j["time_range"] = nullptr;
  }
  j["assets"]            = m_universe.asset_count();
  j["bridge_heartbeat"]  = json::object(
      {{"host", "ok"},
       {"vector_ta", "linked"},
       {"cxx", "ok"}});
  try {
    j["uber_config_effective"] =
        m_uber_config_json.empty() ? json::parse(kDefaultUberConfig) : json::parse(m_uber_config_json);
  } catch (...) {
    j["uber_config_effective"] = json::parse(kDefaultUberConfig);
  }
  return j.dump();
}

}  // namespace mlab::host
