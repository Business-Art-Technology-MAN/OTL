// OTL-Sandbox (Phase 1.5) — hermetic E2E: SyntheticUniverse → OtlUniverse + VectorTA RSI
//   → m1_alpha.osl (fix_signal) → GA rebalancing. Closure handling follows
//   `3rdparty/osl/src/testshade` / `oslclosure` walk patterns; registration mirrors testshade
//   `register_closure` (see `RegisterOtlM1Closures.cpp` + `3rdparty/osl/src/testshade/testshade.cpp`).

#include <OSL/oslexec.h>
#include <OSL/shaderglobals.h>

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <string>
#include <vector>

#include "otl/ExtractFixSignal.hpp"
#include "otl/FixSignalClosure.hpp"
#include "otl/GaPortfolioIntegrator.hpp"
#include "otl/MarketDelegate.hpp"
#include "otl/OtlUniverse.hpp"
#include "otl/RegisterOtlM1Closures.hpp"
#include "SyntheticUniverse.hpp"

namespace {

struct Options {
  int n_assets{otl::sandbox::SyntheticUniverse::kDefaultAssets};
  int series_len{otl::sandbox::SyntheticUniverse::kDefaultLen};
  int bar_index{otl::sandbox::SyntheticUniverse::kDefaultBar};
  std::string shader_dir;
  std::string csv_path;  // empty = stdout only
  bool osl_all{true};
  int osl_max_assets{64};
  bool print_tables{true};
  unsigned int seed{0x4f544c0Du};
};

void print_vec_block(std::string const& label, std::vector<double> const& v) {
  std::cout << label << " (" << v.size() << ")\n  ";
  int show = 0;
  for (std::size_t i = 0; i < v.size(); ++i) {
    if (i) {
      std::cout << ", ";
    }
    if (show >= 16 && v.size() > 20) {
      std::cout << "... (+" << (v.size() - 16) << " more)\n";
      return;
    }
    std::cout << std::setprecision(5) << v[i];
    ++show;
  }
  std::cout << "\n";
}

Options parse_args(int argc, char** argv) {
  Options o;
  if (char const* env = std::getenv("OTL_SHADER_DIR")) {
    o.shader_dir = env;
  }
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--assets" && i + 1 < argc) {
      o.n_assets = std::stoi(argv[++i]);
    } else if (a == "--len" && i + 1 < argc) {
      o.series_len = std::stoi(argv[++i]);
    } else if (a == "--bar" && i + 1 < argc) {
      o.bar_index = std::stoi(argv[++i]);
    } else if (a == "--shader-dir" && i + 1 < argc) {
      o.shader_dir = argv[++i];
    } else if (a == "--csv" && i + 1 < argc) {
      o.csv_path = argv[++i];
    } else if (a == "--seed" && i + 1 < argc) {
      o.seed = static_cast<unsigned int>(std::stoul(argv[++i]));
    } else if (a == "--osl-samples" && i + 1 < argc) {
      o.osl_max_assets = std::stoi(argv[++i]);
      o.osl_all         = false;
    } else if (a == "--osl-all") {
      o.osl_all         = true;
    } else if (a == "--no-tables") {
      o.print_tables = false;
    } else if (a == "-h" || a == "--help") {
      std::cout
          << "OTL_Sandbox: synthetic 64-asset (default) book → VectorTA → OSL m1_alpha → GAL\n"
          << "  --assets N  --len T  --bar B  --shader-dir P  --csv out.csv  --seed S\n"
          << "  --osl-samples M   (shorter OSL; default: --osl-all for every asset when OSL on)\n"
          << "  env OTL_SHADER_DIR  optional if --shader-dir not set\n";
      std::exit(0);
    }
  }
  if (!o.osl_all) {
    o.osl_max_assets = (std::max)(1, o.osl_max_assets);
  } else {
    o.osl_max_assets = o.n_assets;
  }
  return o;
}

static bool nearly_equal_f(float a, double b) {
  return std::abs(static_cast<double>(a) - b) < 1e-3 + 1e-6 * std::abs(b);
}

}  // namespace

