#pragma once

namespace mlab::bridge {

// Must match `electron/bridgeConfig.cjs` and `docs/Command_Bridge.md`.
#if defined(_WIN32)
inline constexpr char const* kDefaultPipeName = R"(\\.\pipe\OTL_MarketLab_CommBridge)";
#else
inline constexpr char const* kDefaultSocketPath = "/tmp/OTL_MarketLab_CommBridge.sock";
#endif

}  // namespace mlab::bridge
