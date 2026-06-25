#!/usr/bin/env python3
"""Build & back-test a CSEP-style smoothed-seismicity forecast for Puerto Rico."""
import json, math, datetime
import numpy as np

# ---------- Grid definition (fixed) ----------
MINLAT, MAXLAT = 17.0, 19.75
MINLON, MAXLON = -68.5, -64.0
CELL = 0.1
NROWS, NCOLS = 28, 45   # lat rows (south->north), lon cols (west->east)

# Cell center (r,c) = (MINLAT+(r+0.5)*CELL, MINLON+(c+0.5)*CELL)
cell_lat = MINLAT + (np.arange(NROWS) + 0.5) * CELL   # length 28
cell_lon = MINLON + (np.arange(NCOLS) + 0.5) * CELL   # length 45

# Precompute cell-center lat/lon meshes, row-major (r,c)
LAT2D = np.repeat(cell_lat[:, None], NCOLS, axis=1)   # (28,45)
LON2D = np.repeat(cell_lon[None, :], NROWS, axis=0)   # (28,45)

DEG2KM_LAT = 111.0
def deg2km_lon(lat):  # at a reference latitude
    return 111.320 * math.cos(math.radians(lat))
REF_LAT = 18.2
KM_PER_DEG_LON = deg2km_lon(REF_LAT)

# ---------- Load catalog ----------
with open('data/pr_quakes.geojson') as fh:
    cat = json.load(fh)
feats = cat['features']

lon = np.array([ft['geometry']['coordinates'][0] for ft in feats], dtype=float)
lat = np.array([ft['geometry']['coordinates'][1] for ft in feats], dtype=float)
mag = np.array([ft['properties'].get('mag', float('nan')) for ft in feats], dtype=float)
time_ms = np.array([ft['properties']['time'] for ft in feats], dtype=float)

# Keep only events inside (or near) the grid bbox for kernel work; we'll smooth
# events anywhere, but events far outside contribute ~0. Restrict to a padded box.
PAD = 0.5
inbox = (lon >= MINLON-PAD) & (lon <= MAXLON+PAD) & (lat >= MINLAT-PAD) & (lat <= MAXLAT+PAD)
lon, lat, mag, time_ms = lon[inbox], lat[inbox], mag[inbox], time_ms[inbox]

# Time helpers
def ts(y, m, d):
    return datetime.datetime(y, m, d, tzinfo=datetime.timezone.utc).timestamp() * 1000.0
T_TRAIN_BEFORE = ts(2019, 1, 1)
T_TEST_START   = ts(2019, 1, 1)
T_TEST_END     = ts(2021, 1, 1)
TEST_MINMAG = 3.5
MS_PER_YEAR = 365.25 * 24 * 3600 * 1000.0

UNIFORM_BG = 0.02   # 2% uniform background mixed in

# ---------- Kernel smoothing core ----------
def smoothed_grid(elon, elat, weights, bandwidth_km, uniform_bg=UNIFORM_BG):
    """Gaussian KDE of events onto the grid. Returns normalized (sum=1) grid (NROWS,NCOLS)."""
    grid = np.zeros((NROWS, NCOLS), dtype=float)
    if len(elon) == 0:
        grid[:] = 1.0 / (NROWS * NCOLS)
        return grid
    h = bandwidth_km
    inv2h2 = 1.0 / (2.0 * h * h)
    # vectorize over events in chunks to bound memory
    flat_lat = LAT2D.ravel()  # (1260,)
    flat_lon = LON2D.ravel()
    acc = np.zeros(NROWS * NCOLS, dtype=float)
    CH = 2000
    for s in range(0, len(elon), CH):
        e_lo = elon[s:s+CH]; e_la = elat[s:s+CH]; w = weights[s:s+CH]
        # distance in km between each cell center and each event
        dlat_km = (flat_lat[:, None] - e_la[None, :]) * DEG2KM_LAT
        dlon_km = (flat_lon[:, None] - e_lo[None, :]) * KM_PER_DEG_LON
        d2 = dlat_km**2 + dlon_km**2
        k = np.exp(-d2 * inv2h2)            # (1260, chunk)
        acc += (k * w[None, :]).sum(axis=1)
    grid = acc.reshape(NROWS, NCOLS)
    tot = grid.sum()
    if tot <= 0:
        grid[:] = 1.0 / (NROWS * NCOLS)
        return grid
    grid /= tot
    # mix uniform background
    grid = (1.0 - uniform_bg) * grid + uniform_bg * (1.0 / (NROWS * NCOLS))
    grid /= grid.sum()
    return grid

