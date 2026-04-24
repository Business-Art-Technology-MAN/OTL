#pragma once

#include <vector>

#include <OpenImageIO/ustring.h>
#include <OSL/rendererservices.h>
#include <OSL/shaderglobals.h>

#include "OtlUniverse.hpp"

namespace otl {

/// OSL `RendererServices` implementation: bridges `m_*` market attributes from `OtlUniverse`
/// (VectorTA-baked data) into the shading runtime as `float` user/attributes.
class MarketDelegate final : public OSL::RendererServices {
 public:
  explicit MarketDelegate(OSL::TextureSystem* texsys = nullptr);

  /// Pre-interns `m_*` names and caches `ustringhash`es so get_userdata / get_attribute
  /// compare hashes only (no per-call stringization). Call before shading; extend with
  /// `register_m_attribute` for new symbols.
  void prepare_ustring_lookups();
  void register_m_attribute(OIIO::ustring const& m_name);

  int supports(OSL::string_view feature) const override;

  bool get_userdata(bool derivatives, OSL::ustringhash name, OSL::TypeDesc type,
                    OSL::ShaderGlobals* sg, void* val) override;

  bool get_attribute(OSL::ShaderGlobals* sg, bool derivatives, OSL::ustringhash object,
                     OSL::TypeDesc type, OSL::ustringhash name, void* val) override;

  bool get_array_attribute(OSL::ShaderGlobals* sg, bool derivatives, OSL::ustringhash object,
                           OSL::TypeDesc type, OSL::ustringhash name, int index,
                           void* val) override;

 private:
  struct MAttrUstr {
    OIIO::ustring name;              // e.g. "m_close" (interned, stable c_str)
    OSL::ustringhash prehash;        // name.hash() — compare to incoming `ustringhash` only
  };

  std::vector<MAttrUstr> m_m_attrs;  // small list; default includes common indicators

  bool fetch_m(OSL::ShaderGlobals* sg, bool derivatives, OSL::ustringhash name, OSL::TypeDesc type,
               void* val) const;
};

}  // namespace otl
