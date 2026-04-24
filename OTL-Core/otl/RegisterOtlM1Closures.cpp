#include <OSL/oslexec.h>
#include <OSL/genclosure.h>

#include "FixSignalClosure.hpp"

using namespace OSL;

void register_otl_m1_closures(OSL::ShadingSystem* shadingsys) {
  if (!shadingsys) {
    return;
  }
  ClosureParam param[] = {CLOSURE_FLOAT_PARAM(FixSignalLayout, side),
                            CLOSURE_FLOAT_PARAM(FixSignalLayout, quantity),
                            CLOSURE_FLOAT_PARAM(FixSignalLayout, price),
                            CLOSURE_FINISH_PARAM(FixSignalLayout)};
  shadingsys->register_closure("fix_signal", static_cast<int>(otl::kFixSignalClosureId), &param[0], nullptr, nullptr);
}
