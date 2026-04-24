#pragma once

// Single include point for the cxx `bake_indicator_buffer` symbol. If you get an undefined or
// multiply-defined `bake_indicator_buffer`, open the generated
//   <build>/.../include/vector_ta/src/bridge.rs.h
// and set exactly one of the `OTL_VT_BAKE_IMPL_*` macros below to 1 in CMake, or #define
// it before including this file.

#include "vector_ta/src/bridge.rs.h"
#include "rust/cxx.h"

#include <cstdint>
#include <utility>

namespace otl::vta {

inline rust::Vec<double> bake_indicator_buffer_cxx(rust::String const& id, rust::Vec<double> in,
                                                    std::int32_t period) {
// Pick the definition that matches your generated header (default: `mod ffi` → `::ffi::`).
#if defined(OTL_VT_BAKE_IMPL_GLOBAL) && (OTL_VT_BAKE_IMPL_GLOBAL)
  return ::bake_indicator_buffer(id, std::move(in), period);
#elif defined(OTL_VT_BAKE_IMPL_ORG) && (OTL_VT_BAKE_IMPL_ORG)
  return ::org::vector_ta::ffi::bake_indicator_buffer(id, std::move(in), period);
#else
  return ::ffi::bake_indicator_buffer(id, std::move(in), period);
#endif
}

}  // namespace otl::vta