# ---------- Candidate model builders ----------
def build_model(name, params, train_mask, ref_time_ms):
    """ref_time_ms = the 'now' for recency weighting (end of training)."""
    elon = lon[train_mask]; elat = lat[train_mask]
    emag = mag[train_mask]; etime = time_ms[train_mask]
    bw = params['bandwidth_km']

    if name == 'smoothed':
        w = np.ones(len(elon))
        return smoothed_grid(elon, elat, w, bw)

    if name == 'recency':
        tau_yr = params['tau_yr']
        age_yr = (ref_time_ms - etime) / MS_PER_YEAR
        age_yr = np.clip(age_yr, 0, None)
        w = np.exp(-age_yr / tau_yr)
        return smoothed_grid(elon, elat, w, bw)

    if name == 'etas_lite':
        # base smoothed seismicity (magnitude-weighted, long memory) +
        # short-range triggering boost around recent (last trig_yr) events.
        # magnitude weight: 10^(mag-3) so bigger quakes weigh more (capped).
        mw = np.power(10.0, np.clip(emag - 3.0, -1.0, 2.0))
        base = smoothed_grid(elon, elat, mw, bw, uniform_bg=0.0)
        # triggering component: tight kernel around recent events
        trig_yr = params['trig_yr']
        recent = (ref_time_ms - etime) <= trig_yr * MS_PER_YEAR
        if recent.sum() > 0:
            tw = np.power(10.0, np.clip(emag[recent] - 3.0, -1.0, 2.0))
            trig = smoothed_grid(elon[recent], elat[recent], tw,
                                 params['trig_bw_km'], uniform_bg=0.0)
        else:
            trig = np.zeros((NROWS, NCOLS))
        mix = params['trig_weight']
        grid = (1.0 - mix) * base + mix * trig
        grid /= grid.sum()
        grid = (1.0 - UNIFORM_BG) * grid + UNIFORM_BG * (1.0 / (NROWS * NCOLS))
        grid /= grid.sum()
        return grid

    raise ValueError(name)

# ---------- Test events -> cell indices ----------
def test_event_cells():
    m = (time_ms >= T_TEST_START) & (time_ms < T_TEST_END) & (mag >= TEST_MINMAG)
    # also must fall inside the grid proper
    tlon = lon[m]; tlat = lat[m]
    r = np.floor((tlat - MINLAT) / CELL).astype(int)
    c = np.floor((tlon - MINLON) / CELL).astype(int)
    good = (r >= 0) & (r < NROWS) & (c >= 0) & (c < NCOLS)
    return r[good], c[good], int(good.sum()), int(m.sum())

