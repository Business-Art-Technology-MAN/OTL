#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace otl {

/// Baked, point-in-time market attributes per asset (e.g. "m_close", "m_rsi").
class OtlUniverse {
 public:
  OtlUniverse() = default;

  int asset_count() const { return m_asset_count; }
  void resize(int n);
  int bar() const { return m_bar; }
  void set_bar(int b) { m_bar = b; }

  void set_m_attr(int asset, std::string const& key, float v);
  void set_m_series(int asset, std::string const& key, std::vector<double> series);

  bool try_get_m(int asset, char const* name, bool derivatives, float* val) const;
  int last_asset() const { return m_last_asset; }
  void set_thread_asset(int a) { m_last_asset = a; }

 private:
  struct PerAsset {
    std::unordered_map<std::string, float> scalars;
    std::unordered_map<std::string, std::vector<double>> series;
  };

  int m_asset_count{0};
  int m_bar{0};
  std::vector<PerAsset> m_per;
  int m_last_asset{0};
};

struct OtlRenderState {
  OtlUniverse* universe{nullptr};
  int asset_id{0};
};

}  // namespace otl
