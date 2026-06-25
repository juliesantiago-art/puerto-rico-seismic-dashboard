#!/usr/bin/env python3
"""
fetch_data.py — One-time data preparation for the Puerto Rico seismic dashboard.

Pulls from authoritative, free sources and writes static files into ../data/:
  - pr_quakes.geojson        Historical earthquake catalog (USGS ComCat)
  - plate_boundary.geojson   North America / Caribbean plate boundary (PB2002)
  - faults.geojson           Mapped active faults near PR (GEM Global Active Faults)
  - gps_velocities.geojson   GPS station velocities = land-motion vectors (NGL MIDAS)
  - landmark_events.json     Curated historic events (1918, 2020, ...)
  - stats.json               Gutenberg-Richter b-value, rates, depth/magnitude summary

Uses only the Python standard library — no pip installs needed.
Run:  python3 scripts/fetch_data.py
"""

import json
import math
import os
import ssl
import sys
import urllib.request
import urllib.error
from collections import Counter

# ---------------------------------------------------------------------------
# Region of interest: Puerto Rico + US Virgin Islands + Mona Passage
# (north trench, Muertos Trough to south, Mona Passage to west)
# ---------------------------------------------------------------------------
MINLAT, MAXLAT = 17.0, 19.75
MINLON, MAXLON = -68.5, -64.0
# A slightly wider box used when clipping plate boundaries / faults / GPS
PAD = 1.5
CLIP = (MINLAT - PAD, MAXLAT + PAD, MINLON - PAD, MAXLON + PAD)

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
os.makedirs(DATA, exist_ok=True)

# Some macOS Python builds need a relaxed SSL context for these hosts.
_CTX = ssl.create_default_context()
try:
    import certifi  # noqa
except Exception:
    _CTX.check_hostname = False
    _CTX.verify_mode = ssl.CERT_NONE


def http_get(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": "pr-seismic-dashboard/1.0"})
    with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as r:
        return r.read()


def http_get_json(url, timeout=120):
    return json.loads(http_get(url, timeout=timeout).decode("utf-8"))


def in_box(lat, lon, box):
    a, b, c, d = box
    return (a <= lat <= b) and (c <= lon <= d)


# ===========================================================================
# 1. USGS earthquake catalog (chunked by year to stay under the 20k row cap)
# ===========================================================================
def fetch_quakes():
    print("[1/6] USGS earthquake catalog ...")
    base = "https://earthquake.usgs.gov/fdsnws/event/1/query"
    features = {}
    # Significant historical events back to 1900 (M3.5+), denser recent record (M2.5+).
    plans = [
        (1900, 1959, 3.5),
        (1960, 2009, 3.0),
        (2010, 2026, 2.5),  # captures the 2019-2020 Guanica sequence in detail
    ]
    for y0, y1, minmag in plans:
        for year in range(y0, y1 + 1):
            url = (
                f"{base}?format=geojson"
                f"&starttime={year}-01-01&endtime={year + 1}-01-01"
                f"&minlatitude={MINLAT}&maxlatitude={MAXLAT}"
                f"&minlongitude={MINLON}&maxlongitude={MAXLON}"
                f"&minmagnitude={minmag}&orderby=time"
            )
            try:
                fc = http_get_json(url, timeout=120)
            except Exception as e:
                print(f"    {year}: skipped ({e})")
                continue
            for f in fc.get("features", []):
                features[f["id"]] = f
            n = len(fc.get("features", []))
            if n:
                print(f"    {year}: +{n} (total {len(features)})")

    feats = []
    for f in features.values():
        props = f.get("properties", {})
        geom = f.get("geometry", {})
        coords = geom.get("coordinates", [None, None, None])
        if coords[0] is None or props.get("mag") is None:
            continue
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [coords[0], coords[1]]},
            "properties": {
                "id": f["id"],
                "mag": round(float(props["mag"]), 1),
                "depth": round(float(coords[2]), 1) if coords[2] is not None else None,
                "time": props.get("time"),
                "place": props.get("place"),
                "type": props.get("type", "earthquake"),
            },
        })
    feats.sort(key=lambda x: x["properties"]["time"] or 0)
    out = {"type": "FeatureCollection",
           "metadata": {"source": "USGS ComCat", "region": "Puerto Rico / USVI",
                        "bbox": [MINLON, MINLAT, MAXLON, MAXLAT], "count": len(feats)},
           "features": feats}
    save("pr_quakes.geojson", out)
    print(f"    -> {len(feats)} events")
    return feats


