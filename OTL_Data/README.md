# OTL\_Data (Milestone 3)

Cached market data for the lab. **Not committed** by default (large files).

1. Ingest: `python scripts/fetch_market_data.py AAPL MSFT -o OTL_Data -period 1y`
2. Artifacts: `manifest.json`, `universe_close_matrix.csv`, `series/*.csv`
3. C++: `otl::data::load_universe_close_matrix("OTL_Data/universe_close_matrix.csv", u, nBars)`

Use `yfinance` + `pandas` (`pip install yfinance pandas`).
