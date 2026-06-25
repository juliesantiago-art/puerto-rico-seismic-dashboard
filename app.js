/* Puerto Rico Seismic Dashboard
   Reads window.SEIS (from data/data.js). Live feed from USGS over HTTPS.
   Forecasting/visualization only — NOT an earthquake prediction or alert system. */

(function () {
  "use strict";
  // Never let the "Loading…" overlay hang forever: if data or a library failed
  // to load, or anything throws during init, show a clear message + refresh hint.
  function fail(msg) {
    const ld = document.getElementById("loading");
    if (ld) { ld.innerHTML = msg + '<br><br><a href="" onclick="location.reload();return false" style="color:#4aa8ff">Reload ↻</a>'; ld.style.display = "block"; }
  }
  if (!window.SEIS) { return fail("Couldn’t load the earthquake data. Please hard-refresh (Cmd/Ctrl+Shift+R)."); }
  if (typeof L === "undefined") { return fail("The map library didn’t load — check your connection, then refresh."); }
  try {
  const S = window.SEIS || {};
  const QUAKES = (S.quakes && S.quakes.features) || [];
  const YEAR_MS = 1000 * 60 * 60 * 24 * 365.25;

  // ---- Map -----------------------------------------------------------------
  const map = L.map("map", { zoomControl: true, preferCanvas: true })
    .setView([18.2, -66.4], 8);
  L.tileLayer("https://cartodb-basemaps-{s}.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO", subdomains: "abcd", maxZoom: 19,
  }).addTo(map);
  // Single shared canvas renderer for ALL circle markers (historical + live + GPS).
  // Keeping everything on one canvas is what makes every dot clickable — a second
  // stacked canvas would intercept clicks meant for the layer beneath it.
  const canvas = L.canvas({ padding: 0.5 });
  // Forecast heatmap below the quakes; hit/miss markers above. Both panes are
  // pointer-events:none so they never intercept the map's click handler.
  map.createPane("fcPane"); map.getPane("fcPane").style.zIndex = 350; map.getPane("fcPane").style.pointerEvents = "none";
  map.createPane("exPane"); map.getPane("exPane").style.zIndex = 460; map.getPane("exPane").style.pointerEvents = "none";
  const fcRenderer = L.canvas({ pane: "fcPane", padding: 0.5 });
  const exRenderer = L.canvas({ pane: "exPane", padding: 0.5 });

  // ---- Depth color / magnitude size ---------------------------------------
  function depthColor(d) {
    if (d == null) return "#888";
    if (d < 30) return "#ff5d5d";
    if (d < 70) return "#ff9f40";
    if (d < 150) return "#ffd166";
    return "#6fe0c8";
  }
  function magRadius(m) { return Math.max(2, Math.pow(Math.max(m, 0), 1.7) * 0.7); }

  // Relative "time ago" for the live/recent panel.
  function ago(ms) {
    if (!ms) return "";
    const s = (Date.now() - ms) / 1000;
    if (s < 90) return Math.round(s) + "s ago";
    if (s < 5400) return Math.round(s / 60) + " min ago";
    if (s < 172800) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }

  // Modified Mercalli shaking intensity → plain-language label + Roman numeral.
  function mmiInfo(v) {
    if (v == null || v < 1.5) return null;
    const t = [[2, "Weak", "II"], [3.5, "Light", "III"], [4.5, "Moderate", "IV"],
              [5.5, "Strong", "V"], [6.5, "Very strong", "VI"], [7.5, "Severe", "VII"],
              [8.5, "Violent", "VIII"], [99, "Extreme", "IX+"]];
    for (const [lim, label, roman] of t) if (v < lim) return { label, roman };
    return { label: "Extreme", roman: "IX+" };
  }

  // ---- Earthquake layer ----------------------------------------------------
  const quakeLayer = L.layerGroup();
  let magMin = 3.5, yearMax = 2026;
  let liveData = []; // recent quakes (lat/lon/mag/...) for the click+hover handler

  function fmtDate(ms) {
    if (!ms) return "—";
    const d = new Date(ms);
    return d.toISOString().slice(0, 10);
  }

  function renderQuakes() {
    quakeLayer.clearLayers();
    const cutoff = Date.UTC(yearMax + 1, 0, 1);
    let n = 0;
    for (const f of QUAKES) {
      const p = f.properties;
      if (p.mag == null || p.mag < magMin) continue;
      if (p.time && p.time >= cutoff) continue;
      const c = f.geometry.coordinates;
      // Display-only: clicks are handled by the map-level handler below so they
      // are reliable and forgiving (a second stacked canvas would otherwise eat
      // per-dot clicks). interactive:false lets the map click fall through.
      quakeLayer.addLayer(L.circleMarker([c[1], c[0]], {
        renderer: canvas, radius: magRadius(p.mag), interactive: false,
        color: depthColor(p.depth), weight: 0.6, fillColor: depthColor(p.depth),
        fillOpacity: 0.55, opacity: 0.9,
      }));
      n++;
    }
    document.getElementById("count").textContent =
      `${n.toLocaleString()} events shown  (M ≥ ${magMin.toFixed(1)}, through ${yearMax})`;
    // Re-draw the live layer last so the blue "recent" dots stay on top of the
    // freshly-rendered historical dots (same canvas, so all stay clickable).
    if (typeof liveLayer !== "undefined" && map.hasLayer(liveLayer)) {
      liveLayer.removeFrom(map);
      liveLayer.addTo(map);
    }
  }

  // ---- Tectonics: plate boundary (data) + curated trenches/troughs ---------
  const tectLayer = L.layerGroup();
  function buildTectonics() {
    const plates = (S.plates && S.plates.features) || [];
    plates.forEach(f => L.geoJSON(f, {
      style: { color: "#ff6ec7", weight: 2.5, opacity: 0.85, dashArray: "1 0" },
    }).bindTooltip("North America – Caribbean plate boundary").addTo(tectLayer));

    // Curated regional structures (labels + approximate traces) for context.
    const curated = [
      { name: "Puerto Rico Trench (NA plate subducts ~SSW)",
        pts: [[19.6, -68.4], [19.5, -67.0], [19.55, -65.6], [19.6, -64.4]], color: "#ff6ec7" },
      { name: "Muertos Trough (convergence from the south)",
        pts: [[17.5, -68.2], [17.55, -67.0], [17.7, -65.6], [17.85, -64.6]], color: "#c77dff" },
      { name: "Mona Passage rift (1918 source area)",
        pts: [[18.95, -67.55], [18.4, -67.45], [18.0, -67.3]], color: "#a78bfa" },
    ];
    curated.forEach(s => {
      L.polyline(s.pts, { color: s.color, weight: 2, opacity: 0.7, dashArray: "6 6" })
        .bindTooltip(s.name, { sticky: true }).addTo(tectLayer);
      const mid = s.pts[Math.floor(s.pts.length / 2)];
      L.marker(mid, { icon: L.divIcon({
        className: "", html: `<div style="color:${s.color};font-size:10px;white-space:nowrap;text-shadow:0 0 4px #000">${s.name.split("(")[0].trim()}</div>`,
        iconSize: [10, 10] }) }).addTo(tectLayer);
    });
  }

  // ---- Faults --------------------------------------------------------------
  const faultLayer = L.geoJSON(S.faults || { type: "FeatureCollection", features: [] }, {
    style: { color: "#ffb347", weight: 1.3, opacity: 0.8 },
    onEachFeature: (ft, ly) => ly.bindTooltip(
      (ft.properties && (ft.properties.name || "fault")) +
      (ft.properties && ft.properties.slip_type ? " · " + ft.properties.slip_type : "")),
  });

  // ---- GPS land-motion arrows ----------------------------------------------
  // Each arrow = one location's measured ground motion. Direction = which way the
  // land is creeping; length & on-hover number = how fast (mm/yr). The whole
  // PR block drifts together toward the NNE at ~1.5-2 cm/yr.
  const gpsLayer = L.layerGroup();
  const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                   "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const compass = az => COMPASS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];
  function buildGPS() {
    const feats = (S.gps && S.gps.features) || [];
    const SCALE = 0.014; // degrees of arrow length per mm/yr
    feats.forEach(f => {
      const [lon, lat] = f.geometry.coordinates;
      const p = f.properties;
      const az = (Math.atan2(p.ve_mm, p.vn_mm) * 180 / Math.PI + 360) % 360;
      const tipLon = lon + (p.ve_mm * SCALE) / Math.cos(lat * Math.PI / 180);
      const tipLat = lat + (p.vn_mm * SCALE);
      // shaft (display only)
      L.polyline([[lat, lon], [tipLat, tipLon]],
        { renderer: canvas, interactive: false, color: "#7ee787", weight: 2.5, opacity: 0.9 })
        .addTo(gpsLayer);
      // base dot (display only)
      L.circleMarker([lat, lon], { renderer: canvas, interactive: false, radius: 2.5,
        color: "#7ee787", fillColor: "#0d1117", fillOpacity: 1, weight: 1.5 }).addTo(gpsLayer);
      // interactive arrowhead (DOM marker → reliably hoverable/clickable)
      const head = L.marker([tipLat, tipLon], { icon: L.divIcon({ className: "gps-ic",
        html: `<div class="gps-arrow" style="transform:rotate(${az}deg)">▲</div>`,
        iconSize: [16, 16], iconAnchor: [8, 8] }) });
      head.bindTooltip(`${p.station}: ${p.speed_mm.toFixed(1)} mm/yr ${compass(az)}`,
        { direction: "top", className: "mag-tip gps-tip", opacity: 0.97 });
      head.bindPopup(`<div class="pp-mag" style="color:#7ee787">${p.station}</div>` +
        `The ground here is moving <b>${p.speed_mm.toFixed(1)} mm/yr</b> ` +
        `(${(p.speed_mm / 10).toFixed(1)} cm/yr) toward the <b>${compass(az)}</b>.<br>` +
        `East ${p.ve_mm.toFixed(1)} · North ${p.vn_mm.toFixed(1)} mm/yr` +
        (p.curated ? "<br><i>approximate / representative value</i>" : ""));
      head.addTo(gpsLayer);
    });
  }

  // ---- Landmark events -----------------------------------------------------
  const landmarkLayer = L.layerGroup();
  function buildLandmarks() {
    (S.landmarks || []).forEach(e => {
      L.marker([e.lat, e.lon], { icon: L.divIcon({ className: "lmk", html: "★",
        iconSize: [24, 24], iconAnchor: [12, 12] }) })
        .bindPopup(`<div class="pp-mag" style="color:#ffd166">M ${e.mag} · ${e.year}</div>` +
          `<b>${e.name}</b><br>${e.text}`)
        .addTo(landmarkLayer);
    });
  }

  // ---- Live USGS feed (works over HTTPS even from file://) ------------------
  const liveLayer = L.layerGroup();
  let liveLoaded = false;
  function loadLive() {
    if (liveLoaded) return;
    liveLoaded = true;
    const url = "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson" +
      "&starttime=" + new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10) +
      "&minlatitude=17&maxlatitude=19.75&minlongitude=-68.5&maxlongitude=-64&minmagnitude=2";
    fetch(url).then(r => r.json()).then(fc => {
      const feats = (fc.features || []);
      liveData = feats.map(f => {
        const c = f.geometry.coordinates, p = f.properties;
        const inten = Math.max(p.mmi || 0, p.cdi || 0);   // shaking intensity (MMI)
        return { lat: c[1], lon: c[0], mag: p.mag != null ? p.mag : 0,
                 place: p.place, time: p.time,
                 depth: c[2] != null ? Math.round(c[2]) : null,
                 felt: p.felt || 0, mmi: inten || null, tsunami: p.tsunami || 0,
                 url: p.url, isLive: true };
      });
      liveData.sort((a, b) => b.time - a.time);
      liveData.forEach(q => {
        L.circleMarker([q.lat, q.lon], {
          renderer: canvas, radius: Math.max(5, magRadius(q.mag) + 2), interactive: false,
          color: "#4aa8ff", weight: 2.5, fillColor: depthColor(q.depth), fillOpacity: 0.8,
        }).addTo(liveLayer);
      });
      const note = document.getElementById("live-note");
      if (note) note.textContent = `${feats.length} quakes in the last 30 days — hover or click any blue dot.`;
      buildRecent();
      if (typeof FC !== "undefined" && FC && fcExercise === "live") applyExercise();
    }).catch(() => {
      liveLoaded = false;
      const note = document.getElementById("live-note");
      if (note) note.textContent = "Couldn’t reach the USGS live feed (needs internet).";
    });
  }

  // ---- Latest & recent quakes panel ----------------------------------------
  function quakeFlyTo(q) {
    map.flyTo([q.lat, q.lon], Math.max(map.getZoom(), 10), { duration: 0.8 });
    L.popup({ offset: [0, -4] }).setLatLng([q.lat, q.lon])
      .setContent(quakePopupHTML(q)).openOn(map);
  }
  function buildRecent() {
    const latest = document.getElementById("latest");
    const list = document.getElementById("recent-list");
    if (!latest || !list || !liveData.length) return;
    const top = liveData[0], mi = mmiInfo(top.mmi);
    latest.innerHTML =
      `<div class="lt-mag" style="color:${depthColor(top.depth)}">M ${top.mag.toFixed(1)}</div>` +
      `<div class="lt-meta"><b>${top.place || "Puerto Rico region"}</b><br>` +
      `${ago(top.time)} · depth ${top.depth != null ? top.depth + " km" : "—"}${mi ? " · " + mi.label + " shaking" : ""}</div>`;
    latest.onclick = () => quakeFlyTo(top);
    latest.setAttribute("role", "button");
    latest.setAttribute("tabindex", "0");
    latest.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); quakeFlyTo(top); } };
    list.innerHTML = liveData.slice(0, 14).map((q, i) =>
      `<button class="rc" data-i="${i}">` +
      `<span class="rc-m" style="background:${depthColor(q.depth)}">${q.mag.toFixed(1)}</span>` +
      `<span class="rc-p">${q.place || "PR region"}</span>` +
      `<span class="rc-t">${ago(q.time)}${q.felt ? " · felt " + q.felt : ""}</span></button>`).join("");
    list.querySelectorAll(".rc").forEach(b =>
      b.addEventListener("click", () => quakeFlyTo(liveData[+b.dataset.i])));
  }

  // ---- Depth cross-section (the subducting slab) ---------------------------
  function buildCrossSection() {
    const el = document.getElementById("xsection");
    if (!el || !window.Chart) return;
    const exC = Chart.getChart && Chart.getChart(el); if (exC) exC.destroy();
    const pts = [];
    for (const f of QUAKES) {
      const p = f.properties;
      if (p.mag == null || p.mag < 3.5 || p.depth == null) continue;
      pts.push({ x: f.geometry.coordinates[1], y: p.depth, d: p.depth });
    }
    let data = pts;
    const SAMPLE = 2500;
    if (pts.length > SAMPLE) {
      data = []; const step = pts.length / SAMPLE;
      for (let i = 0; i < pts.length; i += step) data.push(pts[Math.floor(i)]);
    }
    new Chart(el, {
      type: "scatter",
      data: { datasets: [{ data: data.map(d => ({ x: d.x, y: d.y })),
        pointRadius: 1.4, pointBackgroundColor: data.map(d => depthColor(d.d)), pointBorderWidth: 0 }] },
      options: { plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { title: { display: true, text: "south  ←  latitude  →  north (trench)", color: "#9aa7b4", font: { size: 9 } },
               min: 17, max: 19.8, ticks: { color: "#9aa7b4", font: { size: 8 } }, grid: { color: "#222a35" } },
          y: { reverse: true, title: { display: true, text: "depth (km)", color: "#9aa7b4", font: { size: 9 } },
               min: 0, max: 220, ticks: { color: "#9aa7b4", font: { size: 8 } }, grid: { color: "#222a35" } } } },
    });
  }

  // ---- Forecast model: heatmap layer + hit/miss back-test exercise ---------
  const FC = S.forecast || null;
  const fcLayer = L.layerGroup();   // likelihood heatmap (below quakes)
  const exLayer = L.layerGroup();   // alarm-zone outline + hit/miss dots (above)
  let fcExercise = "live";          // 'live' | 'retro'
  let fcPct = (FC && FC.meta && FC.meta.recommended_top_pct) || 20;
  let fcCurveChart = null;

  function fcCellIndex(lat, lon) {
    const m = FC.meta;
    const r = Math.floor((lat - m.minlat) / m.cellDeg);
    const c = Math.floor((lon - m.minlon) / m.cellDeg);
    if (r < 0 || r >= m.nrows || c < 0 || c >= m.ncols) return -1;
    return r * m.ncols + c;
  }
  function fcHeatColor(t) { // 0..1 → purple→magenta→orange→yellow
    const s = [[0, [59, 28, 106]], [0.4, [142, 43, 226]], [0.7, [255, 110, 199]], [1, [255, 209, 102]]];
    let a = s[0], b = s[s.length - 1];
    for (let i = 0; i < s.length - 1; i++) if (t >= s[i][0] && t <= s[i + 1][0]) { a = s[i]; b = s[i + 1]; break; }
    const f = (t - a[0]) / ((b[0] - a[0]) || 1);
    const ch = k => Math.round(a[1][k] + (b[1][k] - a[1][k]) * f);
    return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
  }
  function fcCellBounds(i) {
    const m = FC.meta, r = Math.floor(i / m.ncols), c = i % m.ncols;
    const lat0 = m.minlat + r * m.cellDeg, lon0 = m.minlon + c * m.cellDeg;
    return [[lat0, lon0], [lat0 + m.cellDeg, lon0 + m.cellDeg]];
  }
  function renderForecastHeat() {
    fcLayer.clearLayers();
    if (!FC) return;
    const grid = FC[fcExercise].grid, max = Math.max.apply(null, grid);
    for (let i = 0; i < grid.length; i++) {
      const t = grid[i] / max;
      if (t < 0.04) continue;
      L.rectangle(fcCellBounds(i), { renderer: fcRenderer, interactive: false, stroke: false,
        fillColor: fcHeatColor(t), fillOpacity: 0.12 + 0.55 * Math.sqrt(t) }).addTo(fcLayer);
    }
  }
  function fcAlarmSet(grid, pct) {
    const order = grid.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]);
    const n = Math.max(1, Math.round(grid.length * pct / 100));
    const set = new Set();
    for (let i = 0; i < n; i++) set.add(order[i][1]);
    return set;
  }
  function fcTestEvents() {
    if (fcExercise === "live") return liveData.map(q => ({ lat: q.lat, lon: q.lon, mag: q.mag }));
    const t0 = Date.UTC(2019, 0, 1), t1 = Date.UTC(2021, 0, 1), out = [];
    for (const f of QUAKES) {
      const p = f.properties;
      if (p.mag == null || p.mag < 3.5 || !p.time || p.time < t0 || p.time >= t1) continue;
      const c = f.geometry.coordinates; out.push({ lat: c[1], lon: c[0], mag: p.mag });
    }
    return out;
  }
  function scoreForecast() {
    if (!FC) return;
    const grid = FC[fcExercise].grid, alarm = fcAlarmSet(grid, fcPct), events = fcTestEvents();
    exLayer.clearLayers();
    alarm.forEach(i => L.rectangle(fcCellBounds(i),
      { renderer: exRenderer, interactive: false, fill: false, color: "#4dd2ff", weight: 0.6, opacity: 0.45 }).addTo(exLayer));
    let hits = 0, scored = 0;
    events.forEach(e => {
      const idx = fcCellIndex(e.lat, e.lon);
      if (idx < 0) return;
      scored++;
      const hit = alarm.has(idx);
      if (hit) hits++;
      L.circleMarker([e.lat, e.lon], { renderer: exRenderer, interactive: false, radius: 4,
        color: hit ? "#7ee787" : "#ff5d5d", weight: 1.5, fillColor: hit ? "#7ee787" : "#ff5d5d", fillOpacity: 0.55 }).addTo(exLayer);
    });
    const misses = scored - hits, hitRate = scored ? hits / scored : 0, lift = fcPct ? hitRate / (fcPct / 100) : 0;
    const sg = document.getElementById("fc-stats");
    if (sg) sg.innerHTML = [
      [scored, "events tested"], [hits, "✓ hits (in zone)"],
      [misses, "✗ misses (surprises)"], [scored ? lift.toFixed(2) + "×" : "—", "better than guessing"],
    ].map(c => `<div class="stat"><div class="v">${c[0]}</div><div class="k">${c[1]}</div></div>`).join("");
    const note = document.getElementById("fc-note");
    if (note) note.innerHTML = fcExercise === "retro"
      ? `Trained <b>only on pre-2019 data</b>, so it can't know the Guánica fault would rupture — its hot zone honestly sits in the NE (Virgin Islands). It still lands ${(hitRate * 100).toFixed(0)}% of the ${scored} sequence events in the top ${fcPct}% area (<b>${lift.toFixed(1)}× chance</b>). The red misses are the real surprises.`
      : (scored ? `Trained on data up to ~35 days ago, scored against the live last-30-day feed: <b>${hits}/${scored}</b> recent events fell in the top ${fcPct}% likelihood area (<b>${lift.toFixed(1)}× chance</b>).`
                : `Waiting for the live feed… (or no recent events in range).`);
    if (fcCurveChart) {
      fcCurveChart.data.datasets[2].data = scored ? [{ x: fcPct, y: hitRate * 100 }] : [];
      fcCurveChart.update("none");
    }
  }
  // Skill curve (Molchan-style): % of quakes caught vs % of area "alarmed".
  function fcSkillCurve() {
    const grid = FC[fcExercise].grid;
    const order = grid.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]);
    const rank = new Array(grid.length);
    order.forEach((pi, r) => { rank[pi[1]] = r; });
    const N = grid.length, evRanks = [];
    fcTestEvents().forEach(e => { const idx = fcCellIndex(e.lat, e.lon); if (idx >= 0) evRanks.push(rank[idx] / N); });
    const total = evRanks.length, steps = 25, curve = [];
    for (let k = 0; k <= steps; k++) {
      const a = k / steps;
      curve.push({ x: a * 100, y: total ? evRanks.filter(r => r < a + 1e-9).length / total * 100 : 0 });
    }
    return curve;
  }
  function renderSkillCurve() {
    const el = document.getElementById("fc-curve");
    if (!el || !window.Chart) return;
    if (fcCurveChart) { fcCurveChart.destroy(); fcCurveChart = null; }
    fcCurveChart = new Chart(el, { type: "line",
      data: { datasets: [
        { data: fcSkillCurve(), borderColor: "#9b4dca", backgroundColor: "rgba(155,77,202,.15)", borderWidth: 2, pointRadius: 0, fill: true, tension: .2 },
        { data: [{ x: 0, y: 0 }, { x: 100, y: 100 }], borderColor: "#6b7785", borderWidth: 1, borderDash: [4, 4], pointRadius: 0 },
        { data: [], borderColor: "#ffd166", backgroundColor: "#ffd166", pointRadius: 4, showLine: false } ] },
      options: { parsing: false, plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { type: "linear", min: 0, max: 100, title: { display: true, text: "alarm area (% of region)", color: "#b0bbc7", font: { size: 9 } }, ticks: { color: "#b0bbc7", font: { size: 8 } }, grid: { color: "#222a35" } },
          y: { min: 0, max: 100, title: { display: true, text: "% of quakes caught", color: "#b0bbc7", font: { size: 9 } }, ticks: { color: "#b0bbc7", font: { size: 8 } }, grid: { color: "#222a35" } } } } });
  }

  // Rolling prospective back-test: lift per calendar quarter (trained only on the past).
  function buildRolling() {
    const el = document.getElementById("fc-rolling");
    if (!el || !window.Chart || !FC || !FC.rolling) { const w = document.getElementById("fc-rolling-wrap"); if (w && !(FC && FC.rolling)) w.style.display = "none"; return; }
    const ex = Chart.getChart && Chart.getChart(el); if (ex) ex.destroy();
    const series = FC.rolling.series.filter(s => s.lift != null);
    const pts = series.map(s => ({ x: s.start, y: s.lift }));
    const colors = series.map(s => s.lift >= 1 ? "#7ee787" : "#ff5d5d");
    new Chart(el, { type: "line",
      data: { labels: series.map(s => s.start),
        datasets: [
          { data: pts.map(p => p.y), borderColor: "#7ee787", borderWidth: 1.5, pointRadius: 2.5, pointBackgroundColor: colors, pointBorderWidth: 0, tension: .15 },
          { data: series.map(() => 1), borderColor: "#6b7785", borderWidth: 1, borderDash: [4, 4], pointRadius: 0 } ] },
      options: { plugins: { legend: { display: false },
          tooltip: { callbacks: { title: c => c[0].label, label: c => `${c.raw}× random (${series[c.dataIndex].nEvents} quakes)` } } },
        scales: {
          x: { ticks: { color: "#b0bbc7", font: { size: 8 }, maxTicksLimit: 7, callback: function (v) { const l = this.getLabelForValue(v); return l ? l.slice(0, 4) : l; } }, grid: { color: "#222a35" } },
          y: { min: 0, title: { display: true, text: "× better than random", color: "#b0bbc7", font: { size: 9 } }, ticks: { color: "#b0bbc7", font: { size: 8 } }, grid: { color: "#222a35" } } } } });
  }

  function applyExercise() { if (map.hasLayer(fcLayer)) renderForecastHeat(); renderSkillCurve(); scoreForecast(); }
  function buildForecast() {
    if (!FC) {
      ["forecast", "lyr-forecast-row"].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = "none"; });
      return;
    }
    document.getElementById("fc-pct").textContent = fcPct + "%";
    document.getElementById("fc-slider").value = fcPct;
    renderSkillCurve(); scoreForecast(); buildRolling();
  }

  // ---- Stats panel + Gutenberg-Richter chart -------------------------------
  function buildStats() {
    const st = S.stats || {};
    const grid = document.getElementById("stat-grid");
    const cards = [
      [st.n_events != null ? st.n_events.toLocaleString() : "—", `events on record (${st.year_min}–${st.year_max})`],
      [st.max_mag != null ? "M " + st.max_mag : "—", "strongest in catalog"],
      [st.b_value != null ? st.b_value : "—", "b-value (size mix of quakes)"],
      [st.annual_rate_ge4 != null ? st.annual_rate_ge4 + "/yr" : "—", "rate of M≥4 events"],
    ];
    grid.innerHTML = cards.map(c =>
      `<div class="stat"><div class="v">${c[0]}</div><div class="k">${c[1]}</div></div>`).join("");
    document.getElementById("gr-note").textContent = st.hazard_note || "";

    // Only plot at/above the catalog's completeness magnitude (Mc) — below it the
    // record is incomplete and the curve flattens into a misleading plateau.
    const gr = (st.gutenberg_richter || []).filter(d => d.mag >= (st.mc || 2.5));
    if (gr.length && window.Chart) {
      const grEl = document.getElementById("gr-chart");
      const exG = Chart.getChart && Chart.getChart(grEl); if (exG) exG.destroy();
      new Chart(grEl, {
        type: "line",
        data: { labels: gr.map(d => d.mag),
          datasets: [{ label: "events ≥ magnitude (log)", data: gr.map(d => d.count),
            borderColor: "#4aa8ff", backgroundColor: "rgba(74,168,255,.15)",
            pointRadius: 0, borderWidth: 2, fill: true, tension: .25 }] },
        options: { plugins: { legend: { labels: { color: "#9aa7b4", font: { size: 10 } } } },
          scales: {
            y: { type: "logarithmic", ticks: { color: "#9aa7b4", font: { size: 9 } },
                 grid: { color: "#222a35" } },
            x: { title: { display: true, text: "magnitude", color: "#9aa7b4", font: { size: 10 } },
                 ticks: { color: "#9aa7b4", font: { size: 9 }, maxTicksLimit: 8 },
                 grid: { color: "#222a35" } } } },
      });
    }
  }

  // ---- Wiring --------------------------------------------------------------
  function toggle(id, layer) {
    const el = document.getElementById(id);
    el.addEventListener("change", () => el.checked ? layer.addTo(map) : map.removeLayer(layer));
  }

  buildTectonics(); buildGPS(); buildLandmarks(); buildStats(); buildCrossSection(); buildForecast(); renderQuakes();
  quakeLayer.addTo(map); tectLayer.addTo(map); gpsLayer.addTo(map); landmarkLayer.addTo(map);

  toggle("lyr-quakes", quakeLayer);
  toggle("lyr-tect", tectLayer);
  toggle("lyr-faults", faultLayer);
  toggle("lyr-gps", gpsLayer);
  toggle("lyr-landmark", landmarkLayer);
  const liveCb = document.getElementById("lyr-live");
  liveCb.addEventListener("change", e => {
    if (e.target.checked) { loadLive(); liveLayer.addTo(map); } else map.removeLayer(liveLayer);
  });
  if (liveCb.checked) { loadLive(); liveLayer.addTo(map); } // on by default

  // Collapsible explainer panels — collapsed by default to cut the scroll.
  document.querySelectorAll(".panel.collapsible > h2").forEach(h => {
    h.setAttribute("role", "button"); h.setAttribute("tabindex", "0");
    const toggle = () => {
      const panel = h.parentElement;
      const open = panel.classList.toggle("open");
      // Charts built while hidden initialise at 0px — rebuild them once the
      // panel has real dimensions (timeout lets layout settle).
      if (open && window.Chart) setTimeout(() => {
        if (panel.id === "risk") buildStats();
        else if (panel.id === "xsec") buildCrossSection();
        else if (panel.id === "forecast") { renderSkillCurve(); buildRolling(); scoreForecast(); }
      }, 80);
    };
    h.addEventListener("click", toggle);
    h.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  });

  // One-time on-map hint so people discover click-to-identify.
  const hint = document.getElementById("map-hint");
  if (hint) {
    let hintSeen = false;
    try { hintSeen = localStorage.getItem("pr_hint") === "1"; } catch (e) {}
    if (hintSeen) hint.style.display = "none";
    const dismissHint = () => { hint.style.display = "none"; try { localStorage.setItem("pr_hint", "1"); } catch (e) {} };
    const hx = document.getElementById("map-hint-x");
    if (hx) hx.addEventListener("click", dismissHint);
    map.once("click", dismissHint);
  }

  // Forecast model wiring (heatmap layer + back-test exercise controls).
  if (FC) {
    document.getElementById("lyr-forecast").addEventListener("change", e => {
      if (e.target.checked) { renderForecastHeat(); fcLayer.addTo(map); } else map.removeLayer(fcLayer);
    });
    document.querySelectorAll(".fc-tab").forEach(btn => btn.addEventListener("click", () => {
      document.querySelectorAll(".fc-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      fcExercise = btn.dataset.ex;
      applyExercise();
    }));
    const slider = document.getElementById("fc-slider");
    slider.addEventListener("input", () => {
      fcPct = parseInt(slider.value, 10);
      document.getElementById("fc-pct").textContent = fcPct + "%";
      scoreForecast();
    });
    document.getElementById("fc-showmap").addEventListener("change", e => {
      if (e.target.checked) { scoreForecast(); exLayer.addTo(map); renderForecastHeat(); fcLayer.addTo(map); document.getElementById("lyr-forecast").checked = true; }
      else { map.removeLayer(exLayer); }
    });
  }

  // ---- Click anywhere to identify the nearest earthquake -------------------
  // Robust + forgiving: searches the visible historical catalog and the live
  // feed for the closest dot to the click, so you never have to land precisely
  // on a tiny marker. Live quakes win ties.
  function quakePopupHTML(q) {
    const col = q.isLive ? "#4aa8ff" : depthColor(q.depth);
    let html = `<div class="pp-mag" style="color:${col}">M ${q.mag.toFixed(1)}${q.isLive ? " · LIVE" : ""}</div>` +
      `<b>${q.place || "Puerto Rico region"}</b><br>` +
      `${q.isLive ? ago(q.time) + " · " : ""}${fmtDate(q.time)} · depth ${q.depth != null ? q.depth + " km" : "—"}`;
    const mi = mmiInfo(q.mmi);
    if (mi) html += `<br><span class="pp-int">Shaking: ${mi.label} (${mi.roman})</span>`;
    if (q.felt) html += `<br>Felt by ${q.felt} ${q.felt === 1 ? "person" : "people"}`;
    if (q.tsunami) html += `<br>🌊 tsunami evaluation issued`;
    if (q.url) html += `<br><a href="${q.url}" target="_blank" rel="noopener">USGS details ↗</a>`;
    return html;
  }
  map.on("click", e => {
    const cp = e.containerPoint;
    let best = null, bestScore = Infinity;
    const consider = (rec, isLive) => {
      const p = map.latLngToContainerPoint([rec.lat, rec.lon]);
      const d = Math.hypot(p.x - cp.x, p.y - cp.y);
      const r = isLive ? Math.max(5, magRadius(rec.mag) + 2) : Math.max(3, magRadius(rec.mag));
      if (d > r + 8) return;                       // 8px grace radius
      const score = d - r - (isLive ? 6 : 0);      // prefer live + bigger dots
      if (score < bestScore) { bestScore = score; best = rec; }
    };
    liveData.forEach(q => consider(q, true));
    const cutoff = Date.UTC(yearMax + 1, 0, 1);
    for (const f of QUAKES) {
      const p = f.properties;
      if (p.mag == null || p.mag < magMin) continue;
      if (p.time && p.time >= cutoff) continue;
      const c = f.geometry.coordinates;
      consider({ lat: c[1], lon: c[0], mag: p.mag, place: p.place, time: p.time, depth: p.depth, isLive: false }, false);
    }
    if (best) {
      L.popup({ offset: [0, -4] }).setLatLng([best.lat, best.lon])
        .setContent(quakePopupHTML(best)).openOn(map);
    }
  });

  // Hover the recent (blue) quakes to see their magnitude without clicking.
  const hoverTip = L.tooltip({ direction: "top", offset: [0, -6], className: "mag-tip", opacity: 0.97 });
  let hoverOn = false;
  map.on("mousemove", e => {
    const cp = e.containerPoint;
    let best = null, bestD = Infinity;
    for (const q of liveData) {
      const p = map.latLngToContainerPoint([q.lat, q.lon]);
      const d = Math.hypot(p.x - cp.x, p.y - cp.y);
      const r = Math.max(5, magRadius(q.mag) + 2);
      if (d <= r + 3 && d < bestD) { bestD = d; best = q; }
    }
    if (best) {
      hoverTip.setLatLng([best.lat, best.lon]).setContent(`M ${best.mag.toFixed(1)}`);
      if (!hoverOn) { hoverTip.addTo(map); hoverOn = true; }
      map.getContainer().style.cursor = "pointer";
    } else if (hoverOn) {
      map.removeLayer(hoverTip); hoverOn = false; map.getContainer().style.cursor = "";
    }
  });

  const magEl = document.getElementById("mag-min"), yearEl = document.getElementById("year");
  magEl.addEventListener("input", () => {
    magMin = parseFloat(magEl.value);
    document.getElementById("mag-val").textContent = magMin.toFixed(1);
    renderQuakes();
  });
  yearEl.addEventListener("input", () => {
    yearMax = parseInt(yearEl.value, 10);
    document.getElementById("year-val").textContent = yearMax;
    renderQuakes();
  });
  document.getElementById("year-val").textContent = yearMax;

  // Play the 2018–2021 build-up & Guánica sequence.
  let timer = null;
  document.getElementById("play").addEventListener("click", () => {
    if (timer) { clearInterval(timer); timer = null; document.getElementById("play").textContent = "▶ Play 2018–2021"; return; }
    document.getElementById("play").textContent = "⏸ Pause";
    magMin = 2.5; magEl.value = "2.5"; document.getElementById("mag-val").textContent = "2.5";
    let y = 2018;
    yearEl.value = y; yearMax = y; document.getElementById("year-val").textContent = y; renderQuakes();
    timer = setInterval(() => {
      y++;
      if (y > 2021) { clearInterval(timer); timer = null; document.getElementById("play").textContent = "▶ Play 2018–2021"; return; }
      yearEl.value = y; yearMax = y; document.getElementById("year-val").textContent = y; renderQuakes();
    }, 1400);
  });
  document.getElementById("reset").addEventListener("click", () => {
    if (timer) { clearInterval(timer); timer = null; document.getElementById("play").textContent = "▶ Play 2018–2021"; }
    magMin = 3.5; yearMax = 2026;
    magEl.value = "3.5"; yearEl.value = 2026;
    document.getElementById("mag-val").textContent = "3.5";
    document.getElementById("year-val").textContent = 2026;
    map.setView([18.2, -66.4], 8); renderQuakes();
  });

  const ld = document.getElementById("loading");
  if (ld) ld.remove();

  // About / intro overlay — shows on first visit, reopenable via the "?" button.
  const about = document.getElementById("about");
  function showAbout() { about.classList.remove("about-hidden"); }
  function hideAbout() {
    about.classList.add("about-hidden");
    try { localStorage.setItem("pr_seen_intro", "1"); } catch (e) {}
  }
  let seen = false;
  try { seen = localStorage.getItem("pr_seen_intro") === "1"; } catch (e) {}
  if (!seen) showAbout();
  document.getElementById("help-btn").addEventListener("click", showAbout);
  document.getElementById("about-close").addEventListener("click", hideAbout);
  document.getElementById("about-start").addEventListener("click", hideAbout);
  about.addEventListener("click", e => { if (e.target === about) hideAbout(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") hideAbout(); });

  // Ensure canvas renderers pick up the final flex layout size (otherwise the
  // earthquake canvas can initialise at 0 width and draw nothing). Re-render only
  // once after layout settles — not on every resize event.
  window.MAP = map;
  let sized = false;
  function fixSize() { map.invalidateSize(true); if (!sized) { sized = true; renderQuakes(); } }
  requestAnimationFrame(fixSize);
  window.addEventListener("load", fixSize);
  if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById("map"));

  } catch (err) {
    console.error(err);
    fail("Something went wrong building the dashboard: " + ((err && err.message) || err) + ".");
  }
})();