# ---------- Scoring ----------
def score_model(grid, r_idx, c_idx):
    """Molchan/ROC: rank cells by likelihood desc; capture fraction vs area fraction."""
    flat = grid.ravel()
    order = np.argsort(flat)[::-1]          # high -> low
    ncell = flat.size
    # map each test event to flat cell index
    ev_flat = r_idx * NCOLS + c_idx
    # rank position of each cell in the sorted order
    rank = np.empty(ncell, dtype=int)
    rank[order] = np.arange(ncell)
    ev_rank = rank[ev_flat]                 # 0 = highest-likelihood cell
    n_ev = len(ev_flat)

    # Molchan curve: for each area fraction threshold, capture fraction
    area_fracs = np.linspace(0, 1, 11)
    molchan = []
    for af in area_fracs:
        ncells_alarmed = int(round(af * ncell))
        captured = np.sum(ev_rank < ncells_alarmed)
        molchan.append([round(float(af), 5), round(float(captured) / n_ev, 5) if n_ev else 0.0])

    # hit rate in top 20% area
    top20_cells = int(round(0.20 * ncell))
    hit20 = float(np.sum(ev_rank < top20_cells)) / n_ev if n_ev else 0.0

    # Area skill score: integrate (capture - area) over area frac (Molchan trapezoid).
    afs = np.array([p[0] for p in molchan]); caps = np.array([p[1] for p in molchan])
    auc = np.trapz(caps, afs) if hasattr(np, 'trapz') else np.trapezoid(caps, afs)
    area_skill = float(auc - 0.5)   # >0 means better than random; 0.5 is random AUC

    # Probability gain vs uniform: mean( log( p_cell / p_uniform ) ) over test events
    p_uniform = 1.0 / ncell
    p_ev = flat[ev_flat]
    prob_gain = float(np.exp(np.mean(np.log(p_ev / p_uniform)))) if n_ev else 0.0

    return {
        'hitRateTop20': round(hit20, 5),
        'areaSkill': round(area_skill, 5),
        'probGainVsUniform': round(prob_gain, 5),
        'molchan': molchan,
        'auc': round(float(auc), 5),
    }

# ============ RETRO BACK-TEST ============
r_idx, c_idx, n_test_ingrid, n_test_raw = test_event_cells()
print(f"Test events 2019-2021 M>=3.5 (in grid): {n_test_ingrid}  (raw mask: {n_test_raw})")

train_mask = time_ms < T_TRAIN_BEFORE
ref_time = T_TRAIN_BEFORE  # 'now' for recency = end of training period

candidates = [
    ('smoothed',  {'bandwidth_km': 10}),
    ('smoothed',  {'bandwidth_km': 15}),
    ('smoothed',  {'bandwidth_km': 25}),
    ('recency',   {'bandwidth_km': 10, 'tau_yr': 3.0}),
    ('recency',   {'bandwidth_km': 10, 'tau_yr': 1.5}),
    ('etas_lite', {'bandwidth_km': 15, 'trig_yr': 2.0, 'trig_bw_km': 8,
                   'trig_weight': 0.35}),
]

results = []
for name, params in candidates:
    g = build_model(name, params, train_mask, ref_time)
    sc = score_model(g, r_idx, c_idx)
    label = f"{name}(" + ",".join(f"{k}={v}" for k, v in params.items()) + ")"
    results.append((label, name, params, g, sc))
    print(f"{label:55s} hit20={sc['hitRateTop20']:.3f} "
          f"areaSkill={sc['areaSkill']:.3f} probGain={sc['probGainVsUniform']:.2f} "
          f"auc={sc['auc']:.3f}")

# ---------- Choose best (principled, skeptical) ----------
# Rule 1: a model must beat the uniform random baseline on the PROPER log-score
#         (probGain > 1). A model that scores worse than random by log-score is
#         disqualified no matter how good its top-20% capture looks -- high capture
#         with probGain<1 means it is gaming the area metric by piling probability
#         on a few high-rate cells that are NOT where the test events fall.
# Rule 2: among qualifying models, rank by hit20 then areaSkill then probGain.
# Rule 3: prefer the simplest model ('smoothed') if within ~0.015 hit20 of the best
#         (avoid overfitting; the back-test is noisy at ~820 events).
def keyf(r):
    sc = r[4]
    return (sc['hitRateTop20'], sc['areaSkill'], sc['probGainVsUniform'])
qualifying = [r for r in results if r[4]['probGainVsUniform'] > 1.0]
disqualified = [r for r in results if r[4]['probGainVsUniform'] <= 1.0]
for r in disqualified:
    print(f"  DISQUALIFIED (probGain<=1, worse than random by log-score): {r[0]}")
