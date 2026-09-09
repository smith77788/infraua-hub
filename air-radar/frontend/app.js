/* Tactical Air Radar — COP client. Реальний потік через WebSocket /ws. */
"use strict";

const TYPE_GLYPH = {
  shahed: '<path d="M12 2 3 20l9-4 9 4z"/>',
  recon: '<path d="M12 2 3 20l9-4 9 4z"/>',
  missile: '<path d="M12 2c3 3 3 8 0 20-3-12-3-17 0-20z"/><path d="M9 16l-3 5M15 16l3 5"/>',
  cruise: '<path d="M2 12h16l4-2-4-2H2zM6 12l-2 4M10 12l-2 4"/>',
  ballistic: '<path d="M12 2c3 3 3 8 0 20-3-12-3-17 0-20z"/>',
  kab: '<path d="M12 3v12M8 15h8l-4 6z"/>',
  aircraft: '<path d="M2 12l20-6-7 18-3-8z"/>',
  unknown: '<circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
};
const COMPASS = ["Пн", "ПнСх", "Сх", "ПдСх", "Пд", "ПдЗх", "Зх", "ПнЗх"];
const compass = (d) => (d == null ? "—" : COMPASS[Math.round(((d % 360) / 45)) % 8]);

function haversine(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(rad(a[0])) * Math.cos(rad(b[0]));
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ── Map ────────────────────────────────────────────────────────────────
const map = L.map("map", { zoomControl: true, attributionControl: false, preferCanvas: false }).setView([48.6, 31.2], 6);
const ESRI_DARK = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const ESRI_SAT = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
let baseLayer = L.tileLayer(ESRI_DARK, { maxZoom: 16 }).addTo(map);
const layerGroups = {
  targets: L.layerGroup().addTo(map),
  vectors: L.layerGroup().addTo(map),
  corridors: L.layerGroup().addTo(map),
  assets: L.layerGroup().addTo(map),
  zones: L.layerGroup().addTo(map),
};
const replayLayer = L.layerGroup(); // рендериться лише в режимі реплею

// ── State ──────────────────────────────────────────────────────────────
const objects = new Map(); // id -> { data, marker, vector, row }
const assetMarkers = new Map(); // name -> marker
let logCount = 0, rateWindow = [];

function assetIcon(hot) {
  return L.divIcon({ html: `<div class="a"></div>`, className: "asset-pin" + (hot ? " hot" : ""), iconSize: [10, 10], iconAnchor: [5, 5] });
}

function renderAssets(assets) {
  if (!assets || assetMarkers.size) return; // рендеримо один раз
  for (const a of assets) {
    const m = L.marker([a.lat, a.lon], { icon: assetIcon(false), interactive: true })
      .bindPopup(`<b>${a.name}</b><br><span style="opacity:.7">${a.category_label || a.category}</span>`);
    m.addTo(layerGroups.assets);
    assetMarkers.set(a.name, m);
  }
}

function applyThreatened(threatened) {
  layerGroups.corridors.clearLayers();
  // мінімальний ETA по кожному обʼєкту + перелік для HUD
  const byAsset = new Map();
  for (const tid of Object.keys(threatened || {})) {
    const track = objects.get(tid);
    const list = threatened[tid] || [];
    for (const h of list) {
      const cur = byAsset.get(h.name);
      if (!cur || h.eta_min < cur.eta_min) byAsset.set(h.name, h);
      if (track) {
        L.polyline([[track.data.lat, track.data.lon], [h.lat, h.lon]], {
          color: track.data.color, weight: 1, opacity: 0.5, dashArray: "2 5",
        }).addTo(layerGroups.corridors);
      }
    }
  }
  // підсвітка обʼєктів
  for (const [name, m] of assetMarkers) m.setIcon(assetIcon(byAsset.has(name)));
  // HUD
  const items = [...byAsset.values()].sort((a, b) => a.eta_min - b.eta_min).slice(0, 7);
  const hud = document.getElementById("risk-hud");
  const listEl = document.getElementById("risk-list");
  if (!items.length) { hud.hidden = true; listEl.innerHTML = ""; return; }
  hud.hidden = false;
  listEl.innerHTML = items.map((h) =>
    `<div class="risk-item"><span>${h.name}</span><span class="cat">${h.category_label || ""}</span><span class="eta">${Math.round(h.eta_min)}'</span></div>`
  ).join("");
}

const SEV_LABEL = { critical: "КРИТИЧНО", high: "ВИСОКА", medium: "СЕРЕДНЯ" };
function applyAlerts(alerts) {
  alerts = alerts || [];
  const hud = document.getElementById("alert-hud");
  const listEl = document.getElementById("alert-list");
  document.getElementById("m-alerts") && (document.getElementById("m-alerts").textContent = alerts.length);
  if (!alerts.length) { hud.hidden = true; listEl.innerHTML = ""; return; }
  hud.hidden = false;
  listEl.innerHTML = alerts.slice(0, 8).map((a) => {
    const eta = Math.round(a.eta_min);
    return `<div class="alert-item sev-${a.severity}" data-tid="${a.track_id}" data-lat="${a.lat}" data-lon="${a.lon}">
      <div class="alert-top"><span class="sev">${SEV_LABEL[a.severity] || a.severity}</span>
        <span class="eta">ETA ${eta}'</span></div>
      <div class="alert-asset">→ ${a.asset}</div>
      <div class="alert-meta">${a.label}${a.in_zone ? " · ◎ офіц. зона" : ""} · ${(a.confidence * 100) | 0}%</div>
    </div>`;
  }).join("");
  listEl.querySelectorAll(".alert-item").forEach((el) => {
    el.onclick = () => {
      const lat = parseFloat(el.dataset.lat), lon = parseFloat(el.dataset.lon);
      map.flyTo([lat, lon], Math.max(map.getZoom(), 9), { duration: 0.6 });
      const e = objects.get(el.dataset.tid);
      if (e) e.marker.openPopup();
    };
  });
}

function targetIcon(o) {
  const glyph = TYPE_GLYPH[o.type] || TYPE_GLYPH.unknown;
  const html = `<div class="core" style="color:${o.color};background:${o.color}22;box-shadow:0 0 10px ${o.color}88,0 0 0 1.5px ${o.color}">
    <svg viewBox="0 0 24 24" fill="none" stroke="${o.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg></div>`;
  return L.divIcon({ html, className: "tgt", iconSize: [14, 14], iconAnchor: [7, 7], popupAnchor: [0, -8] });
}

function etaMin(o) {
  if (!o.vector) return null;
  const km = haversine([o.lat, o.lon], o.vector[1]);
  if (km < 1) return 0;
  return Math.round((km / (o.speed_kmh || 200)) * 60);
}

function popupHtml(o) {
  const eta = etaMin(o);
  return `<div style="font-family:var(--sans);font-size:12px">
    <div style="font-weight:700;color:${o.color}">${o.label}${o.count > 1 ? " ×" + o.count : ""}</div>
    <div style="opacity:.8">${o.destination ? "Курс: " + o.destination : o.raw || ""}</div>
    <div style="font-family:var(--mono);font-size:10px;opacity:.7;margin-top:3px">
      ${o.heading != null ? "Азимут " + Math.round(o.heading) + "° (" + compass(o.heading) + ") · " : ""}${o.speed_kmh} км/год${eta != null ? " · ETA ~" + eta + " хв" : ""}
    </div>
    <div style="font-family:var(--mono);font-size:9px;opacity:.6;margin-top:3px">Джерело: ${o.channel || o.source}${o.source_count > 1 ? " · підтверджено " + o.source_count + " каналами" : ""}${o.in_zone ? " · офіц. тривога: " + (o.zone_region || "так") : ""} · впевненість ${(o.confidence * 100) | 0}%</div>
  </div>`;
}

function rowHtml(o) {
  const glyph = TYPE_GLYPH[o.type] || TYPE_GLYPH.unknown;
  const eta = etaMin(o);
  return `<div class="glyph" style="background:${o.color}22;box-shadow:0 0 0 1px ${o.color}66">
      <svg viewBox="0 0 24 24" fill="none" stroke="${o.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg>
    </div>
    <div class="main">
      <div class="name">${o.label}${o.count > 1 ? " ×" + o.count : ""}${o.destination ? " → " + o.destination : ""}</div>
      <div class="sub">${o.channel || o.source} · ${compass(o.heading)}${o.heading != null ? " " + Math.round(o.heading) + "°" : ""}${o.source_count > 1 ? ` · ✔${o.source_count} джерел` : ""}${o.in_zone ? " · ◎ офіц. зона" : ""}</div>
      <div class="conf-bar"><i style="width:${(o.confidence * 100) | 0}%;background:${o.color}"></i></div>
    </div>
    <div class="metrics"><span class="spd">${o.speed_kmh}</span> км/год${eta != null ? "<br>ETA " + eta + "'" : ""}</div>`;
}

function upsertObject(o) {
  let entry = objects.get(o.id);
  const icon = targetIcon(o);
  if (!entry) {
    const marker = L.marker([o.lat, o.lon], { icon }).bindPopup(popupHtml(o));
    marker.addTo(layerGroups.targets);
    const row = document.createElement("div");
    row.className = "trow";
    row.onclick = () => { map.flyTo([o.lat, o.lon], Math.max(map.getZoom(), 9), { duration: 0.6 }); marker.openPopup(); };
    document.getElementById("threat-matrix").prepend(row);
    entry = { data: o, marker, vector: null, row };
    objects.set(o.id, entry);
  } else {
    entry.marker.setLatLng([o.lat, o.lon]).setIcon(icon).setPopupContent(popupHtml(o));
    entry.data = o;
  }
  entry.row.innerHTML = rowHtml(o);
  entry.row.onclick = () => { map.flyTo([o.lat, o.lon], Math.max(map.getZoom(), 9), { duration: 0.6 }); entry.marker.openPopup(); };

  // Вектор курсу
  if (entry.vector) { layerGroups.vectors.removeLayer(entry.vector); entry.vector = null; }
  if (o.vector) {
    entry.vector = L.polyline(o.vector, { color: o.color, weight: 1.4, opacity: 0.7, dashArray: "4 4" }).addTo(layerGroups.vectors);
  }
  refreshMetrics();
}

function removeObject(id) {
  const e = objects.get(id);
  if (!e) return;
  layerGroups.targets.removeLayer(e.marker);
  if (e.vector) layerGroups.vectors.removeLayer(e.vector);
  e.row.remove();
  objects.delete(id);
  refreshMetrics();
}

let zoneLayers = [];
function setZones(zones) {
  zoneLayers.forEach((l) => layerGroups.zones.removeLayer(l));
  zoneLayers = [];
  for (const z of zones) {
    for (const ring of z.polygons) {
      const p = L.polygon(ring, { color: "#ff4d4d", weight: 1, fillColor: "#ff4d4d", fillOpacity: 0.08 })
        .bindPopup(`<b style="color:#ff4d4d">Тривога</b><br>${z.region}`);
      p.addTo(layerGroups.zones);
      zoneLayers.push(p);
    }
  }
  document.getElementById("m-zones").textContent = zones.length;
}

function addLog(l) {
  const row = document.createElement("div");
  row.className = "logrow";
  const t = new Date((l.ts || Date.now() / 1000) * 1000).toLocaleTimeString("uk-UA");
  const toks = (l.tokens || []).map((x) => `<span class="tok">${x}</span>`).join("");
  row.innerHTML = `<div class="meta"><span class="ch">@${l.channel || "osint"}</span><span>${t}</span><span class="cf">${((l.confidence || 0) * 100) | 0}%</span></div>
    <div class="text">${(l.text || "").replace(/</g, "&lt;")}</div>${toks ? `<div class="tokens">${toks}</div>` : ""}`;
  const stream = document.getElementById("log-stream");
  stream.prepend(row);
  while (stream.children.length > 120) stream.lastChild.remove();
  logCount++;
  document.getElementById("log-count").textContent = logCount;
  rateWindow.push(Date.now());
}

function refreshMetrics() {
  const n = objects.size;
  document.getElementById("hud-count").textContent = n;
  document.getElementById("m-targets").textContent = n;
  document.getElementById("tm-count").textContent = n;
}

setInterval(() => {
  const cutoff = Date.now() - 60000;
  rateWindow = rateWindow.filter((t) => t > cutoff);
  document.getElementById("m-rate").textContent = rateWindow.length;
}, 3000);

// ── Filters ────────────────────────────────────────────────────────────
document.getElementById("filters").addEventListener("click", (e) => {
  const btn = e.target.closest(".fbtn");
  if (!btn) return;
  btn.classList.toggle("on");
  const on = btn.classList.contains("on");
  const layer = btn.dataset.layer;
  if (layer === "sat") {
    map.removeLayer(baseLayer);
    baseLayer = L.tileLayer(on ? ESRI_SAT : ESRI_DARK, { maxZoom: on ? 18 : 16 }).addTo(map);
    baseLayer.bringToBack();
  } else if (layerGroups[layer]) {
    if (on) map.addLayer(layerGroups[layer]);
    else map.removeLayer(layerGroups[layer]);
  }
});

// ── Часова шкала розслідування (LIVE / REPLAY) ───────────────────────────
const replay = {
  mode: "live", paths: null, t0: 0, t1: 0, t: 0, playing: false, timer: null, markers: new Map(),
};
const LIVE_LAYERS = ["targets", "vectors", "corridors"];

function setLiveLayersVisible(v) {
  for (const k of LIVE_LAYERS) {
    if (v) { if (!map.hasLayer(layerGroups[k])) map.addLayer(layerGroups[k]); }
    else map.removeLayer(layerGroups[k]);
  }
}

async function enterReplay() {
  const minutes = +document.getElementById("tl-window").value;
  const clock = document.getElementById("tl-clock");
  clock.textContent = "завантаження історії…";
  let data;
  try {
    data = await fetch(`/api/history?minutes=${minutes}`).then((r) => r.json());
  } catch { clock.textContent = "історія недоступна"; return false; }
  const paths = data.paths || {};
  let t0 = Infinity, t1 = -Infinity;
  for (const oid of Object.keys(paths)) {
    for (const p of paths[oid]) { if (p.ts < t0) t0 = p.ts; if (p.ts > t1) t1 = p.ts; }
  }
  if (!isFinite(t0) || t1 <= t0) { clock.textContent = "немає даних за період"; return false; }
  replay.mode = "replay"; replay.paths = paths; replay.t0 = t0; replay.t1 = t1; replay.t = t0;
  setLiveLayersVisible(false);
  replayLayer.addTo(map);
  document.getElementById("tl-range").disabled = false;
  document.getElementById("tl-play").disabled = false;
  document.getElementById("timeline").classList.add("replaying");
  renderReplayAt(t0);
  return true;
}

function exitReplay() {
  replay.mode = "live"; replay.playing = false;
  if (replay.timer) { clearInterval(replay.timer); replay.timer = null; }
  replayLayer.clearLayers(); map.removeLayer(replayLayer); replay.markers.clear();
  setLiveLayersVisible(true);
  const rng = document.getElementById("tl-range");
  rng.disabled = true; rng.value = 1000;
  document.getElementById("tl-play").disabled = true;
  document.getElementById("tl-play").textContent = "⏵";
  document.getElementById("tl-clock").textContent = "реальний час";
  document.getElementById("timeline").classList.remove("replaying");
}

function renderReplayAt(t) {
  replay.t = t;
  replayLayer.clearLayers();
  replay.markers.clear();
  const seen = new Set();
  for (const oid of Object.keys(replay.paths)) {
    const pts = replay.paths[oid].filter((p) => p.ts <= t);
    if (!pts.length) continue;
    seen.add(oid);
    const latlngs = pts.map((p) => [p.lat, p.lon]);
    const color = "#22d3ee";
    L.polyline(latlngs, { color, weight: 1.2, opacity: 0.5, dashArray: "3 4" }).addTo(replayLayer);
    const last = pts[pts.length - 1];
    const fresh = t - last.ts < 90; // «активний» слід у момент t
    L.circleMarker([last.lat, last.lon], {
      radius: fresh ? 5 : 3, color, weight: 1.5,
      fillColor: color, fillOpacity: fresh ? 0.85 : 0.3,
    }).addTo(replayLayer);
  }
  const d = new Date(t * 1000);
  document.getElementById("tl-clock").textContent =
    `${d.toLocaleTimeString("uk-UA")} · ${seen.size} треків`;
  const rng = document.getElementById("tl-range");
  rng.value = Math.round(((t - replay.t0) / (replay.t1 - replay.t0)) * 1000);
}

function playReplay() {
  if (replay.playing) { pauseReplay(); return; }
  if (replay.t >= replay.t1) replay.t = replay.t0;
  replay.playing = true;
  document.getElementById("tl-play").textContent = "⏸";
  const span = replay.t1 - replay.t0;
  const stepSec = Math.max(span / 120, 5); // ~120 кадрів на весь період
  replay.timer = setInterval(() => {
    replay.t += stepSec;
    if (replay.t >= replay.t1) { replay.t = replay.t1; renderReplayAt(replay.t); pauseReplay(); return; }
    renderReplayAt(replay.t);
  }, 120);
}
function pauseReplay() {
  replay.playing = false;
  if (replay.timer) { clearInterval(replay.timer); replay.timer = null; }
  document.getElementById("tl-play").textContent = "⏵";
}

document.getElementById("tl-mode").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (replay.mode === "live") {
    const ok = await enterReplay();
    if (ok) { btn.textContent = "⏱ РЕПЛЕЙ"; btn.dataset.mode = "replay"; }
  } else {
    exitReplay(); btn.textContent = "● LIVE"; btn.dataset.mode = "live";
  }
});
document.getElementById("tl-play").addEventListener("click", playReplay);
document.getElementById("tl-range").addEventListener("input", (e) => {
  if (replay.mode !== "replay") return;
  pauseReplay();
  const frac = +e.target.value / 1000;
  renderReplayAt(replay.t0 + frac * (replay.t1 - replay.t0));
});
document.getElementById("tl-window").addEventListener("change", () => {
  if (replay.mode === "replay") enterReplay();
});

