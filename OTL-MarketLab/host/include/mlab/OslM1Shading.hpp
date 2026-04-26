#pragma once

#include <memory>
#include <string>

#include <nlohmann/json.hpp>

namespace otl {
class OtlUniverse;
}

namespace mlab::host {

/// Optional OSL **M1** path: `ShadingSystem` + `MarketDelegate` + `m1_alpha.oso` (same as `OTL-Core/main.cpp`).
/// Enable by setting environment **`OTL_SHADER_DIR`** to a directory containing **m1_alpha.oso** (from `oslc`).
class OslM1Shading {
 public:
  OslM1Shading();
  ~OslM1Shading();
  OslM1Shading(OslM1Shading const&) = delete;
  OslM1Shading& operator=(OslM1Shading const&) = delete;

  /// Tear down the shading system and thread context (e.g. on new `LOAD_DATA`).
  void clear();

  /// (Re)build shader group from `shader_dir`. Safe to call again after `clear()`.
  bool try_init(std::string const& shader_dir, std::string& err);

  bool is_ready() const;

  /// Execute `m1_alpha` for the given `asset_id` (universe playhead and series must already match the seek bar).
  /// On success, fills `out` with `executed`, `fix_signal` {side, quantity, price}.
  bool execute(otl::OtlUniverse& u, int asset_id, nlohmann::json& out, std::string& err);

 private:
  struct Impl;
  std::unique_ptr<Impl> m_impl;
};

}  // namespace mlab::host
