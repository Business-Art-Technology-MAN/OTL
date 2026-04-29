#include "mlab/HostState.hpp"
#include "mlab/TimelineAxisJson.hpp"

#include "otl/GaPortfolioIntegrator.hpp"
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

/// Reads `lab.primary_overlay` and `lab.osl_shader_dir` from the full Uber document (not stripped for `OtlNodeSystem`).
static void parse_lab_block_from_uber(
    std::string const& full_json, std::string& out_primary_overlay, std::string& out_osl_shader_dir) {
  out_primary_overlay.clear();
  out_osl_shader_dir.clear();
  try {
    json const full = json::parse(full_json);
    if (!full.is_object() || !full.contains("lab") || !full["lab"].is_object()) {
      return;
    }
    json const& lab = full["lab"];
    if (lab.contains("primary_overlay") && lab["primary_overlay"].is_string()) {
      out_primary_overlay = lab["primary_overlay"].get<std::string>();
    }
    if (lab.contains("osl_shader_dir") && lab["osl_shader_dir"].is_string()) {
      out_osl_shader_dir = lab["osl_shader_dir"].get<std::string>();
      trim(out_osl_shader_dir);
    }
  } catch (...) {
  }
}

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

static void gal_m1_invalidate_replay_cache(HostState& hs);

bool HostState::apply_uber_config(std::string& err) {
  err.clear();
  std::string const& src = m_uber_config_json.empty() ? std::string(kDefaultUberConfig) : m_uber_config_json;
  json                     stripped;
  if (!json_for_node_system(src, stripped, err)) {
    return false;
  }
  parse_lab_block_from_uber(src, m_primary_overlay, m_osl_shader_dir_override);

  m_node_system = otl::OtlNodeSystem{};
  if (!m_node_system.load_from_string(stripped.dump())) {
    err = m_node_system.last_error();
    return false;
  }
  if (m_bars > 0 && (!m_close0.empty() || !m_asset_closes.empty())) {
    set_playhead(m_universe.bar());
  }
  gal_m1_invalidate_replay_cache(*this);
  return true;
}

