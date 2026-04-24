#include "MarketDelegate.hpp"

#include <OpenImageIO/typedesc.h>
#include <OpenImageIO/ustring.h>
#include <cstring>

#include <OSL/encodedtypes.h>

using OIIO::TypeDesc;
using OSL::ustring;

namespace otl {

MarketDelegate::MarketDelegate(OSL::TextureSystem* texsys)
    : OSL::RendererServices(texsys) {}

void MarketDelegate::prepare_ustring_lookups() {
  m_m_attrs.clear();
  // Keep in sync with series registered on `OtlUniverse` and shaders (m1_alpha, M2+).
  static const char* const kDefaultM[] = {"m_close", "m_rsi", "m_sma"};
  for (const char* s : kDefaultM) {
    ustring u(s);
    m_m_attrs.push_back(MAttrUstr{u, OSL::ustringhash(u)});
  }
}

void MarketDelegate::register_m_attribute(ustring const& m_name) {
  m_m_attrs.push_back(MAttrUstr{m_name, OSL::ustringhash(m_name)});
}

int MarketDelegate::supports(OSL::string_view feature) const {
  if (feature == "build_attribute_getter" || feature == "build_interpolated_getter") {
    return 0;
  }
  return 0;
}

bool MarketDelegate::fetch_m(OSL::ShaderGlobals* sg, bool derivatives, OSL::ustringhash name,
                              OSL::TypeDesc type, void* val) const {
  if (type != TypeDesc::FLOAT) {
    return false;
  }
  if (!val || !sg) {
    return false;
  }
  auto* rs = reinterpret_cast<otl::OtlRenderState*>(sg->renderstate);
  if (!rs || !rs->universe) {
    return false;
  }
  int a = rs->asset_id;
  if (a < 0) {
    return false;
  }
  for (MAttrUstr const& e : m_m_attrs) {
    if (name == e.prehash) {
      return rs->universe->try_get_m(a, e.name.c_str(), derivatives, static_cast<float*>(val));
    }
  }
  return false;
}

bool MarketDelegate::get_userdata(bool derivatives, OSL::ustringhash name, OSL::TypeDesc type,
                                  OSL::ShaderGlobals* sg, void* val) {
  return fetch_m(sg, derivatives, name, type, val);
}

bool MarketDelegate::get_attribute(OSL::ShaderGlobals* sg, bool derivatives, OSL::ustringhash object,
                                    OSL::TypeDesc type, OSL::ustringhash name, void* val) {
  (void)object;
  return fetch_m(sg, derivatives, name, type, val);
}

bool MarketDelegate::get_array_attribute(OSL::ShaderGlobals* sg, bool derivatives,
                                            OSL::ustringhash object, OSL::TypeDesc type,
                                            OSL::ustringhash name, int index, void* val) {
  (void)object;
  if (index < 0) {
    return get_attribute(sg, derivatives, OSL::ustringhash(), type, name, val);
  }
  return false;
}

}  // namespace otl
