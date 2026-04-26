#include "mlab/OslM1Shading.hpp"

#include "otl/ExtractFixSignal.hpp"
#include "otl/FixSignalClosure.hpp"
#include "otl/MarketDelegate.hpp"
#include "otl/OtlUniverse.hpp"
#include "otl/RegisterOtlM1Closures.hpp"

#include <OSL/oslexec.h>
#include <OSL/shaderglobals.h>

#include <cstdlib>
#include <cstring>

using json = nlohmann::json;

namespace mlab::host {

struct OslM1Shading::Impl {
  std::string                 dir;
  otl::MarketDelegate*        renderer{nullptr};
  OSL::ShadingSystem*         shadingsys{nullptr};
  OSL::PerThreadInfo*         pti{nullptr};
  OSL::ShadingContext*        ctx{nullptr};
  OSL::ShaderGroupRef         group{};

  ~Impl() {
    shutdown_gsl();
  }

  void shutdown_gsl() {
    group.reset();
    if (shadingsys) {
      if (ctx) {
        shadingsys->release_context(ctx);
        ctx = nullptr;
      }
      if (pti) {
        shadingsys->destroy_thread_info(pti);
        pti = nullptr;
      }
    }
    if (shadingsys) {
      delete shadingsys;
      shadingsys = nullptr;
    }
    if (renderer) {
      delete renderer;
      renderer = nullptr;
    }
    dir.clear();
  }
};

void OslM1Shading::clear() {
  m_impl.reset();
}

bool OslM1Shading::is_ready() const {
  return m_impl && m_impl->shadingsys && m_impl->ctx && m_impl->group;
}

bool OslM1Shading::try_init(std::string const& shader_dir, std::string& err) {
  err.clear();
  clear();
  if (shader_dir.empty()) {
    err = "empty shader dir";
    return false;
  }
  auto p = std::make_unique<Impl>();
  p->dir = shader_dir;
  try {
    p->renderer = new otl::MarketDelegate(nullptr);
    p->renderer->prepare_ustring_lookups();
    p->shadingsys = new OSL::ShadingSystem(p->renderer, nullptr, nullptr);
    p->shadingsys->attribute("searchpath:shader", p->dir.c_str());
    register_otl_m1_closures(p->shadingsys);
    p->pti  = p->shadingsys->create_thread_info();
    p->ctx  = p->shadingsys->get_context(p->pti);
    p->group = p->shadingsys->ShaderGroupBegin("otl_m1_marketlab");
    if (!p->group) {
      err = "ShaderGroupBegin failed";
      p->shutdown_gsl();
      return false;
    }
    p->shadingsys->Shader(*p->group, "surface", "m1_alpha", "layer0");
    if (!p->shadingsys->ShaderGroupEnd(*p->group)) {
      err = "ShaderGroupEnd failed; place m1_alpha.oso on searchpath:shader (oslc m1_alpha.osl)";
      p->shutdown_gsl();
      return false;
    }
  } catch (std::exception const& e) {
    err = e.what();
    p->shutdown_gsl();
    return false;
  } catch (...) {
    err = "OSL init: unknown error";
    p->shutdown_gsl();
    return false;
  }
  m_impl = std::move(p);
  return is_ready();
}

bool OslM1Shading::execute(otl::OtlUniverse& u, int asset_id, json& out, std::string& err) {
  err.clear();
  out = json::object();
  if (!is_ready() || !m_impl->group) {
    err = "OSL not ready";
    return false;
  }
  OSL::ShadingContext* c = m_impl->ctx;
  if (!c) {
    err = "no ShadingContext";
    return false;
  }
  OSL::ShaderGlobals sg;
  std::memset(&sg, 0, sizeof(sg));
  otl::OtlRenderState rs;
  rs.universe  = &u;
  rs.asset_id  = asset_id;
  sg.renderstate = &rs;
  sg.renderer    = m_impl->renderer;
  sg.Ci          = nullptr;
  sg.P       = OSL::Vec3(0.0f, 0.0f, 0.0f);
  sg.N       = OSL::Vec3(0.0f, 0.0f, 1.0f);
  sg.I       = OSL::Vec3(0.0f, 0.0f, 1.0f);
  sg.u = 0.0f;
  sg.v = 0.0f;
  if (!m_impl->shadingsys->execute(*c, *m_impl->group, sg, true)) {
    out["executed"] = false;
    out["error"]    = "ShadingSystem::execute failed";
    err             = "execute failed";
    return false;
  }
  out["executed"] = true;
  out["group"]    = "otl_m1_marketlab";
  out["layer"]    = "m1_alpha";
  otl::FixSignalLayout fix{};
  if (sg.Ci && otl::extract_first_fix_signal(sg.Ci, fix)) {
    json jf        = json::object();
    jf["side"]     = static_cast<double>(fix.side);
    jf["quantity"] = static_cast<double>(fix.quantity);
    jf["price"]    = static_cast<double>(fix.price);
    out["fix_signal"] = std::move(jf);
  } else {
    out["fix_signal"] = nullptr;
  }
  return true;
}

OslM1Shading::OslM1Shading()  = default;
OslM1Shading::~OslM1Shading() = default;

}  // namespace mlab::host
