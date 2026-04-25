#pragma once

#include <OSL/oslexec.h>

/// Register OTL `fix_signal` with the active OSL ShadingSystem.
/// Include `oslexec.h` here (do not forward-declare `ShadingSystem`): OSL uses an
/// inline version namespace, and a bare `namespace OSL { class ShadingSystem; }`
/// collides with `OSL::ShadingSystem` / `OSL::v1_*::ShadingSystem` (C2872).
void register_otl_m1_closures(OSL::ShadingSystem* shadingsys);
