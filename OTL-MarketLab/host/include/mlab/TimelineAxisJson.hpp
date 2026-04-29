#pragma once

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace mlab::host {

/// Builds **`LOAD_DATA.timeline_axis`** — `bars` plus `ticks[{bar,wall}]` for the Electron footer
/// (`docs/Command_Bridge.md`).
///
/// Sampling: nine uniformly spaced positions along **`0 … bars−1`** (inclusive endpoints), **`k/8.0`** with
/// `std::lround`; bar indices deduplicated and ordered.
///
/// @param bars               Loaded row count (**`0 … bars−1`** valid for SEEK indices).
/// @param bar_labels          Wall-clock string per CSV row; generation runs only when
///                             `bars > 0` and **`bar_labels.size() >= bars`**.
[[nodiscard]] nlohmann::json make_timeline_axis_json(
    int                       bars,
    std::vector<std::string> const& bar_labels);

}  // namespace mlab::host
