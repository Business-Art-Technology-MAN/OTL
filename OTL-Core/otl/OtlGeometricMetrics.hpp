#pragma once

#include <vector>

namespace otl {

/// Returns |cos θ| in [0,1] for **normalized** 1-vectors a, b; 0 if either norm ~ 0.
/// Used as *Geometric Efficiency* when **a** = raw OSL intent and **b** = realized trade direction Δw.
double geometric_alignment(std::vector<double> const& a, std::vector<double> const& b);

/// 1 - geometric_alignment  (0 = no wasted angle, 1 = orthogonal / fully “mis-rotated”).
double geometric_wastage(std::vector<double> const& a, std::vector<double> const& b);

}  // namespace otl