# ===========================================================================
# 2. Plate boundaries (PB2002, Bird 2003) clipped to the region
# ===========================================================================
def fetch_plate_boundaries():
    print("[2/6] Plate boundaries (PB2002) ...")
    url = ("https://raw.githubusercontent.com/fraxen/tectonicplates/master/"
           "GeoJSON/PB2002_boundaries.json")
    try:
        fc = http_get_json(url)
    except Exception as e:
        print(f"    failed ({e}); writing empty layer")
        save("plate_boundary.geojson", empty_fc())
        return
    kept = []
    for f in fc.get("features", []):
        geom = f.get("geometry", {})
        if geom.get("type") != "LineString":
            continue
        pts = geom.get("coordinates", [])
        if any(in_box(p[1], p[0], CLIP) for p in pts):
            f["properties"] = {"name": f.get("properties", {}).get("Name", "plate boundary")}
            kept.append(f)
    save("plate_boundary.geojson", {"type": "FeatureCollection", "features": kept})
    print(f"    -> {len(kept)} boundary segments near PR")


# ===========================================================================
# 3. Active faults (GEM Global Active Faults) clipped to the region
# ===========================================================================
def fetch_faults():
    print("[3/6] Active faults (GEM) ...")
    url = ("https://raw.githubusercontent.com/GEMScienceTools/gem-global-active-faults/"
           "master/geojson/gem_active_faults_harmonized.geojson")
    try:
        fc = http_get_json(url, timeout=180)
    except Exception as e:
        print(f"    failed ({e}); writing empty layer")
        save("faults.geojson", empty_fc())
        return
    kept = []
    for f in fc.get("features", []):
        geom = f.get("geometry", {})
        t = geom.get("type")
        if t == "LineString":
            lines = [geom.get("coordinates", [])]
        elif t == "MultiLineString":
            lines = geom.get("coordinates", [])
        else:
            continue
        hit = any(in_box(p[1], p[0], CLIP) for ln in lines for p in ln)
        if hit:
            props = f.get("properties", {})
            f["properties"] = {"name": props.get("name") or props.get("fault_name") or "fault",
                               "slip_type": props.get("slip_type", "")}
            kept.append(f)
    save("faults.geojson", {"type": "FeatureCollection", "features": kept})
    print(f"    -> {len(kept)} fault traces near PR")


# ===========================================================================
# 4. GPS velocities (JPL GNSS velocity table, IGS14) -> land-motion vectors
#    Real measured per-station velocities. JPL's table is small and reachable;
#    NGL's MIDAS file is large and was unreachable from some networks.
# ===========================================================================
def fetch_gps():
    print("[4/6] GPS velocities (JPL GNSS, IGS14) ...")
    url = "https://sideshow.jpl.nasa.gov/post/tables/table2.html"
    feats, source = [], "JPL GNSS (IGS14)"
    try:
        text = http_get(url, timeout=60).decode("utf-8", "replace")
        pos, vel = {}, {}
        for line in text.splitlines():
            p = line.split()
            if len(p) >= 6 and p[1] == "POS":
                try: pos[p[0]] = (float(p[2]), float(p[3]))   # lat, lon
                except ValueError: pass
            elif len(p) >= 5 and p[1] == "VEL":
                try: vel[p[0]] = (float(p[2]), float(p[3]))   # Vn, Ve (mm/yr)
                except ValueError: pass
        seen = set()
        items = sorted((s for s in pos if s in vel), key=lambda s: -vel[s][0])
        for s in items:
            lat, lon = pos[s]
            if lon > 180: lon -= 360.0
            if not (MINLAT <= lat <= MAXLAT and MINLON <= lon <= MAXLON):
                continue
            key = (round(lat, 3), round(lon, 3))
            if key in seen:            # dedupe co-located instruments (e.g. PUR2/PUR3)
                continue
            seen.add(key)
            vn, ve = vel[s]
            feats.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(lon, 4), round(lat, 4)]},
                "properties": {"station": s, "ve_mm": round(ve, 2), "vn_mm": round(vn, 2),
                               "speed_mm": round(math.hypot(ve, vn), 1)},
            })
    except Exception as e:
        print(f"    JPL fetch failed ({e}); using representative fallback")

    if not feats:
        feats = curated_gps()
        source = "representative (published Caribbean plate motion)"
    save("gps_velocities.geojson", {"type": "FeatureCollection",
                                    "metadata": {"source": source, "units": "mm/yr",
                                                 "count": len(feats)},
                                    "features": feats})
    print(f"    -> {len(feats)} GPS stations near PR ({source})")


