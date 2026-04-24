#pragma once

#include "FixSignalClosure.hpp"
#include <OSL/oslclosure.h>

namespace otl {

/// Walks a post-execution `sg.Ci` closure tree; copies the first `fix_signal` leaf found into `out`.
/// Returns false if the tree is null or no matching component exists.
bool extract_first_fix_signal(OSL::ClosureColor const* root, FixSignalLayout& out);

}  // namespace otl