// ── WebSocket ──────────────────────────────────────────────────────────
function setWs(on) {
  document.getElementById("ws-led").className = "led " + (on ? "on" : "off");
  document.getElementById("ws-text").textContent = on ? "потік активний" : "перепідключення…";
}

fetch("/api/health").then((r) => r.json()).then((h) => {
  document.getElementById("m-geo").textContent = (h.geo_names || 0).toLocaleString("uk-UA");
}).catch(() => {});

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { setWs(true); setInterval(() => ws.readyState === 1 && ws.send("ping"), 20000); };
  ws.onclose = () => { setWs(false); setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "snapshot") {
      renderAssets(msg.assets);
      msg.objects.forEach(upsertObject);
      setZones(msg.zones || []);
      applyThreatened(msg.threatened || {});
      applyAlerts(msg.alerts || []);
      (msg.logs || []).slice().forEach(addLog);
    } else if (msg.type === "upsert") upsertObject(msg.object);
    else if (msg.type === "remove") removeObject(msg.id);
    else if (msg.type === "zones") setZones(msg.zones);
    else if (msg.type === "threatened") applyThreatened(msg.threatened);
    else if (msg.type === "alert_feed") applyAlerts(msg.alerts);
    else if (msg.type === "log") addLog(msg.log);
  };
}
connect();
