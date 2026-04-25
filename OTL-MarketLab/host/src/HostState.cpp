#include "mlab/HostState.hpp"

#include "otl/VectorTAService.hpp"
#include "otl/MarketDataCsv.hpp"

#include <cctype>
#include <cstdlib>
#include <fstream>
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

bool HostState::load_data(std::string const& path, std::string& err) {
  err.clear();
  m_bar_labels.clear();
  m_close0.clear();
  m_path.clear();
  m_bars   = 0;
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
    return false;
  }
  m_bars  = b;
  m_path  = path;
  m_node_system = otl::OtlNodeSystem{};
  if (!apply_uber_config(err)) {
    m_bar_labels.clear();
    m_close0.clear();
    m_bars = 0;
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

  j["telemetry"] = std::move(telem);
  j["bridge_heartbeat"] =
      json::object({{"host", "ok"}, {"vector_ta", "linked"}, {"cxx", "ok"}});
  return j.dump();
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