bool HostState::set_uber_signal_json(std::string json, std::string& err) {
  trim(json);
  m_uber_config_json = std::move(json);
  if (m_bars <= 0 || m_path.empty()) {
    std::string const src = m_uber_config_json.empty() ? std::string(kDefaultUberConfig) : m_uber_config_json;
    parse_lab_block_from_uber(src, m_primary_overlay, m_osl_shader_dir_override);
    err.clear();
    return true;  // `OtlNodeSystem` bakes on next `LOAD_DATA`
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
  gal_m1_invalidate_replay_cache(*this);
  return true;
}

bool HostState::load_data(std::string const& path, std::string& err) {
  err.clear();
  gal_m1_invalidate_replay_cache(*this);
  m_bar_labels.clear();
  m_asset_column_labels.clear();
  m_asset_closes.clear();
  m_close0.clear();
  m_path.clear();
  m_bars   = 0;
  m_portfolio_config_json.clear();
  m_osl_shader_dir_override.clear();
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
  m_asset_column_labels.clear();
  for (std::size_t ci = 1; ci < header.size(); ++ci) {
    std::string col = header[ci];
    trim(col);
    m_asset_column_labels.push_back(std::move(col));
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
    m_asset_column_labels.clear();
    m_asset_closes.clear();
    m_close0.clear();
    m_bars = 0;
    m_osl_shader_dir_init.clear();
    m_osl_m1.reset();
    return false;
  }
  m_bars  = b;
  m_path  = path;
  m_asset_closes.clear();
  {
    int const na = m_universe.asset_count();
    m_asset_closes.resize(static_cast<std::size_t>(std::max(0, na)));
    for (int a = 0; a < na; ++a) {
      std::vector<double> const* ser = nullptr;
      if (m_universe.try_get_m_series(a, "m_close", &ser) && ser != nullptr && !ser->empty()) {
        m_asset_closes[static_cast<std::size_t>(a)] = *ser;
      }
    }
    if (na >= 1 && !m_asset_closes[0].empty()) {
      m_close0 = m_asset_closes[0];
    }
  }
  m_node_system = otl::OtlNodeSystem{};
  if (!apply_uber_config(err)) {
    m_bar_labels.clear();
    m_asset_column_labels.clear();
    m_asset_closes.clear();
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

static void host_apply_node_system_to_all_assets(HostState& hs) {
  if (hs.m_bars <= 0) {
    return;
  }
  int const na = hs.m_universe.asset_count();
  for (int a = 0; a < na; ++a) {
    if (a < static_cast<int>(hs.m_asset_closes.size())
        && !hs.m_asset_closes[static_cast<std::size_t>(a)].empty()
        && static_cast<int>(hs.m_asset_closes[static_cast<std::size_t>(a)].size()) == hs.m_bars) {
      (void)hs.m_node_system.apply_to_asset(
          hs.m_universe, a, hs.m_asset_closes[static_cast<std::size_t>(a)]);
    } else if (a == 0 && !hs.m_close0.empty() && static_cast<int>(hs.m_close0.size()) == hs.m_bars) {
      (void)hs.m_node_system.apply_to_asset(hs.m_universe, 0, hs.m_close0);
    }
  }
}

void HostState::set_playhead(int bar) {
  if (bar < 0) {
    bar = 0;
  }
  if (m_bars > 0 && bar >= m_bars) {
    bar = m_bars - 1;
  }
  m_universe.set_bar(bar);
  host_apply_node_system_to_all_assets(*this);
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

/// Extract doubles from JSON array produced by `tail_num`-style payloads.
static bool json_array_to_double_vec(json const& a, std::vector<double>& out) {
  out.clear();
  if (!a.is_array()) {
    return false;
  }
  out.reserve(a.size());
  for (auto const& x : a) {
    if (!x.is_number()) {
      return false;
    }
    out.push_back(x.get<double>());
  }
  return true;
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

static char const* kDefaultPortfolioCfg = R"({"integrator":"close_proxy","method":"equal","leverage":1,"comm_bps":2,"slippage_bps":5})";

static json parse_portfolio_cfg_json(std::string const& cfg_json) {
  std::string const& use_s = cfg_json.empty() ? std::string(kDefaultPortfolioCfg) : cfg_json;
  try {
    return json::parse(use_s);
  } catch (...) {
    return json::parse(kDefaultPortfolioCfg);
  }
}

/// `"close_proxy"` (default) or `"gal_m1"` — GAL+OSL replay from bar 0..playhead (see execution clock in docs).
static std::string get_portfolio_integrator(json const& jc) {
  if (jc.contains("integrator") && jc["integrator"].is_string()) {
    return jc["integrator"].get<std::string>();
  }
  return "close_proxy";
}

/// Scalar exposure in [0,1] from one M1 OSL JSON (`fix_signal`): used as intent on the active asset.
static double osl_m1_fix_signal_scalar(json const& oj) {
  bool ok = oj.is_object() && oj.value("executed", false);
  if (!ok || !oj.contains("fix_signal") || !oj["fix_signal"].is_object()) {
    return 0.0;
  }
  json const& fs = oj["fix_signal"];
  double       side = 0.0;
  double       qty  = 0.0;
  if (fs.contains("side") && fs["side"].is_number()) {
    side = fs["side"].get<double>();
  }
  if (fs.contains("quantity") && fs["quantity"].is_number()) {
    qty = fs["quantity"].get<double>();
  }
  double const a = 0.5 + 0.5 * std::max(-1.0, std::min(1.0, side)) * (1.0 - std::exp(-std::abs(qty) * 0.01));
  return std::max(0.0, std::min(1.0, a));
}

/// Map M1 OSL `fix_signal` to a 1-vector **intent** (backward compat: only asset 0 populated from one JSON).
static std::vector<double> osl_m1_intent_from_json(json const& oj, int n) {
  std::vector<double> v(std::max(0, n), 0.0);
  if (n > 0) {
    v[0] = osl_m1_fix_signal_scalar(oj);
  }
  return v;
}

/// Full intent vector from per-asset OSL executes (N-asset GAL).
static std::vector<double> osl_m1_intent_from_per_asset_json(std::vector<json> const& per, int n) {
  std::vector<double> v(std::max(0, n), 0.0);
  int const ntake = std::min(n, static_cast<int>(per.size()));
  for (int a = 0; a < ntake; ++a) {
    v[static_cast<std::size_t>(a)] = osl_m1_fix_signal_scalar(per[static_cast<std::size_t>(a)]);
  }
  return v;
}

struct GalM1M2Config {
  double    alpha{0.6};
  double    beta{0.4};
  double    biv_lambda{0.99};
  double    degrees{2.0};
  double    cash{0.0};
  std::size_t i_rot{0};
  std::size_t j_rot{1};
};

static void load_m2_config(json const& jc, GalM1M2Config& out) {
  if (!jc.contains("m2") || !jc["m2"].is_object()) {
    return;
  }
  json const& m2 = jc["m2"];
  if (m2.contains("alpha") && m2["alpha"].is_number()) {
    out.alpha = m2["alpha"].get<double>();
  }
  if (m2.contains("beta") && m2["beta"].is_number()) {
    out.beta = m2["beta"].get<double>();
  }
  if (m2.contains("biv_lambda") && m2["biv_lambda"].is_number()) {
    out.biv_lambda = m2["biv_lambda"].get<double>();
  }
  if (m2.contains("degrees") && m2["degrees"].is_number()) {
    out.degrees = m2["degrees"].get<double>();
  }
  if (m2.contains("cash_friction") && m2["cash_friction"].is_number()) {
    out.cash = m2["cash_friction"].get<double>();
  }
  if (m2.contains("i_rot") && m2["i_rot"].is_number_unsigned()) {
    out.i_rot = m2["i_rot"].get<std::size_t>();
  }
  if (m2.contains("j_rot") && m2["j_rot"].is_number_unsigned()) {
    out.j_rot = m2["j_rot"].get<std::size_t>();
  }
}

/// After `begin_bar` + M1 OSL `execute` at this bar, blend intent with momentum, then `commit_post_gal`
/// (SRD: delegate lookup happens inside OSL; this is step 5 only).
static void gal_m1_rebalance_and_commit(
    otl::OtlUniverse&          u,
    std::vector<double> const& osl_intent,
    GalM1M2Config const&       m2,
    otl::RiskModel&            risk_empty) {
  int const  n  = u.asset_count();
  if (n <= 0) {
    return;
  }
  if (static_cast<int>(osl_intent.size()) != n) {
    return;
  }
  std::vector<double> mom = u.current_portfolio();
  if (n == 1) {
    std::vector<double> blended =
        otl::blend_intent_momentum(osl_intent, mom, m2.alpha, m2.beta);
    double w0 = 0.5;
    if (!blended.empty()) {
      w0 = std::max(0.0, std::min(1.0, blended[0]));
    }
    u.set_velocity_bivector(std::vector<double>{});
    u.commit_post_gal({w0});
    return;
  }
  std::size_t ir = m2.i_rot;
  std::size_t jr = m2.j_rot;
  if (jr >= static_cast<std::size_t>(n) || ir >= static_cast<std::size_t>(n) || ir == jr) {
    ir = 0;
    jr = (n > 1) ? 1u : 0u;
  }
  std::vector<double> w = otl::rebalance_m2(
      osl_intent, mom, risk_empty, ir, jr, m2.degrees, m2.alpha, m2.beta);
  if (m2.cash > 0.0) {
    otl::apply_cash_friction_1vector(w, n, m2.cash);
  }
  std::vector<double> biv = otl::wedge_1vector(w, mom);
  otl::dampen_bivector(biv, m2.biv_lambda);
  u.set_velocity_bivector(std::move(biv));
  u.commit_post_gal(std::move(w));
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

/// Multi-asset PORT-CALC (`close_proxy`): aligned per-asset tails; EW return for `equal`/`strength`; inverse-vol weights + EW synth vol for `risk`.
static void simulate_portfolio_equity_on_closes_multi(
    std::vector<std::vector<double>> const& closes_by_asset,
    json const&                                jc,
    std::vector<double>&                       eq_curve,
    std::vector<double>&                       dd_curve,
    double&                                    max_dd_frac_out) {
  eq_curve.clear();
  dd_curve.clear();
  int const na = static_cast<int>(closes_by_asset.size());
  if (na < 2) {
    max_dd_frac_out = 0.0;
    return;
  }
  int const T = static_cast<int>(closes_by_asset[0].size());
  for (int a = 1; a < na; ++a) {
    if (static_cast<int>(closes_by_asset[static_cast<std::size_t>(a)].size()) != T) {
      max_dd_frac_out = 0.0;
      return;
    }
  }
  if (T < 2) {
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
  leverage = std::max(0.25, std::min(5.0, leverage));
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
  int const vol_win = 20;

  /// Equal-weight synthetic price path (for `risk` target vol scaling).
  std::vector<double> synth(T, 100.0);
  for (int i = 1; i < T; ++i) {
    double ew_r = 0.0;
    for (int a = 0; a < na; ++a) {
      auto const& C = closes_by_asset[static_cast<std::size_t>(a)];
      double      c0 = C[static_cast<std::size_t>(i - 1)];
      double      c1 = C[static_cast<std::size_t>(i)];
      ew_r += (c0 > 1e-12) ? (c1 / c0 - 1.0) : 0.0;
    }
    ew_r /= static_cast<double>(na);
    synth[static_cast<std::size_t>(i)] = synth[static_cast<std::size_t>(i - 1)] * (1.0 + ew_r);
  }

  double peak = 100.0;
  double eq   = 100.0;
  double max_d = 0.0;
  eq_curve.push_back(100.0);
  dd_curve.push_back(0.0);
  for (int i = 1; i < T; ++i) {
    double ew_r = 0.0;
    for (int a = 0; a < na; ++a) {
      auto const& C = closes_by_asset[static_cast<std::size_t>(a)];
      double      c0 = C[static_cast<std::size_t>(i - 1)];
      double      c1 = C[static_cast<std::size_t>(i)];
      ew_r += (c0 > 1e-12) ? (c1 / c0 - 1.0) : 0.0;
    }
    ew_r /= static_cast<double>(na);

    double v_synth = vol_of_portfolio(i - 1, synth, vol_win);
    double exp     = leverage;
    if (method == "strength") {
      double s = 0.5 + std::min(1.2, std::abs(ew_r) * 100.0);
      exp = std::min(leverage * 1.5, std::max(leverage * 0.3, (leverage * s) / 1.2));
    } else if (method == "risk") {
      double const target = 0.12;
      exp = (leverage * target) / std::max(1e-4, v_synth * std::sqrt(252.0));
      exp = std::min(leverage * 1.5, std::max(leverage * 0.25, exp));
    }

    double r_port = ew_r;
    if (method == "risk") {
      double inv_sum = 0.0;
      std::vector<double> inv(na, 0.0);
      for (int a = 0; a < na; ++a) {
        auto const& C   = closes_by_asset[static_cast<std::size_t>(a)];
        double      va  = vol_of_portfolio(i - 1, C, vol_win);
        double      inva = 1.0 / std::max(1e-6, va);
        inv[static_cast<std::size_t>(a)] = inva;
        inv_sum += inva;
      }
      r_port = 0.0;
      if (inv_sum > 1e-12) {
        for (int a = 0; a < na; ++a) {
          auto const& C = closes_by_asset[static_cast<std::size_t>(a)];
          double      c0 = C[static_cast<std::size_t>(i - 1)];
          double      c1 = C[static_cast<std::size_t>(i)];
          double      ra = (c0 > 1e-12) ? (c1 / c0 - 1.0) : 0.0;
          r_port += (inv[static_cast<std::size_t>(a)] / inv_sum) * ra;
        }
      }
    }

    double fric_bps = comm_bps * 0.1 + slip_bps * std::min(1.0, std::abs(ew_r) * 12.0);
    double d_eq     = r_port * exp - fric_bps / 10000.0;
    eq              = eq * (1.0 + d_eq);
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
static void append_portfolio_telemetry(
    json& telem, HostState const& hs, int playhead_b, std::string const& cfg_json) {
  {
    json const jc = parse_portfolio_cfg_json(cfg_json);
    if (get_portfolio_integrator(jc) == "gal_m1" && telem.contains("portfolio")
        && telem["portfolio"].is_object() && telem["portfolio"].contains("equity_tail_gal")) {
      return;
    }
  }
  if (!telem.contains("close_tail") || !telem["close_tail"].is_array()) {
    return;
  }
  json const& cj   = telem["close_tail"];
  int const   tl   = static_cast<int>(cj.size());
  json        jc   = parse_portfolio_cfg_json(cfg_json);
  double       mxd  = 0;
  std::vector<double> eq_curve;
  std::vector<double> dd_curve;

  int const n_ast = hs.m_universe.asset_count();
  bool      use_multi =
      (n_ast > 1) && tl >= 2 && playhead_b >= 0
      && static_cast<int>(hs.m_asset_closes.size()) >= n_ast
      && !hs.m_close0.empty();
  if (use_multi) {
    for (int a = 0; a < n_ast; ++a) {
      auto const& ac = hs.m_asset_closes[static_cast<std::size_t>(a)];
      if (static_cast<int>(ac.size()) != static_cast<int>(hs.m_close0.size())) {
        use_multi = false;
        break;
      }
    }
  }
  if (use_multi) {
    std::vector<std::vector<double>> C;
    C.reserve(static_cast<std::size_t>(n_ast));
    for (int a = 0; a < n_ast; ++a) {
      json jt = tail_num(hs.m_asset_closes[static_cast<std::size_t>(a)], playhead_b, tl);
      std::vector<double> col;
      if (!json_array_to_double_vec(jt, col) || static_cast<int>(col.size()) < 2) {
        use_multi = false;
        break;
      }
      C.push_back(std::move(col));
    }
    if (use_multi) {
      simulate_portfolio_equity_on_closes_multi(C, jc, eq_curve, dd_curve, mxd);
    }
  }
  if (!use_multi) {
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
    simulate_portfolio_equity_on_closes(closes, jc, eq_curve, dd_curve, mxd);
  }

  if (eq_curve.size() < 2) {
    return;
  }

  json stats = json::object();
  fill_portfolio_stats_from_eq_curve(eq_curve, mxd, stats);
  if (n_ast > 1 && use_multi) {
    stats["close_proxy_multi_asset"] = true;
  }

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

static int analysis_asset_index_from_portfolio(json const& jc, int n_assets) {
  if (n_assets <= 1) {
    return 0;
  }
  json::const_iterator it = jc.find("analysis_asset_index");
  if (it == jc.end() || !(it->is_number())) {
    return 0;
  }
  try {
    int const a = static_cast<int>(std::lround(it->get<double>()));
    if (a < 0) {
      return 0;
    }
    return (a >= n_assets) ? (n_assets - 1) : a;
  } catch (...) {
    return 0;
  }
}

static void append_analysis_telemetry(
    json&                       telem,
    int                         playhead,
    HostState const&            hs,
    otl::OtlNodeSystem const&   ns) {
  json                      jc         = parse_portfolio_cfg_json(hs.m_portfolio_config_json);
  otl::OtlUniverse const& u = hs.m_universe;
  int                       n_ast       = std::max(1, u.asset_count());
  int const                 a_ix        = analysis_asset_index_from_portfolio(jc, n_ast);
  std::vector<double> const* prim_close = nullptr;
  if (a_ix >= 0 && a_ix < static_cast<int>(hs.m_asset_closes.size())) {
    auto const& cand = hs.m_asset_closes[static_cast<std::size_t>(a_ix)];
    if (!cand.empty() && cand.size() == hs.m_close0.size()) {
      prim_close = &cand;
    }
  }
  if (prim_close == nullptr) {
    prim_close = &hs.m_close0;
  }
  std::vector<double> const& m_close0_ref = *prim_close;

  if (m_close0_ref.size() < 2 || playhead < 0) {
    return;
  }
  int const bmax = static_cast<int>(m_close0_ref.size()) - 1;
  int       b    = playhead;
  if (b > bmax) {
    b = bmax;
  }
  std::vector<double> closes(m_close0_ref.begin(),
      m_close0_ref.begin() + static_cast<std::size_t>(b) + 1U);
  int const n = static_cast<int>(closes.size());
  if (n < 2) {
    return;
  }
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
  (void)u.try_get_m_series(a_ix, sig_attr, &sig_ser);
  if (!sig_ser || sig_ser->size() < m_close0_ref.size()) {
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
  telem["analysis"]                    = json::object();
  telem["analysis"]["reference_asset_index"] = a_ix;
  telem["analysis"]["signal_attr"]    = sig_attr;
  telem["analysis"]["summary"]        = std::move(summary);
  telem["analysis"]["wealth_tail"]    = jw;
  telem["analysis"]["buy_hold_tail"]  = jb;

  // Preview table (last 48 rows up to playhead)
  int const prev_n = 48;
  int       p0     = b - (prev_n - 1);
  if (p0 < 0) {
    p0 = 0;
  }
  json prev = json::array();
  for (int i = p0; i <= b; ++i) {
    std::string ts;
    if (i < static_cast<int>(hs.m_bar_labels.size())) {
      ts = hs.m_bar_labels[static_cast<std::size_t>(i)];
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

static std::string gal_m1_make_cache_key(HostState const& hs) {
  return hs.m_path + "\x1e" + hs.m_uber_config_json + "\x1e" + hs.m_portfolio_config_json + "\x1e"
      + hs.m_osl_shader_dir_override;
}

/// One-bar portfolio return ∑_a w_a * r_{a,t} for period (t-1→t) using weights **w_prev** (after commit t-1).
static double gal_m1_portfolio_return_for_step(
    HostState const& hs, int t, std::vector<double> const& w_prev, int n) {
  if (t < 1 || w_prev.size() < static_cast<std::size_t>(n)) {
    return 0.0;
  }
  double   rpv = 0.0;
  for (int a = 0; a < n; ++a) {
    double      ra  = 0.0;
    std::size_t ua  = static_cast<std::size_t>(a);
    std::size_t ut  = static_cast<std::size_t>(t);
    std::size_t ut1 = static_cast<std::size_t>(t - 1);
    if (a < static_cast<int>(hs.m_asset_closes.size())
        && static_cast<int>(hs.m_asset_closes[ua].size()) > t) {
      double c0 = hs.m_asset_closes[ua][ut1];
      double c1 = hs.m_asset_closes[ua][ut];
      if (c0 > 1e-12) {
        ra = c1 / c0 - 1.0;
      }
    } else if (a == 0 && t < static_cast<int>(hs.m_close0.size())) {
      double c0 = hs.m_close0[ut1];
      double c1 = hs.m_close0[ut];
      if (c0 > 1e-12) {
        ra = c1 / c0 - 1.0;
      }
    }
    rpv += w_prev[static_cast<std::size_t>(a)] * ra;
  }
  return rpv;
}

static void gal_m1_annotate_last_osl(json& last_osl, std::string const& dir, char const* dir_src) {
  last_osl["enabled"]    = true;
  last_osl["init_ok"]    = true;
  last_osl["shader_dir"] = dir;
  if (dir_src) {
    last_osl["shader_dir_source"] = dir_src;
  }
  if (!last_osl.contains("executed")) {
    last_osl["executed"] = true;
  }
}

static void gal_m1_invalidate_replay_cache(HostState& hs) {
  hs.m_gal_m1_cache_key.clear();
  hs.m_gal_m1_end_bar   = -1;
  hs.m_gal_m1_eq_cache.clear();
  hs.m_gal_m1_last_osl  = json::object();
  hs.m_gal_m1_trades_cache.clear();
  hs.m_gal_m1_last_replay_mode.clear();
}

/// Replays OSL (M1) each asset + GAL from bar 0..`b` (execution clock). **`n==1`** uses a single asset-0 OSL execute.
static bool run_gal_m1_replay(
    HostState&           hs,
    int                  b,
    json const&          jc,
    std::string&       err,
    json&                last_osl,
    std::vector<double>& equity_gal) {
  err.clear();
  hs.m_gal_m1_last_replay_mode = "none";
  int const n = hs.m_universe.asset_count();
  if (b < 0 || hs.m_bars <= 0) {
    err = "no bars";
    return false;
  }
  if (b >= hs.m_bars) {
    b = hs.m_bars - 1;
  }
  std::string const cache_key = gal_m1_make_cache_key(hs);
  std::string       dir;
  char const*       dir_src = nullptr;
  if (!hs.m_osl_shader_dir_override.empty()) {
    dir     = hs.m_osl_shader_dir_override;
    dir_src = "lab";
  } else {
    char const* env = std::getenv("OTL_SHADER_DIR");
    if (env != nullptr && env[0] != '\0') {
      dir.assign(env);
      dir_src = "env";
    }
  }
  if (dir.empty()) {
    err = "gal_m1 requires lab.osl_shader_dir or OTL_SHADER_DIR for m1_alpha.oso";
    return false;
  }
  if (!hs.m_osl_m1) {
    hs.m_osl_m1 = std::make_unique<OslM1Shading>();
  }
  if (hs.m_osl_shader_dir_init != dir || !hs.m_osl_m1->is_ready()) {
    hs.m_osl_m1->clear();
    std::string ie;
    if (!hs.m_osl_m1->try_init(dir, ie)) {
      err = std::move(ie);
      return false;
    }
    hs.m_osl_shader_dir_init = dir;
  }
  GalM1M2Config m2c;
  load_m2_config(jc, m2c);
  otl::RiskModel rm;
  // --- same bar: reuse universe + OSL json + equity + trades (no O(b) work) ---
  if (!cache_key.empty() && cache_key == hs.m_gal_m1_cache_key && hs.m_gal_m1_end_bar == b && b >= 0) {
    equity_gal = hs.m_gal_m1_eq_cache;
    last_osl   = hs.m_gal_m1_last_osl;
    hs.m_universe.set_bar(b);
    hs.m_gal_m1_last_replay_mode = "cached_same_bar";
    return true;
  }

  last_osl = json::object();
  equity_gal.clear();
  int const t0_forward =
      (cache_key == hs.m_gal_m1_cache_key && !cache_key.empty() && hs.m_gal_m1_end_bar >= 0 && b > hs.m_gal_m1_end_bar)
          ? (hs.m_gal_m1_end_bar + 1)
          : 0;
  bool const is_forward = t0_forward > 0;
  if (!is_forward) {
    gal_m1_invalidate_replay_cache(hs);
  }

  if (!is_forward) {
    hs.m_universe.clear_portfolio_state();
    host_apply_node_system_to_all_assets(hs);
  }
  if (is_forward) {
    equity_gal = hs.m_gal_m1_eq_cache;
  } else {
    equity_gal.push_back(100.0);
  }

  std::vector<json> trade_events;
  if (is_forward) {
    trade_events = hs.m_gal_m1_trades_cache;
  }
  int constexpr kMaxGalTradeEvents = 500;

  for (int t = t0_forward; t <= b; ++t) {
    std::vector<double> const w_prev = hs.m_universe.current_portfolio();
    hs.m_universe.set_bar(t);
    hs.m_universe.begin_bar();
    std::string       oerr;
    std::vector<double> intent;
    if (n <= 1) {
      json oj;
      if (!hs.m_osl_m1->execute(hs.m_universe, 0, oj, oerr)) {
        err = "OSL at bar " + std::to_string(t) + ": " + oerr;
        gal_m1_invalidate_replay_cache(hs);
        return false;
      }
      intent = osl_m1_intent_from_json(oj, n);
      if (t == b) {
        last_osl = std::move(oj);
      }
    } else {
      std::vector<json> oj_per(static_cast<std::size_t>(n));
      for (int a = 0; a < n; ++a) {
        json oj_one;
        if (!hs.m_osl_m1->execute(hs.m_universe, a, oj_one, oerr)) {
          err = "OSL asset " + std::to_string(a) + " at bar " + std::to_string(t) + ": " + oerr;
          gal_m1_invalidate_replay_cache(hs);
          return false;
        }
        oj_per[static_cast<std::size_t>(a)] = std::move(oj_one);
      }
      if (t == b) {
        last_osl              = json::object();
        json pa               = json::array();
        for (auto const& jj : oj_per) {
          pa.push_back(jj);
        }
        last_osl["per_asset"] = std::move(pa);
        last_osl["executed"]  = true;
        if (!oj_per.empty() && oj_per[0].contains("fix_signal")) {
          last_osl["fix_signal"] = oj_per[0]["fix_signal"];
        }
      }
      intent = osl_m1_intent_from_per_asset_json(oj_per, n);
    }
    gal_m1_rebalance_and_commit(hs.m_universe, intent, m2c, rm);
    {
      std::vector<double> const w_after = hs.m_universe.current_portfolio();
      json                  dw          = json::array();
      double                gross       = 0.0;
      for (int a = 0; a < n; ++a) {
        double d = (a < static_cast<int>(w_after.size()) && a < static_cast<int>(w_prev.size()))
                       ? (w_after[static_cast<std::size_t>(a)] - w_prev[static_cast<std::size_t>(a)])
                       : 0.0;
        dw.push_back(d);
        gross += std::abs(d);
      }
      json ev = json::object();
      ev["bar"]               = t;
      ev["gross_turnover_l1"] = gross;
      ev["delta_w"]           = std::move(dw);
      trade_events.push_back(std::move(ev));
      while (static_cast<int>(trade_events.size()) > kMaxGalTradeEvents) {
        trade_events.erase(trade_events.begin());
      }
    }
    if (t >= 1) {
      double rpv = gal_m1_portfolio_return_for_step(hs, t, w_prev, n);
      equity_gal.push_back(equity_gal.back() * (1.0 + rpv));
    }
  }
  gal_m1_annotate_last_osl(last_osl, dir, dir_src);
  hs.m_universe.set_bar(b);
  hs.m_gal_m1_cache_key        = cache_key;
  hs.m_gal_m1_end_bar          = b;
  hs.m_gal_m1_eq_cache         = equity_gal;
  hs.m_gal_m1_last_osl         = last_osl;
  hs.m_gal_m1_trades_cache     = std::move(trade_events);
  hs.m_gal_m1_last_replay_mode = is_forward ? "forward" : "full";
  return true;
}

void HostState::append_osl_m1_telemetry(
    json& telem, int playhead_bar, json const* precomputed_osl_m1) {
  if (precomputed_osl_m1 != nullptr) {
    telem["osl_m1"] = *precomputed_osl_m1;
    (void)playhead_bar;
    return;
  }
  std::string               dir;
  char const*               dir_src = nullptr;
  if (!m_osl_shader_dir_override.empty()) {
    dir     = m_osl_shader_dir_override;
    dir_src = "lab";
  } else {
    char const* env = std::getenv("OTL_SHADER_DIR");
    if (env != nullptr && env[0] != '\0') {
      dir.assign(env);
      dir_src = "env";
    }
  }
  if (dir.empty()) {
    telem["osl_m1"] = json::object(
        {{"enabled", false},
         {"hint",
          "Set lab.osl_shader_dir in SET_UBER JSON, or environment OTL_SHADER_DIR, to a directory containing "
          "m1_alpha.oso (same M1 sample as OTL_Engine / OTL-Core)."}});
    return;
  }
  if (!m_osl_m1) {
    m_osl_m1 = std::make_unique<OslM1Shading>();
  }
  if (m_osl_shader_dir_init != dir || !m_osl_m1->is_ready()) {
    m_osl_m1->clear();
    std::string ie;
    if (!m_osl_m1->try_init(dir, ie)) {
      json fail = {{"enabled", true},
                   {"init_ok", false},
                   {"shader_dir", dir},
                   {"error", ie}};
      if (dir_src) {
        fail["shader_dir_source"] = dir_src;
      }
      telem["osl_m1"] = std::move(fail);
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
    if (dir_src) {
      oj["shader_dir_source"] = dir_src;
    }
    telem["osl_m1"]  = std::move(oj);
  } else {
    json fail        = {{"enabled", true},
                 {"init_ok", true},
                 {"shader_dir", dir},
                 {"executed", false},
                 {"error", ee},
                 {"detail", oj}};
    if (dir_src) {
      fail["shader_dir_source"] = dir_src;
    }
    telem["osl_m1"] = std::move(fail);
  }
}

static void fill_node_states(otl::OtlUniverse const& u, otl::OtlNodeSystem const& ns, json& out) {
  int const a = 0;
  out         = json::object();
  float     v    = 0;
  if (u.try_get_m(a, "m_close", false, &v)) {
    out["m_close"] = v;
  } else {
    std::string const& src = ns.source_m_attr();
    if (u.try_get_m(a, src.c_str(), false, &v)) {
      out[src] = v;
    }
  }
  for (auto const& in : ns.indicator_nodes()) {
    v = 0;
    if (u.try_get_m(a, in.m_attr.c_str(), false, &v)) {
      out[in.m_attr] = v;
    }
  }
  out["map_from"] = "OtlNodeSystem+VectorTA";
  out["asset"]   = a;
}

static void fill_node_states_at_asset(otl::OtlUniverse const& u, otl::OtlNodeSystem const& ns, int a, json& out) {
  out     = json::object();
  out["asset"] = a;
  float   v   = 0;
  if (u.try_get_m(a, "m_close", false, &v)) {
    out["m_close"] = v;
  } else {
    std::string const& src = ns.source_m_attr();
    if (u.try_get_m(a, src.c_str(), false, &v)) {
      out[src] = v;
    }
  }
  for (auto const& in : ns.indicator_nodes()) {
    v = 0;
    if (u.try_get_m(a, in.m_attr.c_str(), false, &v)) {
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
  json const        jc_pf = parse_portfolio_cfg_json(m_portfolio_config_json);
  std::string const integ  = get_portfolio_integrator(jc_pf);
  json              last_osl_gal;
  std::vector<double> eq_gal;
  std::string        gal_err;
  bool               gal_ok = false;
  if (integ == "gal_m1") {
    gal_ok = run_gal_m1_replay(*this, b, jc_pf, gal_err, last_osl_gal, eq_gal);
    if (!gal_ok) {
      set_playhead(b);
    }
  } else {
    set_playhead(b);
  }

  json j;
  j["bar"] = b;
  j["bar_label"] =
      (b < static_cast<int>(m_bar_labels.size())) ? json(m_bar_labels[static_cast<std::size_t>(b)]) : json(nullptr);
  j["wall_time"] = j["bar_label"];

  json       node_states;
  fill_node_states(m_universe, m_node_system, node_states);
  j["node_states"]    = std::move(node_states);
  {
    int const n_ast = m_universe.asset_count();
    j["assets"]   = n_ast;
    j["node_states_primary"] = 0;
    json by_ast = json::array();
    for (int a = 0; a < n_ast; ++a) {
      json one;
      fill_node_states_at_asset(m_universe, m_node_system, a, one);
      by_ast.push_back(std::move(one));
    }
    j["node_states_by_asset"] = std::move(by_ast);
    json al = json::array();
    for (int a = 0; a < n_ast; ++a) {
      if (a < static_cast<int>(m_asset_column_labels.size())) {
        al.push_back(m_asset_column_labels[static_cast<std::size_t>(a)]);
      } else {
        al.push_back(std::string("Asset ") + std::to_string(a));
      }
    }
    j["asset_labels"] = std::move(al);
  }
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
  {
    int const  n_p = m_universe.asset_count();
    json       per  = json::array();
    for (int a = 0; a < n_p; ++a) {
      json     one  = json::object();
      bool     have_close = false;
      if (a < static_cast<int>(m_asset_closes.size())
          && b < static_cast<int>(m_asset_closes[static_cast<std::size_t>(a)].size())
          && !m_asset_closes[static_cast<std::size_t>(a)].empty()) {
        one["close_tail"] = tail_num(m_asset_closes[static_cast<std::size_t>(a)], b, 32);
        have_close         = true;
      }
      if (!have_close) {
        std::vector<double> const* serC = nullptr;
        if (m_universe.try_get_m_series(a, "m_close", &serC) && serC != nullptr && !serC->empty()) {
          one["close_tail"] = tail_num(*serC, b, 32);
        } else {
          one["close_tail"] = a == 0 ? telem["close_tail"] : json::array();
        }
      }
      float mca = 0.f;
      m_universe.try_get_m(a, "m_close", false, &mca);
      one["m_close"] = mca;
      if (!shadow_key.empty()) {
        std::vector<double> const* ser2 = nullptr;
        if (m_universe.try_get_m_series(a, shadow_key, &ser2) && ser2 != nullptr) {
          json sh2 = json::object();
          sh2["m_attr"] = shadow_key;
          sh2["tail"]   = tail_num(*ser2, b, 32);
          one["shadow_overlay"] = std::move(sh2);
        }
      }
      per.push_back(std::move(one));
    }
    j["per_asset_telemetry"] = std::move(per);
  }

  {
    json ex = json::object();
    ex["ordered_steps"] = json::array(
        {"vector_ta_bake", "seek_set_bar", "begin_bar", "osl_m1_execute", "gal_commit"});
    ex["bar"]   = b;
    ex["note"]  = "close_proxy: OSL telemetry runs without GAL replay; gal_m1: full clock replay 0..bar.";
    ex["integrator"] = integ;
    if (integ == "gal_m1") {
      ex["gal_m1_replay_ok"] = gal_ok;
      ex["gal_m1_replay_mode"] = m_gal_m1_last_replay_mode;
      if (!gal_ok) {
        ex["error"] = gal_err;
      } else {
        ex["replay_bars"] = b + 1;
      }
    }
    j["execution_clock"] = std::move(ex);
  }

  if (integ == "gal_m1" && gal_ok) {
    json port  = json::object();
    port["integrator"] = "gal_m1";
    json j_eq  = json::array();
    for (double x : eq_gal) {
      j_eq.push_back(x);
    }
    port["equity_tail_gal"] = std::move(j_eq);
    json jcw = json::array();
    for (double x : m_universe.current_portfolio()) {
      jcw.push_back(x);
    }
    port["current_weights"] = std::move(jcw);
    json jow = json::array();
    for (double x : m_universe.osl_prev_weight()) {
      jow.push_back(x);
    }
    port["osl_prev_weight"] = std::move(jow);
    double   peak = 100.0;
    double   mxd  = 0.0;
    for (double e : eq_gal) {
      if (e > peak) {
        peak = e;
      }
      double ddp = (peak > 1e-12) ? (peak - e) / peak : 0.0;
      if (ddp > mxd) {
        mxd = ddp;
      }
    }
    json st = json::object();
    fill_portfolio_stats_from_eq_curve(eq_gal, mxd, st);
    port["stats"] = std::move(st);
    telem["portfolio"] = std::move(port);
  }

  append_portfolio_telemetry(telem, *this, b, m_portfolio_config_json);
  append_analysis_telemetry(telem, b, *this, m_node_system);
  if (integ == "gal_m1" && gal_ok && !m_gal_m1_trades_cache.empty()) {
    json tr = json::array();
    for (json const& ev : m_gal_m1_trades_cache) {
      tr.push_back(ev);
    }
    if (!telem.contains("analysis") || !telem["analysis"].is_object()) {
      telem["analysis"] = json::object();
    }
    telem["analysis"]["trades"] = std::move(tr);
  }
  if (integ == "gal_m1" && gal_ok) {
    append_osl_m1_telemetry(telem, b, &last_osl_gal);
  } else {
    append_osl_m1_telemetry(telem, b, nullptr);
  }
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
  json const jc               = parse_portfolio_cfg_json(m_portfolio_config_json);
  int const  n_ast            = std::max(1, m_universe.asset_count());
  int const  a_ix             = analysis_asset_index_from_portfolio(jc, n_ast);
  std::vector<double> const* price_ser = &m_close0;
  if (a_ix >= 0 && a_ix < static_cast<int>(m_asset_closes.size())) {
    auto const& cand = m_asset_closes[static_cast<std::size_t>(a_ix)];
    if (cand.size() == m_close0.size()) {
      price_ser = &cand;
    }
  }
  std::string const sig_attr        = pick_signal_m_attr(m_node_system);
  std::vector<double> const* sig_ser = nullptr;
  (void)m_universe.try_get_m_series(a_ix, sig_attr, &sig_ser);
  if (!sig_ser || sig_ser->size() < static_cast<std::size_t>(m_bars)) {
    sig_ser = nullptr;
  }
  double   mxd = 0;
  std::vector<double> eq_curve;
  std::vector<double> dd_curve;
  simulate_portfolio_equity_on_closes(*price_ser, jc, eq_curve, dd_curve, mxd);
  if (static_cast<int>(eq_curve.size()) != m_bars) {
    err = "export: equity length mismatch";
    return false;
  }
  std::vector<double> bh(static_cast<std::size_t>(m_bars), 100.0);
  for (int i = 1; i < m_bars; ++i) {
    double prev = (*price_ser)[static_cast<std::size_t>(i - 1)];
    double c    = (*price_ser)[static_cast<std::size_t>(i)];
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
    double pr = (*price_ser)[static_cast<std::size_t>(i)];
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
  {
    int const na = m_universe.asset_count();
    json      al = json::array();
    for (int a = 0; a < na; ++a) {
      if (a < static_cast<int>(m_asset_column_labels.size())) {
        al.push_back(m_asset_column_labels[static_cast<std::size_t>(a)]);
      } else {
        al.push_back(std::string("Asset ") + std::to_string(a));
      }
    }
    j["asset_labels"] = std::move(al);
  }
  j["bridge_heartbeat"]  = json::object(
      {{"host", "ok"},
       {"vector_ta", "linked"},
       {"cxx", "ok"}});
  {
    if (!m_osl_shader_dir_override.empty()) {
      j["osl_m1_shader_path"]         = m_osl_shader_dir_override;
      j["osl_m1_shader_path_source"]    = "lab";
    } else {
      char const* e = std::getenv("OTL_SHADER_DIR");
      if (e != nullptr && e[0] != '\0') {
        j["osl_m1_shader_path"]      = e;
        j["osl_m1_shader_path_source"] = "env";
      } else {
        j["osl_m1_shader_path"]         = nullptr;
        j["osl_m1_shader_path_source"]  = nullptr;
      }
    }
  }
  try {
    j["uber_config_effective"] =
        m_uber_config_json.empty() ? json::parse(kDefaultUberConfig) : json::parse(m_uber_config_json);
  } catch (...) {
    j["uber_config_effective"] = json::parse(kDefaultUberConfig);
  }
  j["timeline_axis"] = make_timeline_axis_json(m_bars, m_bar_labels);
  return j.dump();
}

}  // namespace mlab::host
