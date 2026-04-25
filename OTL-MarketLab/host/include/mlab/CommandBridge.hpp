#pragma once

#include "mlab/HostState.hpp"

#include <string>

namespace mlab::host {

/// Blocks: open local named pipe (Windows) or Unix domain socket; process line-based Command Bridge protocol.
/// Returns when the client sends QUIT or an I/O error occurs.
int run_command_bridge(HostState& state, std::string& out_error);

}  // namespace mlab::host
