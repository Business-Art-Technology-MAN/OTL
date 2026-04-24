#include "MarketDataCsv.hpp"

#include "OtlUniverse.hpp"

#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace otl::data {

static void trim_cr(std::string& s) {
  while (!s.empty() && (s.back() == '\r' || s.back() == '\n')) {
    s.pop_back();
  }
}

static std::vector<std::string> split_csv(std::string line) {
  trim_cr(line);
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

bool load_universe_close_matrix(std::string const& csv_path, OtlUniverse& out_u, int& out_bars) {
  out_bars = 0;
  std::ifstream f(csv_path, std::ios::in);
  if (!f) {
    return false;
  }
  std::string line;
  if (!std::getline(f, line)) {
    return false;
  }
  std::vector<std::string> header = split_csv(line);
  if (header.size() < 2) {
    return false;
  }
  int n = static_cast<int>(header.size()) - 1;
  if (n <= 0) {
    return false;
  }
  for (int i = 1; i < static_cast<int>(header.size()); ++i) {
    if (header[static_cast<std::size_t>(i)].rfind("close", 0) == std::string::npos &&
        header[static_cast<std::size_t>(i)].rfind("Close", 0) == std::string::npos) {
      // allow numeric-only column names from odd exports
    }
  }

  std::vector<std::vector<double>> per_asset(static_cast<std::size_t>(n));
  while (std::getline(f, line)) {
    if (line.empty()) {
      continue;
    }
    std::vector<std::string> fields = split_csv(line);
    if (fields.size() < static_cast<std::size_t>(n + 1)) {
      continue;
    }
    for (int a = 0; a < n; ++a) {
      double v = std::strtod(fields[static_cast<std::size_t>(a + 1)].c_str(), nullptr);
      per_asset[static_cast<std::size_t>(a)].push_back(v);
    }
  }

  for (int a = 0; a < n; ++a) {
    if (per_asset[static_cast<std::size_t>(a)].size() != per_asset[0].size()) {
      return false;
    }
  }
  out_bars = static_cast<int>(per_asset[0].size());
  if (out_bars <= 0) {
    return false;
  }

  out_u.resize(n);
  for (int a = 0; a < n; ++a) {
    out_u.set_m_series(a, "m_close", per_asset[static_cast<std::size_t>(a)]);
  }
  out_u.set_bar(out_bars - 1);
  return true;
}

}  // namespace otl::data
