/* Puerto Rico Seismic Dashboard
   Reads window.SEIS (from data/data.js). Live feed from USGS over HTTPS.
   Forecasting/visualization only — NOT an earthquake prediction or alert system. */

(function () {
  "use strict";
  const S = window.SEIS || {};
  const QUAKES = (S.quakes && S.quakes.features) || [];
  const YEAR_MS = 1000 * 60 * 60 * 24 * 365.25;

  // ---- Map -----------------------------------------------------------------
  const map = L.map("map", { zoomControl: true, preferCanvas: true })
    .setView([18.2, -66.4], 8);
  L.tileLayer("https://cartodb-basemaps-{s}.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO", subdomains: "abcd", maxZoom: 19,
  }).addTo(map);
  const canvas = L.canvas({ padding: 0.5 });

  // ---- Depth color / magnitude size ---------------------------------------
  function depthColor(d) {
    if (d == null) return "#888";
    if (d < 30) return "#ff5d5d";
    if (d < 70) return "#ff9f40";
    if (d < 150) return "#ffd166";
    return "#6fe0c8";
  }
  function magRadius(m) { return Math.max(2, Math.pow(Math.max(m, 0), 1.7) * 0.7); }

  // ---- Earthquake layer ----------------------------------------------------
  const quakeLayer = L.layerGroup();
  let magMin = 3.5, yearMax = 2026;

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
      const mk = L.circleMarker([c[1], c[0]], {
        renderer: canvas, radius: magRadius(p.mag),
        color: depthColor(p.depth), weight: 0.6, fillColor: depthColor(p.depth),
        fillOpacity: 0.55, opacity: 0.9,
      });
      mk.bindPopup(
        `<div class="pp-mag" style="color:${depthColor(p.depth)}">M ${p.mag.toFixed(1)}</div>` +
        `<b>${p.place || "Puerto Rico region"}</b><br>` +
        `${fmtDate(p.time)} &nbsp;·&nbsp; depth ${p.depth != null ? p.depth + " km" : "—"}`
      );
      quakeLayer.addLayer(mk);
      n++;
    }
    document.getElementById("count").textContent =
      `${n.toLocaleString()} events shown  (M ≥ ${magMin.toFixed(1)}, through ${yearMax})`;
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
  const gpsLayer = L.layerGroup();
  function buildGPS() {
    const feats = (S.gps && S.gps.features) || [];
    const SCALE = 0.06; // degrees of arrow length per mm/yr
    feats.forEach(f => {
      const [lon, lat] = f.geometry.coordinates;
      const p = f.properties;
      const tipLon = lon + (p.ve_mm * SCALE) / Math.cos(lat * Math.PI / 180) / 10;
      const tipLat = lat + (p.vn_mm * SCALE) / 10;
      L.polyline([[lat, lon], [tipLat, tipLon]],
        { color: "#7ee787", weight: 2.5, opacity: 0.9 }).addTo(gpsLayer);
      const ang = Math.atan2(p.ve_mm, p.vn_mm) * 180 / Math.PI; // bearing for arrowhead
      L.marker([tipLat, tipLon], { icon: L.divIcon({ className: "",
        html: `<div style="color:#7ee787;transform:rotate(${ang}deg);font-size:14px;line-height:14px">▲</div>`,
        iconSize: [14, 14], iconAnchor: [7, 7] }) }).addTo(gpsLayer);
      L.circleMarker([lat, lon], { renderer: canvas, radius: 3, color: "#7ee787",
        fillColor: "#7ee787", fillOpacity: 1 })
        .bindPopup(`<b>GPS ${p.station}</b><br>Moving ${p.speed_mm.toFixed(1)} mm/yr<br>` +
          `East ${p.ve_mm.toFixed(1)} · North ${p.vn_mm.toFixed(1)} mm/yr` +
          (p.curated ? "<br><i>approx. published value</i>" : ""))
        .addTo(gpsLayer);
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
      (fc.features || []).forEach(f => {
        const c = f.geometry.coordinates, p = f.properties;
        L.circleMarker([c[1], c[0]], { renderer: canvas, radius: magRadius(p.mag || 2) + 1,
          color: "#4aa8ff", weight: 1.5, fillColor: depthColor(c[2]), fillOpacity: 0.6 })
          .bindPopup(`<div class="pp-mag" style="color:#4aa8ff">M ${(p.mag || 0).toFixed(1)} · LIVE</div>` +
            `<b>${p.place || ""}</b><br>${fmtDate(p.time)} · depth ${Math.round(c[2])} km`)
          .addTo(liveLayer);
      });
    }).catch(() => {
      liveLoaded = false;
      alert("Could not reach the USGS live feed (need internet). Historical data still works.");
    });
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

    const gr = st.gutenberg_richter || [];
    if (gr.length && window.Chart) {
      new Chart(document.getElementById("gr-chart"), {
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

  buildTectonics(); buildGPS(); buildLandmarks(); buildStats(); renderQuakes();
  quakeLayer.addTo(map); tectLayer.addTo(map); gpsLayer.addTo(map); landmarkLayer.addTo(map);

  toggle("lyr-quakes", quakeLayer);
  toggle("lyr-tect", tectLayer);
  toggle("lyr-faults", faultLayer);
  toggle("lyr-gps", gpsLayer);
  toggle("lyr-landmark", landmarkLayer);
  document.getElementById("lyr-live").addEventListener("change", e => {
    if (e.target.checked) { loadLive(); liveLayer.addTo(map); } else map.removeLayer(liveLayer);
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
  // earthquake canvas can initialise at 0 width and draw nothing).
  window.MAP = map;
  function fixSize() { map.invalidateSize(true); renderQuakes(); }
  requestAnimationFrame(fixSize);
  window.addEventListener("load", fixSize);
  if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById("map"));
})();
