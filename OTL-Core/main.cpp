// OTL Suite — Milestone 1 wiring: VectorTA bake → OtlUniverse → (optional) OSL → GAL rebalance.

#include <OSL/oslexec.h>
#include <OSL/shaderglobals.h>

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

#include "otl/GaPortfolioIntegrator.hpp"
#include "otl/MarketDelegate.hpp"
#include "otl/OtlUniverse.hpp"
#include "otl/RegisterOtlM1Closures.hpp"
#include "otl/VectorTAService.hpp"

namespace {

constexpr int kDefaultUniverse = 64;

std::vector<double> synthetic_close(int asset, int len) {
  std::vector<double> c;
  c.reserve(static_cast<std::size_t>(len));
  double base = 50.0 + static_cast<double>(asset) * 0.25;
  for (int t = 0; t < len; ++t) {
    double w = 0.01 * static_cast<double>(t);
    c.push_back(base + 0.5 * std::sin(w + static_cast<double>(asset)) + 0.02 * static_cast<double>(t));
  }
  return c;
}

}  // namespace

int main(int argc, char** argv) {
  (void)argc;
  (void)argv;

  int const n = kDefaultUniverse;
  otl::OtlUniverse universe;
  universe.resize(n);
  universe.set_bar(99);

  // 1) Bake VectorTA indicators per asset (SIMD/CPU path inside VectorTA).
  for (int a = 0; a < n; ++a) {
    std::vector<double> const close = synthetic_close(a, 120);
    universe.set_m_series(a, "m_close", close);

    auto const sma = otl::bake_series("sma", close, 20);
    if (!sma.empty()) {
      universe.set_m_series(a, "m_sma", sma);
    }
    auto const rsi = otl::bake_series("rsi", close, 14);
    if (!rsi.empty()) {
      universe.set_m_series(a, "m_rsi", rsi);
    }
  }

  // 2) GA portfolio step: intent multivector modeled as R^N vector, risk subspace projection + plane rotation.
  std::vector<double> intent(static_cast<std::size_t>(n), 0.0);
  for (int a = 0; a < n; ++a) {
    intent[static_cast<std::size_t>(a)] = static_cast<double>(a % 7) - 3.0;
  }
  otl::RiskModel rm;
  std::vector<double> e0(static_cast<std::size_t>(n), 0.0);
  e0[0] = 1.0;
  rm.risk_basis.push_back(e0);
  std::vector<double> const rebalanced = otl::rebalance_intent(intent, rm, 0, 1, 5.0);

  double check = 0.0;
  for (double x : rebalanced) {
    check += x;
  }
  std::cout << "M1: baked " << n << " assets; GA rebalance sample sum = " << check << "\n";

  // 3) OSL ShadingSystem (optional: set env OTL_SHADER_DIR to folder containing m1_alpha.oso).
  char const* shader_dir = std::getenv("OTL_SHADER_DIR");
  if (shader_dir) {
    otl::MarketDelegate renderer(nullptr);
    renderer.prepare_ustring_lookups();
    OSL::ShadingSystem shadingsys(&renderer, nullptr, nullptr);
    shadingsys.attribute("searchpath:shader", shader_dir);
    register_otl_m1_closures(&shadingsys);

    OSL::ShaderGroupRef const grp = shadingsys.ShaderGroupBegin("otl_m1");
    if (!grp) {
      std::cerr << "OTL: ShaderGroupBegin failed\n";
    } else {
    shadingsys.Shader(*grp, "surface", "m1_alpha", "layer0");
    if (!shadingsys.ShaderGroupEnd(*grp)) {
      std::cerr << "OTL: ShaderGroupEnd failed (is m1_alpha.oso on searchpath:shader?)\n";
    } else {
      OSL::PerThreadInfo* pti = shadingsys.create_thread_info();
      OSL::ShadingContext* ctx = shadingsys.get_context(pti);
      OSL::ShaderGlobals sg;
      std::memset(&sg, 0, sizeof(sg));
      otl::OtlRenderState rs;
      rs.universe = &universe;
      rs.asset_id = 0;
      sg.renderstate = &rs;
      sg.renderer = &renderer;
      sg.Ci = nullptr;
      sg.P = OSL::Vec3(0.0f, 0.0f, 0.0f);
      sg.u = 0.0f;
      sg.v = 0.0f;
      if (shadingsys.execute(*ctx, *grp, sg, true)) {
        std::cout << "M1: OSL m1_alpha executed (closure on Ci; inspect renderer for consumption).\n";
      } else {
        std::cerr << "OTL: execute failed\n";
      }
      shadingsys.release_context(ctx);
      shadingsys.destroy_thread_info(pti);
    }
    }
  } else {
    std::cout << "M1: skip OSL (set OTL_SHADER_DIR to a directory with m1_alpha.oso from oslc)\n";
  }

  return 0;
}
