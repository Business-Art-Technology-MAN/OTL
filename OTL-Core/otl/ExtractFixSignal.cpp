#include "ExtractFixSignal.hpp"

#include <OSL/oslclosure.h>
#include <cstdint>
#include <vector>

namespace otl {

bool extract_first_fix_signal(OSL::ClosureColor const* root, FixSignalLayout& out) {
  if (root == nullptr) {
    return false;
  }
  std::vector<OSL::ClosureColor const*> stack;
  stack.push_back(root);
  while (!stack.empty()) {
    OSL::ClosureColor const* c = stack.back();
    stack.pop_back();
    if (c == nullptr) {
      continue;
    }
    if (c->id == OSL::ClosureColor::MUL) {
      stack.push_back(c->as_mul()->closure);
    } else if (c->id == OSL::ClosureColor::ADD) {
      stack.push_back(c->as_add()->closureB);
      stack.push_back(c->as_add()->closureA);
    } else {
      OSL::ClosureComponent const* comp = c->as_comp();
      if (static_cast<std::uint32_t>(comp->id) == kFixSignalClosureId) {
        FixSignalLayout const* p = comp->as<FixSignalLayout>();
        if (p) {
          out = *p;
          return true;
        }
      }
    }
  }
  return false;
}

}  // namespace otl
