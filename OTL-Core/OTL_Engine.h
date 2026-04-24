#pragma once

#include <string>
#include <vector>

// `cxx` output for the `vector_ta` crate (feature `cxx-bridge`, bridge file `src/bridge.rs`).
// Add the Cargo cxxbridge include directory to your C++ target, e.g.:
//   <target_dir>/build/vector-ta-*/out/cxxbridge/include
// Then this include resolves. (It is not a checked-in file under 3rdparty/VectorTA.)
#include "vector_ta/src/bridge.rs.h"

/// GA-based intent / execution signal (FIX-oriented naming).
struct FIXSignal {
  int side;  // 1 = Buy, 2 = Sell
  double quantity;
  double price;
};

/// Binds VectorTA bakes, OSL strategy execution, and GA portfolio actions for OTL-Core.
class MarketRenderDelegate {
 public:
  /// 1. Bake: uses VectorTA to prepare indicator buffers for a ticker.
  void bake_attributes(const std::string& ticker);

  /// 2. Shade: runs the OSL kernel / bytecode and returns a signal.
  FIXSignal execute_strategy(const std::string& osl_bytecode_path);

  /// 3. Integrate: apply GA / portfolio rebalancing from intent closures.
  void apply_ga_rebalance(const std::vector<FIXSignal>& intents);
};
