#!/usr/bin/env python3
# Yahoo → OTL_Data (see OTL_ENGINEERING_MILESTONE_3.md)
#  pip install yfinance pandas
#  optional: pip install pyarrow  (--parquet)

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime
from pathlib import Path

import pandas as pd


def _default(obj: object) -> str:
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    raise TypeError


def _close_frame(raw: pd.DataFrame, tickers: list[str]) -> pd.DataFrame:
    """
    yfinance: multi-ticker → MultiIndex columns (Ticker, Field) or (Field, Ticker).
    """
    if not isinstance(raw.columns, pd.MultiIndex):
        if len(tickers) == 1 and "Close" in raw.columns:
            return raw[["Close"]].rename(columns={"Close": tickers[0]})
        if len(tickers) == 1 and len(raw.columns) == 1:
            return raw.rename(columns={raw.columns[0]: tickers[0]})
        return raw

    level0, level1 = [list(raw.columns.get_level_values(i)) for i in range(2)]
    # (sym, 'Close') pattern
    out = {}
    for t in tickers:
        cands = [
            (t, "Close"),
            ("Close", t),
        ]
        s = None
        for a, b in cands:
            if a in level0 and b in level1 and (a, b) in raw.columns:
                s = raw[(a, b)]
                break
        if s is not None:
            out[t] = s
    if not out and "Close" in level0 or "Close" in level1:
        # some builds use columns level "Price" "Close"
        try:
            for t in tickers:
                if t in level0 and "Close" in raw[t].columns:
                    out[t] = raw[t]["Close"]
        except Exception:  # noqa: BLE001
            pass
    if not out:
        raise ValueError("Could not parse yfinance output — check versions.")
    dfc = pd.DataFrame(out)
    dfc = dfc.sort_index().ffill()
    if len(tickers) > 1:
        dfc = dfc.dropna(how="any")
    return dfc


def main() -> int:
    ap = argparse.ArgumentParser(description="Yahoo → OTL_OtlUniverse/Lab (OTL_Data).")
    ap.add_argument("tickers", nargs="*", help="AAPL MSFT ...")
    ap.add_argument("-t", "--tickers-file", type=Path, help="one symbol per line")
    ap.add_argument("-o", "--out", type=Path, default=Path("OTL_Data"))
    ap.add_argument("--period", default="1y")
    ap.add_argument("--interval", default="1d")
    ap.add_argument("--parquet", action="store_true")
    args = ap.parse_args()

    tickers = [x.strip().upper() for x in args.tickers if x.strip()]
    if args.tickers_file and args.tickers_file.is_file():
        for line in args.tickers_file.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if s and not s.startswith("#"):
                tickers.append(s.upper())
    tickers = list(dict.fromkeys(tickers))
    if not tickers:
        print("No tickers.", file=sys.stderr)
        return 1

    import yfinance as yf  # after argparse for faster --help

    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    (out / "series").mkdir(exist_ok=True)

    raw = yf.download(
        tickers,
        period=args.period,
        interval=args.interval,
        group_by="ticker",
        auto_adjust=True,
        progress=False,
        threads=True,
    )
    if raw is None or len(raw) < 1:
        print("yfinance: empty", file=sys.stderr)
        return 2

    close = _close_frame(raw, tickers)
    if close is None or close.empty:
        print("No Close data.", file=sys.stderr)
        return 2

    ts_order = [t for t in tickers if t in close.columns]
    udf = close.reset_index()
    tcol = udf.columns[0]
    udf = udf.rename(columns={tcol: "date"})
    udf["date"] = udf["date"].apply(
        lambda x: x.date().isoformat() if hasattr(x, "date") else (x.isoformat() if hasattr(x, "isoformat") else str(x))
    )
    udf2: pd.DataFrame = udf[["date"] + ts_order].copy() if all(t in udf.columns for t in ts_order) else udf
    renames = {t: f"close_{i}" for i, t in enumerate(ts_order)}
    udf2 = udf2.rename(columns=renames)
    mpath = out / "universe_close_matrix.csv"
    udf2.to_csv(mpath, index=False)
    print(f"Wrote {mpath}")

    for t in ts_order:
        if isinstance(raw.columns, pd.MultiIndex) and t in raw.columns.get_level_values(0):
            s = raw[t].reset_index()
        else:
            s = raw.reset_index() if len(ts_order) == 1 else close[[t]].reset_index()
        if len(s.columns) and str(s.columns[0]) not in ("Date", "date", "DatetimeIndex"):
            s = s.rename(columns={s.columns[0]: "Date"})
        p = out / "series" / f"{t}.csv"
        s.to_csv(p, index=False)
        print(f"Wrote {p}")

    manifest = {
        "schema": "OTL_M3_v1",
        "tickers": ts_order,
        "n_assets": len(ts_order),
        "n_bars": int(len(udf2)),
        "period": args.period,
        "interval": args.interval,
        "start": udf2["date"].iloc[0],
        "end": udf2["date"].iloc[-1],
        "paths": {
            "universe_close_matrix": "universe_close_matrix.csv",
        },
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (out / "otl_ingest_meta.json").write_text(json.dumps(manifest, indent=2, default=_default), encoding="utf-8")
    print(f"Wrote {out / 'manifest.json'}")

    if args.parquet:
        try:
            udf2.to_parquet(out / "panel.parquet", index=False)
            print("Wrote panel.parquet")
        except Exception as e:  # noqa: BLE001
            print("parquet:", e, file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
