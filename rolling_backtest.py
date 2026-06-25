#!/usr/bin/env python3
"""Rolling (prospective, time-stepped) back-test for the PR smoothed-seismicity forecast.

At each calendar quarter, train smoothed seismicity ONLY on events strictly before the
window start, build the same grid as build_forecast.py, take the top-20% cells as the
alarm zone, and score how many M>=3.5 test events in [start,end) fall in the alarm zone.
Appends a 'rolling' key to data/forecast.json, preserving meta/retro/live.
"""
import json, math, datetime
import numpy as np

# ---------- Read grid from forecast.json meta (stay consistent) ----------
with open('data/forecast.json') as fh:
    fc = json.load(fh)
META = fc['meta']
MINLAT = META['minlat']           # 17.0
MINLON = META['minlon']           # -68.5
CELL   = META['cellDeg']          # 0.1
NROWS  = META['nrows']            # 28
NCOLS  = META['ncols']            # 45
ALARM_TOP_PCT = 20
BANDWIDTH_KM = 10
UNIFORM_BG = 0.02
TEST_MINMAG = 3.5

# Cell centers (row r from south, col c from west) -- matches build_forecast.py
cell_lat = MINLAT + (np.arange(NROWS) + 0.5) * CELL
cell_lon = MINLON + (np.arange(NCOLS) + 0.5) * CELL
LAT2D = np.repeat(cell_lat[:, None], NCOLS, axis=1)
LON2D = np.repeat(cell_lon[None, :], NROWS, axis=0)

DEG2KM_LAT = 111.0
REF_LAT = 18.2
KM_PER_DEG_LON = 111.320 * math.cos(math.radians(REF_LAT))

# ---------- Load catalog (same padded-box restriction as build_forecast.py) ----------
MAXLAT, MAXLON = 19.75, -64.0
with open('data/pr_quakes.geojson') as fh:
    cat = json.load(fh)
feats = cat['features']
lon = np.array([ft['geometry']['coordinates'][0] for ft in feats], dtype=float)
lat = np.array([ft['geometry']['coordinates'][1] for ft in feats], dtype=float)
mag = np.array([ft['properties'].get('mag', float('nan')) for ft in feats], dtype=float)
time_ms = np.array([ft['properties']['time'] for ft in feats], dtype=float)

PAD = 0.5
inbox = (lon >= MINLON-PAD) & (lon <= MAXLON+PAD) & (lat >= MINLAT-PAD) & (lat <= MAXLAT+PAD)
lon, lat, mag, time_ms = lon[inbox], lat[inbox], mag[inbox], time_ms[inbox]


def smoothed_grid(elon, elat, weights, bandwidth_km, uniform_bg=UNIFORM_BG):
    """Gaussian KDE of events onto the grid. Returns normalized (sum=1) grid (NROWS,NCOLS).
    Identical to build_forecast.py's smoothed_grid."""
    grid = np.zeros((NROWS, NCOLS), dtype=float)
    if len(elon) == 0:
        grid[:] = 1.0 / (NROWS * NCOLS)
        return grid
    h = bandwidth_km
    inv2h2 = 1.0 / (2.0 * h * h)
    flat_lat = LAT2D.ravel()
    flat_lon = LON2D.ravel()
    acc = np.zeros(NROWS * NCOLS, dtype=float)
    CH = 2000
    for s in range(0, len(elon), CH):
        e_lo = elon[s:s+CH]; e_la = elat[s:s+CH]; w = weights[s:s+CH]
        dlat_km = (flat_lat[:, None] - e_la[None, :]) * DEG2KM_LAT
        dlon_km = (flat_lon[:, None] - e_lo[None, :]) * KM_PER_DEG_LON
        d2 = dlat_km**2 + dlon_km**2
        k = np.exp(-d2 * inv2h2)
        acc += (k * w[None, :]).sum(axis=1)
    grid = acc.reshape(NROWS, NCOLS)
    tot = grid.sum()
    if tot <= 0:
        grid[:] = 1.0 / (NROWS * NCOLS)
        return grid
    grid /= tot
    grid = (1.0 - uniform_bg) * grid + uniform_bg * (1.0 / (NROWS * NCOLS))
    grid /= grid.sum()
    return grid


