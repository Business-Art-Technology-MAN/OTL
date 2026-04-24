#!/usr/bin/env python3
"""
Build a four-panel Matplotlib figure from an OtlAnalytics CSV (see OtlAnalytics::write_csv):
  - Equity (from pnl_cumulative, normalized for display)
  - Drawdown (from equity)
  - Geometric efficiency
  - Turnover (L1, turnover_l1)

Usage:
  python scripts/plot_lab_results.py path/to/lab_run.csv
  python scripts/plot_lab_results.py path/to/lab_run.csv -o out.png
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


def _equity_from_pnl(s: pd.Series) -> pd.Series:
    """
    pnl_cumulative is a cumulative PnL mark. Use it as the equity *level*; if the series
    is near zero throughout, add 1.0 so drawdown is well-defined in relative terms.
    """
    e = s.astype(float)
    if e.isna().all():
        return e.fillna(0.0)
    span = float(e.max() - e.min()) if len(e) else 0.0
    if span < 1e-9 and float(e.iloc[-1] if len(e) else 0) == 0.0:
        return pd.Series(1.0, index=e.index, dtype=float)
    if float(e.min()) > -0.1 and float(e.max()) < 0.1 and float(e.std()) < 0.1:
        return 1.0 + e
    if float(e.min()) > 0.0:
        return e
    return 1.0 + e - float(e.iloc[0])


def plot_lab_csv(csv_path: Path, out: Path | None) -> int:
    df = pd.read_csv(csv_path)
    required = ["bar", "pnl_cumulative", "turnover_l1", "geometric_efficiency"]
    for c in required:
        if c not in df.columns:
            print(f"Missing column {c!r} in {csv_path}", file=sys.stderr)
            return 1

    t = df["bar"].to_numpy()
    equity = _equity_from_pnl(df["pnl_cumulative"])
    peak = equity.cummax()
    with np.errstate(divide="ignore", invalid="ignore"):
        drawdown = (equity - peak) / peak.replace(0, np.nan) * 100.0
    drawdown = drawdown.replace([np.inf, -np.inf], np.nan).fillna(0.0)

    fig, axes = plt.subplots(4, 1, sharex=True, figsize=(11, 9), layout="tight")
    fig.suptitle(f"Lab analytics — {csv_path.name}", fontsize=12)

    ax0, ax1, ax2, ax3 = axes
    ax0.plot(t, equity, color="C0", linewidth=1.0)
    ax0.set_ylabel("Equity (scaled)")
    ax0.grid(True, alpha=0.3)
    ax0.set_title("Equity")

    ax1.fill_between(t, drawdown, 0.0, color="C3", alpha=0.4, linewidth=0.0)
    ax1.plot(t, drawdown, color="C3", linewidth=0.8)
    ax1.set_ylabel("Drawdown %")
    ax1.grid(True, alpha=0.3)
    ax1.set_title("Drawdown")

    ax2.plot(t, df["geometric_efficiency"], color="C2", linewidth=0.9)
    ax2.set_ylabel("Efficiency (|cos θ|)")
    ax2.set_ylim(-0.05, 1.05)
    ax2.grid(True, alpha=0.3)
    ax2.set_title("Geometric efficiency")

    ax3.plot(t, df["turnover_l1"], color="C1", linewidth=0.9)
    ax3.set_ylabel("Turnover (L1)")
    ax3.set_xlabel("Bar")
    ax3.grid(True, alpha=0.3)
    ax3.set_title("Turnover")

    if out is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(out, dpi=150)
        print(f"Wrote {out.resolve()}")
    else:
        plt.show()
    plt.close(fig)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="OtlAnalytics CSV → 4-panel dashboard")
    p.add_argument("csv", type=Path, help="OtlAnalytics .csv (write_csv output)")
    p.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="Write PNG to this path (default: show interactively)",
    )
    a = p.parse_args()
    if not a.csv.is_file():
        print(f"Not a file: {a.csv}", file=sys.stderr)
        return 1
    return plot_lab_csv(a.csv, a.output)


if __name__ == "__main__":
    raise SystemExit(main())
