#include "VectorTAService.hpp"
#include "VectorTACxx.hpp"

#include "rust/cxx.h"

#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>

std::vector<double> otl::bake_series(std::string const& indicator_id, std::vector<double> const& input, int32_t const period) {
  rust::Vec<double> in;
  for (double v : input) {
    in.push_back(v);
  }
  rust::String const id{indicator_id};
  rust::Vec<double> out = otl::vta::bake_indicator_buffer_cxx(id, std::move(in), period);
  std::vector<double> r;
  r.reserve(out.size());
  for (std::size_t i = 0; i < out.size(); ++i) {
    r.push_back(out[i]);
  }
  return r;
}