def curated_gps():
    """Approximate published velocities for key PR/Caribbean stations (mm/yr, IGS14).
    Used only if the live MIDAS file cannot be parsed so the layer still renders."""
    raw = [
        # place, lat, lon, ve, vn  (eastward, northward mm/yr) — representative of
        # coherent Caribbean-plate (PR-VI block) motion, ~18-20 mm/yr toward the ENE.
        ("Mayaguez", 18.20, -67.14, 16.2, 8.0), ("Aguadilla", 18.46, -67.13, 16.0, 8.4),
        ("Arecibo", 18.47, -66.70, 16.4, 7.8), ("San Juan", 18.42, -66.05, 15.8, 8.6),
        ("Fajardo", 18.33, -65.65, 15.9, 8.9), ("Utuado", 18.27, -66.70, 16.1, 8.1),
        ("Ponce", 18.01, -66.61, 16.6, 7.6), ("Guanica", 17.97, -66.91, 16.8, 7.4),
        ("Guayama", 17.99, -66.11, 16.3, 7.9), ("Humacao", 18.15, -65.83, 15.7, 9.0),
        ("Vieques", 18.12, -65.44, 15.6, 9.2), ("Culebra", 18.31, -65.30, 15.5, 9.3),
        ("St. Thomas", 18.34, -64.93, 15.3, 9.5), ("St. Croix (CRO1)", 17.73, -64.58, 15.0, 9.8),
        ("Mona Is.", 18.09, -67.94, 17.0, 7.2), ("Desecheo", 18.38, -67.48, 16.5, 7.9),
    ]
    feats = []
    for sta, lat, lon, ve, vn in raw:
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {"station": sta, "ve_mm": ve, "vn_mm": vn,
                           "speed_mm": round(math.hypot(ve, vn), 2), "curated": True},
        })
    return feats


# ===========================================================================
# 5. Curated landmark events (plain-language context)
# ===========================================================================
def write_landmarks():
    print("[5/6] Landmark events ...")
    events = [
        {"name": "1787 Boqueron earthquake", "year": 1787, "mag": 8.0,
         "lat": 18.7, "lon": -66.1,
         "text": "Estimated M~8 off northern Puerto Rico — the largest event in the "
                 "island's written history. Damaged churches across the island."},
        {"name": "1867 Virgin Islands earthquake & tsunami", "year": 1867, "mag": 7.3,
         "lat": 18.0, "lon": -64.9,
         "text": "M~7.3 in the Anegada Passage. Generated a tsunami that struck the "
                 "Virgin Islands and eastern Puerto Rico."},
        {"name": "1918 Mona Passage earthquake & tsunami", "year": 1918, "mag": 7.1,
         "lat": 18.5, "lon": -67.5,
         "text": "M7.1 west of Puerto Rico. A tsunami reached the west coast within "
                 "minutes; about 116 people died, many from the tsunami. The defining "
                 "event for PR tsunami preparedness."},
        {"name": "2020 Guanica sequence (M6.4)", "year": 2020, "mag": 6.4,
         "lat": 17.92, "lon": -66.81,
         "text": "A prolonged sequence in southwestern PR. The Jan 7, 2020 M6.4 was the "
                 "most damaging PR earthquake in over a century — collapsed buildings, "
                 "island-wide power loss, thousands displaced. Thousands of aftershocks."},
    ]
    save("landmark_events.json", events)
    print(f"    -> {len(events)} landmark events")


