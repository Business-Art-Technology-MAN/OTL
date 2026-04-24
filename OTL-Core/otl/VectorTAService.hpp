#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace otl {

/// Calls VectorTA via the `cxx` bridge (indicator id matches VectorTA registry, e.g. "sma", "rsi").
std::vector<double> bake_series(std::string const& indicator_id,
                                std::vector<double> const& input,
                                int32_t period);

}  // namespace otl