int main(int argc, char** argv) {
  Options const opt = parse_args(argc, argv);

  otl::sandbox::SyntheticUniverse const synth(opt.n_assets, opt.series_len, opt.bar_index, opt.seed);
  otl::OtlUniverse universe;
  synth.fill(universe);

  // Intent 1-vector in R^N, then "Sector A" risk blade = span{e_0..e_10}.
  int const n = opt.n_assets;
  std::vector<double> intent_before(static_cast<std::size_t>(n), 0.0);
  for (int a = 0; a < n; ++a) {
    if (a <= 10) {
      intent_before[static_cast<std::size_t>(a)] = 1.0;  // fully in sector (projection → 0)
    } else {
      intent_before[static_cast<std::size_t>(a)] = 0.15 * static_cast<double>((a * 3) % 5) - 0.2;
    }
  }

  otl::RiskModel rm;
  for (int k = 0; k <= 10 && k < n; ++k) {
    std::vector<double> e(static_cast<std::size_t>(n), 0.0);
    e[static_cast<std::size_t>(k)] = 1.0;
    rm.risk_basis.push_back(std::move(e));
  }
  // Extra rotation slice (Milestone-1)
  std::size_t i_rot = 12;
  std::size_t j_rot = 15;
  if (n > 20) {
    // ok
  } else {
    i_rot = 0;
    j_rot = (n > 1) ? 1u : 0u;
  }
  std::vector<double> rebalanced = otl::rebalance_intent(intent_before, rm, i_rot, j_rot, 5.0);

  if (opt.print_tables) {
    std::cout << "=== OTL-Sandbox: GA ===\n";
    std::cout << "bar=" << opt.bar_index << "  assets=" << n << "  len=" << opt.series_len
              << "  risk basis: e_0..e_10 (Sector A)  Givens (" << i_rot << "," << j_rot
              << ") 5 deg\n";
    print_vec_block("  portfolio 1-vector (before, intent)", intent_before);
    print_vec_block("  portfolio 1-vector (after GA rotation on projected intent)", rebalanced);
    double s = 0.0;
    for (double x : rebalanced) {
      s += x;
    }
    std::cout << "  sum(after) = " << s << "\n\n";
  }

  // GA orthogonality: coordinates 0-10 of projected flow should be ~0
  if (n > 10) {
    double norm_sector = 0.0;
    for (int k = 0; k <= 10; ++k) {
      double x  = rebalanced[static_cast<std::size_t>(k)];
      norm_sector += x * x;
    }
    std::cout << "Success [2] GA orthogonality (Sector A, coords 0-10 l2) = " << std::setprecision(6)
              << std::sqrt(norm_sector) << (std::sqrt(norm_sector) < 1e-6 ? "  PASS" : "  CHECK")
              << "\n\n";
  }

  std::ostream* csv = nullptr;
  std::ofstream file;
  if (!opt.csv_path.empty()) {
    file.open(opt.csv_path, std::ios::out);
    if (!file) {
      std::cerr << "Failed to open --csv: " << opt.csv_path << "\n";
    } else {
      csv = &file;
    }
  }

  if (opt.print_tables) {
    std::cout << "=== Pipeline: asset, raw_close, VectorTA_rsi, osl_signal side, osl_price ===\n";
  }
  if (csv) {
    *csv << "asset,raw_close,vector_ta_rsi,osl_side,osl_price,close_matches_fix_price\n";
  }

  int osl_n = (std::min)(n, opt.osl_max_assets);
  if (!opt.shader_dir.empty() && osl_n > 0) {
    otl::MarketDelegate renderer(nullptr);
    renderer.prepare_ustring_lookups();
    OSL::ShadingSystem shadingsys(&renderer, nullptr, nullptr);
    shadingsys.attribute("searchpath:shader", opt.shader_dir.c_str());
    register_otl_m1_closures(&shadingsys);
    OSL::ShaderGroupRef const grp = shadingsys.ShaderGroupBegin("otl_sandbox_m1");
    if (!grp) {
      std::cerr << "ShaderGroupBegin failed\n";
      return 1;
    }
    shadingsys.Shader(*grp, "surface", "m1_alpha", "layer0");
    if (!shadingsys.ShaderGroupEnd(*grp)) {
      std::cerr << "ShaderGroupEnd failed; place m1_alpha.oso on searchpath:shader (oslc)\n";
      return 1;
    }
    OSL::PerThreadInfo* pti = shadingsys.create_thread_info();
    OSL::ShadingContext* ctx = shadingsys.get_context(pti);
    for (int a = 0; a < osl_n; ++a) {
      OSL::ShaderGlobals sg;
      std::memset(&sg, 0, sizeof(sg));
      otl::OtlRenderState rs;
      rs.universe  = &universe;
      rs.asset_id  = a;
      sg.renderstate = &rs;
      sg.renderer    = &renderer;
      sg.Ci          = nullptr;
      sg.P      = OSL::Vec3(0.0f, 0.0f, 0.0f);
      sg.N      = OSL::Vec3(0.0f, 0.0f, 1.0f);
      sg.I      = OSL::Vec3(0.0f, 0.0f, 1.0f);
      sg.u = 0.0f;
      sg.v = 0.0f;
      if (!shadingsys.execute(*ctx, *grp, sg, true)) {
        std::cerr << "execute failed asset " << a << "\n";
        shadingsys.release_context(ctx);
        shadingsys.destroy_thread_info(pti);
        return 1;
      }
      double const expected_close     = synth.last_close(a);
      double const last_rsi           = synth.last_rsi(a);
      bool got_closure                = false;
      otl::FixSignalLayout fix{};
      if (sg.Ci && otl::extract_first_fix_signal(sg.Ci, fix)) {
        got_closure = true;
      }
      bool const data_ok   = got_closure && nearly_equal_f(fix.price, expected_close);
      if (opt.print_tables && (a < 6 || a >= 31 && a < 35)) {  // sample up + down
        std::cout << "  a=" << a << " close=" << expected_close << " rsi=" << last_rsi
                  << (last_rsi > 50.0 ? "  trend_up(BUY side=1)" : "  trend_dn(SELL side=2)")
                  << "  fix_price=" << (got_closure ? static_cast<double>(fix.price) : -1.0) << (data_ok ? "  [1] data_ok" : "")
                  << (got_closure ? "  [3] closure ok" : "  [3] missing closure")
                  << "\n";
      }
      if (csv) {
        *csv << a << "," << std::setprecision(12) << expected_close << "," << last_rsi << ","
             << (got_closure ? static_cast<int>(fix.side) : -1) << ","
             << (got_closure ? static_cast<double>(fix.price) : 0) << ","
             << (data_ok ? "1" : "0") << "\n";
      }
    }
    shadingsys.release_context(ctx);
    shadingsys.destroy_thread_info(pti);
  } else {
    for (int a = 0; a < n; ++a) {
      if (opt.print_tables && (a < 4 || a >= n - 4 || a == 31 || a == 32)) {
        std::cout << "  a=" << a << " close=" << synth.last_close(a) << " rsi=" << synth.last_rsi(a)
                  << (a < 32 ? "  (trending_up group)" : "  (trending_down group)") << "\n";
      } else if (opt.print_tables && a == 4 && n > 12) {
        std::cout << "  ...\n";
      }
      if (csv) {
        *csv << a << "," << std::setprecision(12) << synth.last_close(a) << "," << synth.last_rsi(a)
             << ",-1,0,0\n";
      }
    }
  }

  if (!opt.shader_dir.empty() && osl_n > 0) {
    std::cout
        << "\nSuccess: [1] m_close (OtlUniverse) vs fix_signal.price — per-row in CSV, epsilon 1e-3.\n"
        << "          [2] See GA orthogonality line above (Sector A span e_0..e_10).\n"
        << "          [3] fix_signal extracted from sg.Ci after each execute().\n";
  } else {
    std::cout << "OSL: skipped. Set --shader-dir or OTL_SHADER_DIR (with m1_alpha.oso) for E2E.\n";
  }
  if (file.is_open()) {
    std::cout << "Wrote " << opt.csv_path << "\n";
  }

  return 0;
}