def ts(dt):
    return dt.replace(tzinfo=datetime.timezone.utc).timestamp() * 1000.0


# ---------- Rolling windows: 91-day steps from 2011-01-01 through 2026-01-01 ----------
WINDOW_DAYS = 91
start_dt = datetime.datetime(2011, 1, 1)
final_dt = datetime.datetime(2026, 1, 1)
MIN_TRAIN = 50

top_cells_n = int(round((ALARM_TOP_PCT / 100.0) * (NROWS * NCOLS)))

series = []
cur = start_dt
while cur < final_dt:
    win_start = cur
    win_end = cur + datetime.timedelta(days=WINDOW_DAYS)
    t_start = ts(win_start)
    t_end = ts(win_end)

    train_mask = time_ms < t_start
    n_train = int(train_mask.sum())

    if n_train < MIN_TRAIN:
        cur = win_end
        continue

    grid = smoothed_grid(lon[train_mask], lat[train_mask],
                         np.ones(int(train_mask.sum())), BANDWIDTH_KM)

    # alarm zone = top 20% cells by likelihood
    flat = grid.ravel()
    order = np.argsort(flat)[::-1]
    rank = np.empty(flat.size, dtype=int)
    rank[order] = np.arange(flat.size)

    # test events in [start,end) with mag>=3.5, falling inside the grid proper
    tm = (time_ms >= t_start) & (time_ms < t_end) & (mag >= TEST_MINMAG)
    tlon = lon[tm]; tlat = lat[tm]
    r = np.floor((tlat - MINLAT) / CELL).astype(int)
    c = np.floor((tlon - MINLON) / CELL).astype(int)
    good = (r >= 0) & (r < NROWS) & (c >= 0) & (c < NCOLS)
    r = r[good]; c = c[good]
    n_ev = int(good.sum())

    if n_ev == 0:
        rec = {"start": win_start.strftime("%Y-%m-%d"), "nEvents": 0,
               "hit20": None, "lift": None}
    else:
        ev_flat = r * NCOLS + c
        ev_rank = rank[ev_flat]
        hit = float(np.sum(ev_rank < top_cells_n)) / n_ev
        lift = hit / (ALARM_TOP_PCT / 100.0)
        rec = {"start": win_start.strftime("%Y-%m-%d"), "nEvents": n_ev,
               "hit20": round(hit, 3), "lift": round(lift, 3)}
    series.append(rec)
    cur = win_end

# ---------- Append 'rolling' key, preserving meta/retro/live ----------
fc['rolling'] = {
    "windowDays": WINDOW_DAYS,
    "alarmTopPct": ALARM_TOP_PCT,
    "series": series,
}
with open('data/forecast.json', 'w') as fh:
    json.dump(fc, fh, separators=(',', ':'))

# ---------- Re-validate + report ----------
with open('data/forecast.json') as fh:
    chk = json.load(fh)
print("keys:", sorted(chk.keys()))
assert all(k in chk for k in ('meta', 'retro', 'live', 'rolling'))
ser = chk['rolling']['series']
print("number of windows:", len(ser))

scored = [s for s in ser if s['nEvents'] > 0]
top_by_n = sorted(ser, key=lambda s: s['nEvents'], reverse=True)[:8]
print("\nWindows with MOST test events:")
for s in top_by_n:
    print(f"  {s['start']}  n={s['nEvents']:4d}  hit20={s['hit20']}  lift={s['lift']}")

print("\nGuanica onset windows (2019-Q4 / 2020):")
for s in ser:
    if s['start'] >= '2019-10-01' and s['start'] < '2021-01-01':
        print(f"  {s['start']}  n={s['nEvents']:4d}  hit20={s['hit20']}  lift={s['lift']}")

hits = [s['hit20'] for s in scored]
lifts = [s['lift'] for s in scored]
print("\nscored windows (nEvents>0):", len(scored))
print("median hit20:", round(float(np.median(hits)), 3))
print("median lift :", round(float(np.median(lifts)), 3))
print("windows lift>1 (beat random):", sum(1 for l in lifts if l > 1))
print("windows lift<1 (underperform):", sum(1 for l in lifts if l < 1))
print("windows lift==1:", sum(1 for l in lifts if l == 1))
