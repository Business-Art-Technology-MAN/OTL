#pragma once

#include <cstdint>

namespace otl {

/// Registered with OSL as the second argument to `register_closure` (must match `RegisterOtlM1Closures`).
inline constexpr std::uint32_t kFixSignalClosureId = 0x4f544c00;  // "OTL\0" tag

/// Parameter layout for `fix_signal` (must match `m1_alpha.osl` and closure registration order).
struct FixSignalLayout {
  float side;
  float quantity;
  float price;
};

}  // namespace otl
