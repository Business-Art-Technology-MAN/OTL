#pragma once

// Single include point for the cxx `bake_indicator_buffer` symbol. Corrosion generates
//   <build>/.../include/otl_vector_ta_cxx/bridge.h
// (FILES bridge.rs in CMake). If you get an undefined or multiply-defined
// `bake_indicator_buffer`, set exactly one of the `OTL_VT_BAKE_IMPL_*` macros below in CMake
// or #define it before including this file.

#include "otl_vector_ta_cxx/bridge.h"
#include "rust/cxx.h"

#include <cstdint>
#include <utility>

namespace otl::vta {

inline rust::Vec<double> bake_indicator_buffer_cxx(rust::String const& id, rust::Vec<double> in,
                                                    std::int32_t period) {
  // Generated `bridge.h`: `::rust::Vec<double> bake_indicator_buffer(::rust::Str, ::rust::Slice<double const>, ...)`
  rust::Str const name{id};
  rust::Slice<double const> const slice{in.data(), in.size()};
  return ::bake_indicator_buffer(name, slice, period);
}

}  // namespace otl::vta
