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

- **See every significant earthquake** near Puerto Rico from 1915 to today (43,000+
  events), colored by depth and sized by magnitude.
- **Press "Play 2018–2021"** to watch the 2019–2020 Guánica earthquake sequence build
  up and unfold year by year.
- **Toggle layers**: the plate boundary and trenches, mapped faults, **GPS arrows**
  showing the direction the land is creeping (~2 cm/year), and historic landmark
  events (1918 Mona Passage tsunami, 2020 Guánica M6.4).
- **Filter** by minimum magnitude and time with the sliders.
- **Read the Risk snapshot**: a Gutenberg–Richter frequency chart, b-value, event
  rates, and the long-term hazard context — clearly labeled as *probabilistic
  forecasting, not prediction*.

## The tectonic picture

Puerto Rico sits on a small crustal block on the **boundary between the North
American and Caribbean plates**:
- **Puerto Rico Trench** (north) — the North American plate slides beneath; one of the
  deepest ocean trenches on Earth.
- **Muertos Trough** (south) — convergence from the Caribbean side.
- **Mona Passage** (west) — the rift zone that produced the deadly **1918 M7.1
  earthquake and tsunami**.

The land moves roughly **2 cm/year**. Strain builds on locked faults and releases as
earthquakes — which is exactly what the map shows.

## Where the data comes from

| Layer | Source |
|---|---|
| Earthquake catalog | **USGS ComCat** (FDSN event API) |
| Local network reference | **Red Sísmica de Puerto Rico**, UPR-Mayagüez |
| Live recent quakes | USGS real-time feed |
| Plate boundary | **PB2002** plate model (Bird, 2003) |
| Active faults | **GEM** Global Active Faults database |
| Land-motion (GPS) | **Nevada Geodetic Lab** (MIDAS); curated Caribbean stations as fallback |
| Tsunami / preparedness | **NOAA Caribbean Tsunami Warning Program** |
| Hazard context | **USGS National Seismic Hazard Model** (PR & USVI) |

## Refreshing the data (optional)

The dashboard reads pre-fetched files in `data/`. To pull the latest catalog:

```bash
python3 scripts/fetch_data.py
```

This uses only the Python standard library (no installs) and rewrites everything in
`data/`, including `data/data.js` (the bundle the dashboard loads).

## Files

```
index.html            the dashboard
app.js                map, layers, filters, charts, live feed
styles.css            styling (responsive)
data/                 pre-fetched datasets + data.js bundle
scripts/fetch_data.py one-time / refresh data fetcher
```

## Limits (stated plainly)

- No deterministic prediction of the next earthquake's time, place, or size.
- No earthquake prevention or delay — not achievable with current science.
- The risk model is statistical (hazard & rates), not a physics simulation of faults.
- For official warnings, rely on **Red Sísmica de Puerto Rico** and **NOAA**, not this tool.
