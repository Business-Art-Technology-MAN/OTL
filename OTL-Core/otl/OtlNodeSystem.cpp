#include "OtlNodeSystem.hpp"
#include "OtlUniverse.hpp"
#include "VectorTAService.hpp"

#include <nlohmann/json.hpp>

#include <fstream>
#include <sstream>
#include <unordered_map>
#include <unordered_set>

using json = nlohmann::json;

namespace otl {

void OtlNodeSystem::clear() {
  m_version = 0;
  m_source_m_attr = "m_close";
  m_shader_layer.clear();
  m_shader_m_attrs.clear();
  m_indicators.clear();
  m_last_error.clear();
}

void OtlNodeSystem::clear_error() { m_last_error.clear(); }

bool OtlNodeSystem::load_from_file(std::string const& path) {
  clear();
  std::ifstream f(path, std::ios::in | std::ios::binary);
  if (!f) {
    m_last_error = "OtlNodeSystem: cannot open file: " + path;
    return false;
  }
  std::stringstream buf;
  buf << f.rdbuf();
  return load_from_string(buf.str());
}

bool OtlNodeSystem::load_from_string(std::string const& json) {
  clear();
  return parse_json(json);
}

static bool is_identifier(std::string const& s) {
  if (s.empty()) {
    return false;
  }
  for (char c : s) {
    if ((c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '_' && c != '@') {
      return false;
    }
  }
  return true;
}

bool OtlNodeSystem::parse_json(std::string const& json_text) {
  json root;
  try {
    root = json::parse(json_text);
  } catch (json::parse_error const& e) {
    m_last_error = std::string("OtlNodeSystem: JSON parse: ") + e.what();
    return false;
  }

  if (!root.is_object()) {
    m_last_error = "OtlNodeSystem: root must be a JSON object";
    return false;
  }

  if (root.contains("version")) {
    m_version = root["version"].get<int>();
  } else {
    m_version = 1;
  }

  m_source_m_attr = "m_close";
  if (root.contains("source") && root["source"].is_object()) {
    auto const& src = root["source"];
    if (src.contains("m_attr")) {
      m_source_m_attr = src["m_attr"].get<std::string>();
    }
  }

  m_shader_layer.clear();
  m_shader_m_attrs.clear();
  if (root.contains("shader") && root["shader"].is_object()) {
    auto const& sh = root["shader"];
    if (sh.contains("layer")) {
      m_shader_layer = sh["layer"].get<std::string>();
    }
    if (sh.contains("m_attrs") && sh["m_attrs"].is_array()) {
      for (auto const& x : sh["m_attrs"]) {
        m_shader_m_attrs.push_back(x.get<std::string>());
      }
    }
  }

  m_indicators.clear();
  if (!root.contains("indicators") || !root["indicators"].is_array()) {
    m_last_error = "OtlNodeSystem: missing \"indicators\" array";
    return false;
  }

  for (auto const& node : root["indicators"]) {
    if (!node.is_object()) {
      m_last_error = "OtlNodeSystem: each indicators[] entry must be an object";
      return false;
    }
    IndicatorNode n;
    if (!node.contains("id") || !node["id"].is_string()) {
      m_last_error = "OtlNodeSystem: indicator requires string \"id\"";
      return false;
    }
    n.id = node["id"].get<std::string>();
    if (!is_identifier(n.id) || n.id == "close") {
      m_last_error = "OtlNodeSystem: invalid id (reserved or bad chars): " + n.id;
      return false;
    }
    if (!node.contains("indicator") || !node["indicator"].is_string()) {
      m_last_error = "OtlNodeSystem: indicator " + n.id + " needs string \"indicator\" (VectorTA id)";
      return false;
    }
    n.indicator_id = node["indicator"].get<std::string>();
    if (node.contains("period")) {
      n.period = static_cast<int32_t>(node["period"].get<int>());
    } else {
      n.period = 14;
    }
    if (n.period <= 0) {
      m_last_error = "OtlNodeSystem: period must be positive for " + n.id;
      return false;
    }
    if (!node.contains("from") || !node["from"].is_string()) {
      m_last_error = "OtlNodeSystem: indicator " + n.id + " needs string \"from\" (\"close\" or prior id)";
      return false;
    }
    n.from = node["from"].get<std::string>();
    if (!node.contains("m_attr") || !node["m_attr"].is_string()) {
      m_last_error = "OtlNodeSystem: indicator " + n.id + " needs string \"m_attr\" (OSL m_* key)";
      return false;
    }
    n.m_attr = node["m_attr"].get<std::string>();
    m_indicators.push_back(std::move(n));
  }

  {
    std::unordered_set<std::string> seen;
    for (auto const& n : m_indicators) {
      if (seen.contains(n.id)) {
        m_last_error = "OtlNodeSystem: duplicate id: " + n.id;
        return false;
      }
      seen.insert(n.id);
    }
  }

  for (std::size_t i = 0; i < m_indicators.size(); ++i) {
    std::string const& f = m_indicators[i].from;
    if (f == "close") {
      continue;
    }
    bool ok = false;
    for (std::size_t j = 0; j < i; ++j) {
      if (m_indicators[j].id == f) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      m_last_error = "OtlNodeSystem: 'from' must be \"close\" or an earlier id: " + f + " (node " + m_indicators[i].id + ")";
      return false;
    }
  }

  m_last_error.clear();
  return true;
}

bool OtlNodeSystem::apply_to_asset(OtlUniverse& u, int asset, std::vector<double> const& close) const {
  m_last_error.clear();
  if (m_source_m_attr.empty()) {
    m_last_error = "OtlNodeSystem: empty source m_attr";
    return false;
  }
  if (close.empty()) {
    m_last_error = "OtlNodeSystem: close series is empty";
    return false;
  }
  u.set_m_series(asset, m_source_m_attr, close);

  std::unordered_map<std::string, std::vector<double>> by_id;
  by_id["close"] = close;

  for (IndicatorNode const& n : m_indicators) {
    auto itf = by_id.find(n.from);
    if (itf == by_id.end()) {
      m_last_error = "OtlNodeSystem: missing series for 'from' " + n.from + " (node " + n.id + ")";
      return false;
    }
    std::vector<double> out = bake_series(n.indicator_id, itf->second, n.period);
    if (out.size() != close.size()) {
      m_last_error = "OtlNodeSystem: length mismatch for " + n.id + " (baked size vs close)";
      return false;
    }
    by_id[n.id] = std::move(out);
    u.set_m_series(asset, n.m_attr, by_id[n.id]);
  }
  return true;
}

}  // namespace otl