pool = qualifying if qualifying else results
ranked = sorted(pool, key=keyf, reverse=True)
best = ranked[0]
best_hit = best[4]['hitRateTop20']
simple_close = [r for r in pool if r[1] == 'smoothed'
                and best_hit - r[4]['hitRateTop20'] <= 0.015]
chosen = max(simple_close, key=keyf) if simple_close else best

print("\nCHOSEN:", chosen[0])
chosen_label, chosen_name, chosen_params, chosen_grid, chosen_sc = chosen

# Surprises: test events in cells below median likelihood
flat = chosen_grid.ravel()
ev_flat = r_idx * NCOLS + c_idx
order = np.argsort(flat)[::-1]
rank = np.empty(flat.size, dtype=int); rank[order] = np.arange(flat.size)
ev_rank = rank[ev_flat]
top20n = int(round(0.20*flat.size))
n_in_top20 = int(np.sum(ev_rank < top20n))
n_low = int(np.sum(ev_rank >= int(0.80*flat.size)))  # bottom 20% area
print(f"Of {n_test_ingrid} test events: {n_in_top20} in top-20% area; "
      f"{n_low} in bottom-20% area (surprises).")

# Sanity: highest-likelihood cell location
top_flat = order[0]
tr, tc = divmod(top_flat, NCOLS)
print(f"Peak cell center: lat={cell_lat[tr]:.2f}, lon={cell_lon[tc]:.2f} "
      f"(p={flat[top_flat]:.5f})")
# top 5
print("Top 5 cells:")
for k in range(5):
    fr, fc = divmod(order[k], NCOLS)
    print(f"  lat={cell_lat[fr]:.2f} lon={cell_lon[fc]:.2f} p={flat[order[k]]:.5f}")

# ============ LIVE FORECAST GRID ============
max_time = time_ms.max()
live_cutoff = max_time - 35 * 24 * 3600 * 1000.0
live_mask = time_ms < live_cutoff
live_ref = live_cutoff
live_grid = build_model(chosen_name, chosen_params, live_mask, live_ref)
print(f"\nLive grid trained on {int(live_mask.sum())} events "
      f"(excl last 35d, cutoff={datetime.datetime.utcfromtimestamp(live_cutoff/1000)}).")

# ============ WRITE forecast.json ============
def grid_to_list(g):
    # row-major r=0..27 (south->north), c=0..44 (west->east)
    return [round(float(x), 5) for x in g.ravel()]

out = {
    "meta": {
        "method": chosen_name,
        "params": chosen_params,
        "cellDeg": 0.1,
        "minlat": 17.0, "minlon": -68.5,
        "nrows": 28, "ncols": 45,
        "recommended_top_pct": 20,
        "forecastTarget": "relative likelihood of M>=3.5 epicenter per cell",
    },
    "retro": {
        "trainBefore": "2019-01-01", "testStart": "2019-01-01",
        "testEnd": "2021-01-01", "testMinMag": 3.5,
        "grid": grid_to_list(chosen_grid),
        "backtest": {
            "testEvents": n_test_ingrid,
            "hitRateTop20": chosen_sc['hitRateTop20'],
            "areaSkill": chosen_sc['areaSkill'],
            "probGainVsUniform": chosen_sc['probGainVsUniform'],
            "molchan": chosen_sc['molchan'],
        },
    },
    "live": {
        "trainExcludesLastDays": 35,
        "grid": grid_to_list(live_grid),
    },
}
with open('data/forecast.json', 'w') as fh:
    json.dump(out, fh, separators=(',', ':'))
print("\nWrote data/forecast.json  retro sum=%.5f live sum=%.5f" %
      (chosen_grid.sum(), live_grid.sum()))

# Save the candidate table for the report
with open('/tmp/cand_table.json', 'w') as fh:
    json.dump([{'label': r[0], 'hit20': r[4]['hitRateTop20'],
                'areaSkill': r[4]['areaSkill'],
                'probGain': r[4]['probGainVsUniform'],
                'auc': r[4]['auc']} for r in results], fh, indent=2)