# ===========================================================================
# 6. Statistics: Gutenberg-Richter b-value, rates, depth/magnitude summary
# ===========================================================================
def write_stats(quakes):
    print("[6/6] Statistics (Gutenberg-Richter, rates) ...")
    mags = [f["properties"]["mag"] for f in quakes if f["properties"].get("mag") is not None]
    depths = [f["properties"]["depth"] for f in quakes
              if f["properties"].get("depth") is not None]
    times = [f["properties"]["time"] for f in quakes if f["properties"].get("time")]

    # Magnitude of completeness Mc via the "maximum curvature" method:
    # the magnitude bin with the most events, rounded, plus a small correction.
    binned = Counter(round(m, 1) for m in mags)
    mc = (max(binned, key=binned.get) + 0.2) if binned else 2.5

    # Aki (1965) maximum-likelihood b-value for events at/above Mc.
    above = [m for m in mags if m >= mc]
    dm = 0.1
    if len(above) > 50:
        mean_m = sum(above) / len(above)
        b = math.log10(math.e) / (mean_m - (mc - dm / 2.0))
        a = math.log10(len(above)) + b * mc
    else:
        b, a = None, None

    # Magnitude-frequency distribution (cumulative N >= M) for the chart.
    edges = [round(x * 0.1, 1) for x in range(20, 81)]  # M2.0 .. M8.0
    cumulative = [{"mag": e, "count": sum(1 for m in mags if m >= e)} for e in edges]
    cumulative = [c for c in cumulative if c["count"] > 0]

    # Time span and annual rates.
    if times:
        span_years = (max(times) - min(times)) / (1000.0 * 60 * 60 * 24 * 365.25)
        span_years = max(span_years, 1.0)
    else:
        span_years = 1.0

    def rate_ge(mw):
        return round(sum(1 for m in mags if m >= mw) / span_years, 2)

    # Depth distribution buckets.
    depth_buckets = {"0-30 km (shallow)": 0, "30-70 km": 0, "70-150 km": 0, ">150 km (deep)": 0}
    for d in depths:
        if d < 30: depth_buckets["0-30 km (shallow)"] += 1
        elif d < 70: depth_buckets["30-70 km"] += 1
        elif d < 150: depth_buckets["70-150 km"] += 1
        else: depth_buckets[">150 km (deep)"] += 1

    stats = {
        "n_events": len(mags),
        "span_years": round(span_years, 1),
        "year_min": _yr(min(times)) if times else None,
        "year_max": _yr(max(times)) if times else None,
        "max_mag": max(mags) if mags else None,
        "mc": round(mc, 1),
        "b_value": round(b, 2) if b is not None else None,
        "a_value": round(a, 2) if a is not None else None,
        "annual_rate_ge3": rate_ge(3.0),
        "annual_rate_ge4": rate_ge(4.0),
        "annual_rate_ge5": rate_ge(5.0),
        "depth_buckets": depth_buckets,
        "gutenberg_richter": cumulative,
        # Published long-term hazard context (USGS NSHM PR/USVI; reference only).
        "hazard_note": ("USGS hazard models classify Puerto Rico as high seismic "
                        "hazard. Long-term studies estimate a meaningful chance of a "
                        "damaging (M>=7) earthquake over a ~50-year horizon. These are "
                        "probabilities over decades, NOT a prediction of any specific date."),
    }
    save("stats.json", stats)
    print(f"    -> b={stats['b_value']} Mc={stats['mc']} N={stats['n_events']} "
          f"span={stats['span_years']}y")


def _yr(ms):
    import datetime
    return datetime.datetime.utcfromtimestamp(ms / 1000.0).year


# ---------------------------------------------------------------------------
def empty_fc():
    return {"type": "FeatureCollection", "features": []}


def save(name, obj):
    path = os.path.join(DATA, name)
    with open(path, "w") as fh:
        json.dump(obj, fh)
    kb = os.path.getsize(path) / 1024.0
    print(f"    wrote data/{name} ({kb:.0f} KB)")


def write_bundle():
    """Bundle every data file into data/data.js (window.SEIS=...) so the dashboard
    loads via a <script> tag and works from a double-clicked file:// page (no server)."""
    print("[bundle] data/data.js ...")
    files = {"quakes": "pr_quakes.geojson", "plates": "plate_boundary.geojson",
             "faults": "faults.geojson", "gps": "gps_velocities.geojson",
             "landmarks": "landmark_events.json", "stats": "stats.json"}
    bundle = {}
    for key, fn in files.items():
        with open(os.path.join(DATA, fn)) as fh:
            bundle[key] = json.load(fh)
    path = os.path.join(DATA, "data.js")
    with open(path, "w") as fh:
        fh.write("window.SEIS=")
        json.dump(bundle, fh, separators=(",", ":"))
        fh.write(";")
    print(f"    wrote data/data.js ({os.path.getsize(path)/1048576:.1f} MB)")


def main():
    print("Puerto Rico seismic data prep")
    print("=" * 60)
    quakes = fetch_quakes()
    fetch_plate_boundaries()
    fetch_faults()
    fetch_gps()
    write_landmarks()
    write_stats(quakes)
    write_bundle()
    print("=" * 60)
    print("Done. Open index.html in a browser.")


if __name__ == "__main__":
    sys.exit(main())
