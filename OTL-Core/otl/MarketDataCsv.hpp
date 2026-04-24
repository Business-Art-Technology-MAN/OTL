#pragma once

#include <string>
#include <vector>

namespace otl {
class OtlUniverse;
}

namespace otl::data {

/// Load `OTL_Data/universe_close_matrix.csv` (see scripts/fetch_market_data.py):
/// header `date,close_0,close_1,...`  →  `OtlUniverse` with `m_close` per asset.
/// `out_bars` = number of rows read (bars).
bool load_universe_close_matrix(std::string const& csv_path, OtlUniverse& out_u, int& out_bars);

}  // namespace otl::data
