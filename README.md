# Puerto Rico Seismic Dashboard

An interactive map of where earthquakes happen around Puerto Rico, how the land is
slowly moving (plate motion), and what the long-term hazard looks like — built
entirely from free, authoritative public data.

> **Important honesty note.** This is a tool for **understanding and forecasting**,
> not a crystal ball. Earthquakes **cannot be predicted** (no one can say when/where
> the next one will strike), and they **cannot be prevented or delayed** with today's
> science. What protects people is preparedness, early warning, building codes, and
> tsunami readiness — all surfaced in the dashboard.

## How to open it

**Just double-click `index.html`** — it opens in your web browser. No installation,
no server, no coding. (An internet connection is needed for the background map tiles
and the optional "Live recent quakes" layer.)

## What you can do

- **Click anywhere on the map** to identify the nearest earthquake — magnitude, depth,
  date, and (for recent events) shaking intensity and felt-report counts.
- **See every significant earthquake** near Puerto Rico from 1915 to today (43,000+
  events), colored by depth and sized by magnitude, plus a **live "Latest & recent"**
  list (last 30 days) — tap any event to fly to it.
- **Press "Play 2018–2021"** to watch the 2019–2020 Guánica sequence unfold year by year.
- **Toggle layers**: plate boundary & trenches, mapped faults, **GPS land-motion arrows**
  (~1.5–2 cm/year toward the NNE), landmark events, and the **forecast likelihood heatmap**.
- **Run the forecast experiment** ("Forecast vs. reality"): a smoothed-seismicity model
  predicts *where* quakes are likely; score real events as hits/misses with an adjustable
  alarm-zone slider, a skill curve, and a rolling quarter-by-quarter back-test.
- **Read the Risk snapshot** (Gutenberg–Richter chart, b-value, rates), the **magnitude
  primer**, the **depth cross-section** (the subducting slab), and **Tsunami safety**.

## The tectonic picture

Puerto Rico sits on a small crustal block on the **boundary between the North
American and Caribbean plates**:
- **Puerto Rico Trench** (north) — the North American plate slides beneath; one of the
  deepest ocean trenches on Earth.
- **Muertos Trough** (south) — convergence from the Caribbean side.
- **Mona Passage** (west) — the rift zone that produced the deadly **1918 M7.1
  earthquake and tsunami**.

The land moves roughly **1.5–2 cm/year** toward the north-northeast. Strain builds on
locked faults and releases as earthquakes — which is exactly what the map shows.

## Where the data comes from

| Layer | Source |
|---|---|
| Earthquake catalog | **USGS ComCat** (FDSN event API) |
| Local network reference | **Red Sísmica de Puerto Rico**, UPR-Mayagüez |
| Live recent quakes | USGS real-time feed |
| Plate boundary | **PB2002** plate model (Bird, 2003) |
| Active faults | **GEM** Global Active Faults database |
| Land-motion (GPS) | **JPL** GNSS velocities (IGS14); curated Caribbean stations as fallback |
| Shaking intensity / felt | **USGS ShakeMap & "Did You Feel It?"** |
| Tsunami / preparedness | **NOAA Caribbean Tsunami Warning Program** |
| Hazard context | **USGS National Seismic Hazard Model** (PR & USVI) |
| Forecast model | Smoothed-seismicity (10 km Gaussian kernel), back-tested in `data/forecast.json` |

## Refreshing the data (optional)

The dashboard reads pre-fetched files in `data/`. To pull the latest catalog:

```bash
python3 scripts/fetch_data.py
```

This uses only the Python standard library (no installs) and rewrites everything in
`data/`, including `data/data.js` (the bundle the dashboard loads).

## Files

```
index.html              the dashboard
app.js                  map, layers, filters, charts, live feed, forecast experiment
styles.css              styling (responsive, collapsible panels)
data/data.js            the bundle the dashboard loads (all datasets, gzipped on serve)
data/forecast.json      forecast grids + retro/rolling back-test results
data/stats.json         Gutenberg–Richter / b-value / rates
data/*.geojson          catalog, plate boundary, faults, GPS, landmarks
scripts/fetch_data.py   one-time / refresh data fetcher
```

## Limits (stated plainly)

- No deterministic prediction of the next earthquake's time, place, or size.
- No earthquake prevention or delay — not achievable with current science.
- The risk model is statistical (hazard & rates), not a physics simulation of faults.
- For official warnings, rely on **Red Sísmica de Puerto Rico** and **NOAA**, not this tool.
