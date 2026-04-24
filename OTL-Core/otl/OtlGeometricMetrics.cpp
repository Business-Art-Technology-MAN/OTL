#include "OtlGeometricMetrics.hpp"

#include <cmath>
#include <cstddef>

namespace otl {

static double dot(std::vector<double> const& a, std::vector<double> const& b) {
  if (a.size() != b.size()) {
    return 0.0;
  }
  double s = 0.0;
  for (std::size_t i = 0; i < a.size(); ++i) {
    s += a[i] * b[i];
  }
  return s;
}

static double l2(std::vector<double> const& v) {
  return std::sqrt(std::max(0.0, dot(v, v)));
}

double geometric_alignment(std::vector<double> const& a, std::vector<double> const& b) {
  if (a.empty() || a.size() != b.size()) {
    return 0.0;
  }
  double const na = l2(a);
  double const nb = l2(b);
  if (na < 1e-30 || nb < 1e-30) {
    return 0.0;
  }
  double c = std::abs(dot(a, b) / (na * nb));
  if (c > 1.0) {
    c = 1.0;
  }
  return c;
}

double geometric_wastage(std::vector<double> const& a, std::vector<double> const& b) {
  return 1.0 - geometric_alignment(a, b);
}

}  // namespace otl
