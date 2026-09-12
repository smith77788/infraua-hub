/* Tactical Air Radar — COP client. Реальний потік через WebSocket /ws.

   Принцип показу: спостережене і виведене НЕ виглядають однаково. Реальний
   фікс — суцільний, екстраполяція — пунктир; вік даних видно завжди. Радар,
   який малює двогодинної давнини позицію так само, як щойно отриману,
   показує не обстановку, а свою впевненість у собі.
*/
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
const esc = (x) => String(x == null ? "" : x).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

function haversine(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(rad(a[0])) * Math.cos(rad(b[0]));
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const rad = (x) => (x * Math.PI) / 180, deg = (x) => (x * 180) / Math.PI;
  const dLon = rad(b[1] - a[1]);
  const y = Math.sin(dLon) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
/* Поперечне відхилення точки від курсу цілі — та сама геометрія, що й у
   backend/correlation.py, але для однієї точки: «чи йде це на мене». */
function crossTrackKm(pos, heading, target) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const d13 = haversine(pos, target);
  if (d13 === 0) return { cross: 0, along: 0 };
  const t13 = rad(bearing(pos, target)), brg = rad(heading);
  const dxt = Math.asin(Math.max(-1, Math.min(1, Math.sin(d13 / R) * Math.sin(t13 - brg)))) * R;
  const dat = Math.acos(Math.max(-1, Math.min(1, Math.cos(d13 / R) / Math.max(1e-9, Math.cos(dxt / R))))) * R;
  return { cross: Math.abs(dxt), along: dat };
}
/* Українська множина: 1 ціль, 2 цілі, 5 цілей. Без цього в досьє стояло
   «ще 1 ціл.» — скорочення, яким маскують невідмінене число. */
function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return `${n} ${one}`;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}
const targets = (n) => plural(n, "ціль", "цілі", "цілей");
const points = (n) => plural(n, "точка", "точки", "точок");
const fmtAge = (s) => (s == null ? "—" : s < 60 ? `${s | 0} с` : s < 3600 ? `${(s / 60) | 0} хв` : `${(s / 3600).toFixed(1)} год`);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватний режим */ } },
};

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
  me: L.layerGroup().addTo(map),
};
const replayLayer = L.layerGroup(); // рендериться лише в режимі реплею

// ── State ──────────────────────────────────────────────────────────────
const objects = new Map(); // id -> { data, marker, vector, drift, row }
const assetMarkers = new Map(); // name -> marker
let logCount = 0, rateWindow = [];
let lastThreatened = {}; // track_id -> [hits] (для графа звʼязків)
let lastRegions = [];
let lastAlerts = [];
let oblastFilter = null; // фільтр матриці загроз за областю

// ── Свіжість: спостережене проти виведеного ────────────────────────────
const FRESH_LABEL = { fresh: "щойно", aging: "згасає", stale: "застаріле" };

function targetIcon(o) {
  const glyph = TYPE_GLYPH[o.type] || TYPE_GLYPH.unknown;
  const fresh = o.freshness || "fresh";
  // Прозорість несе вік: чим давніше спостереження, тим блідіша позначка.
  const dim = fresh === "fresh" ? 1 : fresh === "aging" ? 0.66 : 0.38;
  const html = `<div class="core f-${fresh}${o.extrapolated ? " extrap" : ""}" style="opacity:${dim};color:${o.color};background:${o.color}22;box-shadow:0 0 10px ${o.color}88,0 0 0 1.5px ${o.color}">
    <svg viewBox="0 0 24 24" fill="none" stroke="${o.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg></div>`;
  return L.divIcon({ html, className: "tgt", iconSize: [14, 14], iconAnchor: [7, 7], popupAnchor: [0, -8] });
}

/* ETA має означати «за скільки воно буде ТАМ», а не «за скільки долетить до
   власної поточної позиції». Раніше рахувалося до кінця вектора курсу, а кінець
   вектора — це і є поточна точка, тому в матриці стояло «ETA 0'» на кожному
   рядку. Тепер ETA беремо з кореляції: найближчий обʼєкт у коридорі загрози. */
function etaTo(o) {
  const hits = lastThreatened[o.id];
  if (!hits || !hits.length) return null;
  const best = hits.reduce((a, b) => (a.eta_min <= b.eta_min ? a : b));
  return { min: Math.round(best.eta_min), name: best.name };
}

function popupHtml(o) {
  const eta = etaTo(o);
  const src = (o.provenance || []).map((p) => `${esc(p.channel)} (${p.reliability})`).join(", ") || esc(o.channel || o.source);
  return `<div style="font-family:var(--sans);font-size:12px;min-width:190px">
    <div style="font-weight:700;color:${o.color}">${esc(o.label)}${o.count > 1 ? " ×" + o.count : ""}</div>
    <div style="opacity:.8">${o.route ? esc(o.route) : o.destination ? "Курс: " + esc(o.destination) : esc(o.raw || "")}</div>
    <div style="font-family:var(--mono);font-size:10px;opacity:.7;margin-top:3px">
      ${o.heading != null ? "Азимут " + Math.round(o.heading) + "° (" + compass(o.heading) + ") · " : ""}${o.speed_kmh} км/год${eta ? " · до «" + esc(eta.name) + "» ~" + eta.min + " хв" : ""}
    </div>
    <div style="font-family:var(--mono);font-size:9px;opacity:.75;margin-top:4px">
      ${o.extrapolated ? "◌ позиція вирахувана" : "● позиція спостережена"} · ${FRESH_LABEL[o.freshness] || ""} ${fmtAge(o.age_sec)} тому
    </div>
    <div style="font-family:var(--mono);font-size:9px;opacity:.6;margin-top:2px">${src}${o.operator_count > 1 ? " · " + o.operator_count + " незалежні" : ""}${o.agreement_label ? " · " + esc(o.agreement_label) : ""}</div>
    <button class="popup-dsr" data-tid="${esc(o.id)}">Досьє цілі →</button>
  </div>`;
}

function rowHtml(o) {
  const glyph = TYPE_GLYPH[o.type] || TYPE_GLYPH.unknown;
  const eta = etaTo(o);
  const conf = (o.confidence * 100) | 0;
  return `<div class="glyph" style="background:${o.color}22;box-shadow:0 0 0 1px ${o.color}66">
      <svg viewBox="0 0 24 24" fill="none" stroke="${o.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg>
    </div>
    <div class="main">
      <div class="name">${esc(o.label)}${o.count > 1 ? " ×" + o.count : ""}${o.route ? " · " + esc(o.route) : o.destination ? " → " + esc(o.destination) : ""}</div>
      <div class="sub">${esc(o.oblast || o.channel || o.source)} · ${compass(o.heading)}${o.heading != null ? " " + Math.round(o.heading) + "°" : ""}${o.operator_count > 1 ? ` · ✔${o.operator_count} незалежних` : ""}${o.agreement === "both" ? " · ◎◎" : o.in_zone ? " · ◎" : ""}</div>
      <div class="conf-bar"><i style="width:${conf}%;background:${o.color}"></i></div>
    </div>
    <div class="metrics">
      <span class="spd">${o.speed_kmh}</span> км/год${eta ? "<br>ETA " + eta.min + "'" : ""}
      <br><span class="fresh f-${o.freshness}">${o.extrapolated ? "◌" : "●"} ${fmtAge(o.age_sec)}</span>
    </div>`;
}

function rowVisible(o) {
  return !oblastFilter || o.oblast === oblastFilter;
}

function upsertObject(o) {
  let entry = objects.get(o.id);
  const icon = targetIcon(o);
  const focus = () => { map.flyTo([o.lat, o.lon], Math.max(map.getZoom(), 9), { duration: 0.6 }); openDossier(o.id); };
  if (!entry) {
    const marker = L.marker([o.lat, o.lon], { icon }).bindPopup(popupHtml(o));
    marker.addTo(layerGroups.targets);
    const row = document.createElement("div");
    row.className = "trow";
    document.getElementById("threat-matrix").prepend(row);
    entry = { data: o, marker, vector: null, drift: null, row };
    objects.set(o.id, entry);
  } else {
    entry.marker.setLatLng([o.lat, o.lon]).setIcon(icon).setPopupContent(popupHtml(o));
    entry.data = o;
  }
  entry.row.innerHTML = rowHtml(o);
  entry.row.hidden = !rowVisible(o);
  entry.row.onclick = focus;
  entry.marker.off("click").on("click", () => entry.marker.openPopup());

  // Вектор курсу
  if (entry.vector) { layerGroups.vectors.removeLayer(entry.vector); entry.vector = null; }
  if (o.vector) {
    entry.vector = L.polyline(o.vector, { color: o.color, weight: 1.4, opacity: 0.7, dashArray: "4 4" }).addTo(layerGroups.vectors);
  }
  // Знос: від останнього РЕАЛЬНОГО фіксу до вирахуваної позиції.
  if (entry.drift) { layerGroups.targets.removeLayer(entry.drift); entry.drift = null; }
  if (o.extrapolated && o.fix_lat != null) {
    entry.drift = L.layerGroup([
      L.polyline([[o.fix_lat, o.fix_lon], [o.lat, o.lon]], { color: o.color, weight: 1, opacity: 0.45, dashArray: "1 4" }),
      L.circleMarker([o.fix_lat, o.fix_lon], { radius: 3, color: o.color, weight: 1, opacity: 0.6, fillOpacity: 0 }),
    ]).addTo(layerGroups.targets);
  }
  if (dossier.id === o.id) renderDossier(dossier.data ? { ...dossier.data, ...o } : o);
  refreshMetrics();
}

function removeObject(id) {
  const e = objects.get(id);
  if (!e) return;
  layerGroups.targets.removeLayer(e.marker);
  if (e.vector) layerGroups.vectors.removeLayer(e.vector);
  if (e.drift) layerGroups.targets.removeLayer(e.drift);
  e.row.remove();
  objects.delete(id);
  if (dossier.id === id) closeDossier();
  refreshMetrics();
}

function assetIcon(hot) {
  return L.divIcon({ html: `<div class="a"></div>`, className: "asset-pin" + (hot ? " hot" : ""), iconSize: [10, 10], iconAnchor: [5, 5] });
}

function renderAssets(assets) {
  if (!assets || assetMarkers.size) return; // рендеримо один раз
  for (const a of assets) {
    const m = L.marker([a.lat, a.lon], { icon: assetIcon(false), interactive: true })
      .bindPopup(`<b>${esc(a.name)}</b><br><span style="opacity:.7">${esc(a.category_label || a.category)}</span>`);
    m.addTo(layerGroups.assets);
    assetMarkers.set(a.name, m);
  }
}

function applyThreatened(threatened) {
  lastThreatened = threatened || {};
  scheduleGraph();
  layerGroups.corridors.clearLayers();
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
  for (const [name, m] of assetMarkers) m.setIcon(assetIcon(byAsset.has(name)));
  // ETA рядків залежить від щойно оновленої кореляції — перемальовуємо.
  for (const [, e] of objects) e.row.innerHTML = rowHtml(e.data);
  const items = [...byAsset.values()].sort((a, b) => a.eta_min - b.eta_min).slice(0, 7);
  const hud = document.getElementById("risk-hud");
  const listEl = document.getElementById("risk-list");
  if (!items.length) { hud.hidden = true; listEl.innerHTML = ""; return; }
  hud.hidden = false;
  listEl.innerHTML = items.map((h) =>
    `<div class="risk-item"><span>${esc(h.name)}</span><span class="cat">${esc(h.category_label || "")}</span><span class="eta">${Math.round(h.eta_min)}'</span></div>`
  ).join("");
}

const SEV_LABEL = { critical: "КРИТИЧНО", high: "ВИСОКА", medium: "СЕРЕДНЯ" };
function applyAlerts(alerts) {
  alerts = alerts || [];
  const prevCritical = new Set(lastAlerts.filter((a) => a.severity === "critical").map((a) => a.id));
  lastAlerts = alerts;
  const hud = document.getElementById("alert-hud");
  const listEl = document.getElementById("alert-list");
  const mEl = document.getElementById("m-alerts");
  if (mEl) mEl.textContent = alerts.length;
  for (const a of alerts) {
    if (a.severity === "critical" && !prevCritical.has(a.id)) notifyCritical(a);
  }
  if (!alerts.length) { hud.hidden = true; listEl.innerHTML = ""; return; }
  hud.hidden = false;
  listEl.innerHTML = alerts.slice(0, 8).map((a) => {
    const eta = Math.round(a.eta_min);
    return `<div class="alert-item sev-${a.severity}" data-tid="${esc(a.track_id)}" data-lat="${a.lat}" data-lon="${a.lon}">
      <div class="alert-top"><span class="sev">${SEV_LABEL[a.severity] || esc(a.severity)}</span>
        <span class="eta">ETA ${eta}'</span></div>
      <div class="alert-asset">→ ${esc(a.asset)}</div>
      <div class="alert-meta">${esc(a.label)}${a.agreement_label ? " · " + esc(a.agreement_label) : ""} · ${(a.confidence * 100) | 0}%</div>
    </div>`;
  }).join("");
  listEl.querySelectorAll(".alert-item").forEach((el) => {
    el.onclick = () => {
      map.flyTo([parseFloat(el.dataset.lat), parseFloat(el.dataset.lon)], Math.max(map.getZoom(), 9), { duration: 0.6 });
      openDossier(el.dataset.tid);
    };
  });
}

// ── Обласний зріз: де саме зараз важко ─────────────────────────────────
const AGREE_CLASS = { both: "ag-both", zone_only: "ag-one", oblast_only: "ag-one", neither: "ag-none", unknown: "ag-unknown" };

function renderRegions(regions) {
  lastRegions = regions || [];
  const board = document.getElementById("region-board");
  document.getElementById("rg-count").textContent = lastRegions.length;
  const alerted = lastRegions.filter((r) => r.oblast_alert).length;
  const mo = document.getElementById("m-oblasts");
  if (mo) mo.textContent = alerted || "0";
  if (!lastRegions.length) {
    board.innerHTML = `<div class="empty">Цілей і тривог за областями немає</div>`;
    return;
  }
  const max = Math.max(...lastRegions.map((r) => r.pressure), 1);
  board.innerHTML = lastRegions.map((r) => {
    const w = Math.round((r.pressure / max) * 100);
    const sel = oblastFilter === r.oblast ? " selected" : "";
    return `<div class="rrow${sel}" data-oblast="${esc(r.oblast)}">
      <div class="rtop">
        <span class="rname">${esc(r.oblast)}</span>
        <span class="rbadge ${AGREE_CLASS[r.agreement] || "ag-unknown"}" title="${esc(r.agreement_label)}">${r.agreement === "both" ? "◎◎" : r.agreement === "neither" ? "—" : r.agreement === "unknown" ? "?" : "◎"}</span>
      </div>
      <div class="rbar"><i style="width:${w}%"></i></div>
      <div class="rsub">
        <span>${targets(r.tracks)}${r.fresh ? ` · ${r.fresh} свіж.` : ""}${r.moving ? ` · ${r.moving} у русі` : ""}</span>
        ${r.min_eta_min != null ? `<span class="reta">ETA ${Math.round(r.min_eta_min)}'</span>` : ""}
      </div>
      ${r.threatened_assets.length ? `<div class="rassets">⚠ ${r.threatened_assets.slice(0, 3).map(esc).join(", ")}</div>` : ""}
      ${r.observed_share != null && r.observed_share < 1 ? `<div class="rbasis">привʼязка спостережена на ${(r.observed_share * 100) | 0}%</div>` : ""}
    </div>`;
  }).join("");
  board.querySelectorAll(".rrow").forEach((el) => {
    el.onclick = () => selectOblast(el.dataset.oblast);
  });
}

function selectOblast(name) {
  oblastFilter = oblastFilter === name ? null : name;
  for (const [, e] of objects) e.row.hidden = !rowVisible(e.data);
  renderRegions(lastRegions);
  if (oblastFilter) {
    const pts = [...objects.values()].filter((e) => e.data.oblast === oblastFilter).map((e) => [e.data.lat, e.data.lon]);
    if (pts.length) map.flyToBounds(L.latLngBounds(pts).pad(0.4), { duration: 0.7, maxZoom: 9 });
    showPane("targets");
  }
  refreshMetrics();
}

// ── Досьє цілі: усе, що система знає, і на чому це тримається ──────────
const dossier = { id: null, data: null };

async function openDossier(id) {
  if (!id) return;
  dossier.id = id;
  const entry = objects.get(id);
  if (entry) renderDossier(entry.data);
  document.getElementById("dossier").hidden = false;
  document.body.classList.add("has-dossier");
  try {
    const full = await fetch(`/api/dossier/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null));
    if (full && dossier.id === id) { dossier.data = full; renderDossier(full); }
  } catch { /* без деталей — показуємо те, що є в потоці */ }
}

function closeDossier() {
  dossier.id = null; dossier.data = null;
  document.getElementById("dossier").hidden = true;
  document.body.classList.remove("has-dossier");
}

function confidenceStory(o) {
  /* Чому саме така впевненість — переліком внесків, а не одним числом. */
  const bits = [];
  const prov = o.provenance || [];
  if (prov.length) {
    const best = prov.reduce((a, b) => (a.base_confidence >= b.base_confidence ? a : b));
    bits.push(`базова ${Math.round(best.base_confidence * 100)}% — надійність джерела «${best.channel}» (${best.reliability}, ${best.tier_label})`);
  }
  if (o.operator_count > 1) bits.push(`+ підтвердження ${o.operator_count} незалежними операторами`);
  else if ((o.provenance || []).length > 1) bits.push("канали різні, але оператор один — це не є незалежним підтвердженням");
  if (o.agreement === "both") bits.push("+ тривога підтверджена двома незалежними джерелами");
  else if (o.agreement === "zone_only") bits.push("+ зона тривоги в монітора (обласне джерело не підтверджує)");
  else if (o.agreement === "oblast_only") bits.push("+ обласна тривога (монітор цю точку зоною не накриває)");
  else if (o.agreement === "neither") bits.push("тривоги немає в жодного джерела");
  if (o.obs_count > 1) bits.push(`${o.obs_count} спостережень у треку`);
  if (o.age_sec > 900) bits.push(`− впевненість затухає: останній фікс ${fmtAge(o.age_sec)} тому`);
  return bits;
}

function renderDossier(o) {
  const body = document.getElementById("dsr-body");
  document.getElementById("dsr-title").innerHTML =
    `<span style="color:${o.color}">${esc(o.label)}</span>${o.count > 1 ? " ×" + o.count : ""}`;
  const hist = o.history || [];
  const hits = o.threatened || lastThreatened[o.id] || [];
  body.innerHTML = `
    <div class="dsr-sec">
      <div class="dsr-h">Стан</div>
      <dl class="kv">
        <dt>Позиція</dt><dd>${o.lat.toFixed(3)}, ${o.lon.toFixed(3)} ${o.extrapolated ? '<span class="warn">◌ вирахувана</span>' : '<span class="ok">● спостережена</span>'}</dd>
        <dt>Останній фікс</dt><dd>${fmtAge(o.age_sec)} тому · <span class="f-${o.freshness}">${FRESH_LABEL[o.freshness] || ""}</span></dd>
        <dt>Курс</dt><dd>${o.heading != null ? Math.round(o.heading) + "° (" + compass(o.heading) + ")" : "невідомий"}</dd>
        <dt>Швидкість</dt><dd>${o.speed_kmh} км/год <span class="muted">${o.speed_basis === "measured" ? "(заміряна за зміщенням між фіксами)" : "(типова для цього типу — власного заміру немає)"}</span></dd>
        ${o.route ? `<dt>Маршрут</dt><dd>${esc(o.route)}</dd>` : ""}
        ${o.oblast ? `<dt>Область</dt><dd>${esc(o.oblast)} <span class="muted">(${o.oblast_basis === "observed" ? "з даних джерела" : "виведено за координатою"})</span></dd>` : ""}
      </dl>
    </div>
    <div class="dsr-sec">
      <div class="dsr-h">Чому впевненість ${(o.confidence * 100) | 0}%</div>
      <ul class="story">${confidenceStory(o).map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
    </div>
    <div class="dsr-sec">
      <div class="dsr-h">Походження</div>
      ${(o.provenance || []).map((p) => `<div class="prov">
        <span class="pch">@${esc(p.channel)}</span>
        <span class="prel rel-${p.reliability}">${p.reliability}</span>
        <span class="ptier">${esc(p.tier_label)}</span>
        <div class="pnote">${esc(p.note)}</div>
      </div>`).join("") || '<div class="muted">джерело не вказане</div>'}
      ${o.report_siblings ? `<div class="muted" style="margin-top:6px">У тій самій доповіді ще ${targets(o.report_siblings)} — це одна хвиля</div>` : ""}
    </div>
    ${hits.length ? `<div class="dsr-sec">
      <div class="dsr-h">У коридорі попереду</div>
      ${hits.slice(0, 6).map((h) => `<div class="risk-item"><span>${esc(h.name)}</span><span class="cat">${esc(h.category_label || "")}</span><span class="eta">${Math.round(h.eta_min)}'</span></div>`).join("")}
    </div>` : ""}
    <div class="dsr-sec">
      <div class="dsr-h">Історія позицій <span class="muted">${points(hist.length || (o.waypoints || []).length)}</span></div>
      ${hist.length
        ? `<div class="hist">${hist.slice(-8).reverse().map((p) => `<div class="hrow"><span>${new Date(p.ts * 1000).toLocaleTimeString("uk-UA")}</span><span>${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}</span></div>`).join("")}</div>`
        : '<div class="muted">лише поточний фікс</div>'}
    </div>`;
}

document.getElementById("dsr-close").onclick = closeDossier;
document.addEventListener("click", (e) => {
  const b = e.target.closest(".popup-dsr");
  if (b) openDossier(b.dataset.tid);
});

// ── «Я тут»: що з цього стосується особисто мене ───────────────────────
const me = { point: store.get("radar.me", null), pickMode: false, rings: null };

function meLayerRender() {
  layerGroups.me.clearLayers();
  if (!me.point) return;
  const [lat, lon] = me.point;
  L.circleMarker([lat, lon], { radius: 6, color: "#22d3ee", weight: 2, fillColor: "#22d3ee", fillOpacity: 0.6 })
    .bindPopup("Моя точка").addTo(layerGroups.me);
  for (const km of [10, 25, 50]) {
    L.circle([lat, lon], { radius: km * 1000, color: "#22d3ee", weight: 1, opacity: 0.28, fill: false, dashArray: "3 6" })
      .addTo(layerGroups.me);
  }
}

function meAssess() {
  const hud = document.getElementById("me-hud");
  const body = document.getElementById("me-body");
  if (!me.point) { hud.hidden = true; return; }
  hud.hidden = false;
  const near = [];
  for (const [, e] of objects) {
    const o = e.data;
    const d = haversine(me.point, [o.lat, o.lon]);
    let inbound = null;
    if (o.heading != null) {
      const { cross, along } = crossTrackKm([o.lat, o.lon], o.heading, me.point);
      const ang = Math.abs((((bearing([o.lat, o.lon], me.point) - o.heading + 180) % 360) + 360) % 360 - 180);
      if (ang <= 90 && cross <= 30) inbound = { cross, eta: (along / (o.speed_kmh || 200)) * 60 };
    }
    near.push({ o, d, brg: bearing(me.point, [o.lat, o.lon]), inbound });
  }
  near.sort((a, b) => (a.inbound && !b.inbound ? -1 : !a.inbound && b.inbound ? 1 : a.d - b.d));
  const top = near.slice(0, 5);
  const inboundCount = near.filter((n) => n.inbound).length;
  const closest = near.length ? near.reduce((a, b) => (a.d <= b.d ? a : b)) : null;
  body.innerHTML = `
    <div class="me-verdict ${inboundCount ? "danger" : closest && closest.d < 50 ? "warn" : "calm"}">
      ${inboundCount
        ? `${targets(inboundCount)} у напрямку моєї точки`
        : closest
          ? `Найближча ціль — ${Math.round(closest.d)} км`
          : "Активних цілей у видачі немає"}
    </div>
    ${top.map((n) => `<div class="me-row" data-tid="${esc(n.o.id)}">
      <span class="mecol" style="color:${n.o.color}">${n.inbound ? "➤" : "•"}</span>
      <span class="melbl">${esc(n.o.label)}</span>
      <span class="medir">${compass(n.brg)} ${Math.round(n.d)} км</span>
      ${n.inbound ? `<span class="meeta">${Math.round(n.inbound.eta)}'</span>` : ""}
    </div>`).join("") || '<div class="muted">—</div>'}
    <div class="me-note">Відстань і напрямок рахуються від вашої точки до поточної позиції цілі. «➤» — ціль іде в межах 30 км від вас.</div>`;
  body.querySelectorAll(".me-row").forEach((el) => {
    el.onclick = () => openDossier(el.dataset.tid);
  });
}

function setMePoint(lat, lon) {
  me.point = [lat, lon];
  store.set("radar.me", me.point);
  meLayerRender();
  meAssess();
  const btn = document.querySelector('.fbtn[data-layer="me"]');
  if (btn) btn.classList.add("on");
}

function enableMe() {
  if (me.point) { meLayerRender(); meAssess(); map.flyTo(me.point, Math.max(map.getZoom(), 8), { duration: 0.6 }); return; }
  if (navigator.geolocation) {
    document.getElementById("me-hud").hidden = false;
    document.getElementById("me-body").innerHTML = '<div class="muted">визначення розташування… або клацніть по карті</div>';
    me.pickMode = true;
    navigator.geolocation.getCurrentPosition(
      (p) => { me.pickMode = false; setMePoint(p.coords.latitude, p.coords.longitude); map.flyTo(me.point, 9, { duration: 0.8 }); },
      () => { document.getElementById("me-body").innerHTML = '<div class="muted">доступ до геолокації закрито — клацніть по карті, щоб поставити точку</div>'; },
      { timeout: 8000, maximumAge: 60000 }
    );
  } else {
    me.pickMode = true;
    document.getElementById("me-hud").hidden = false;
    document.getElementById("me-body").innerHTML = '<div class="muted">клацніть по карті, щоб поставити точку</div>';
  }
}

map.on("click", (e) => {
  if (!me.pickMode) return;
  me.pickMode = false;
  setMePoint(e.latlng.lat, e.latlng.lng);
});
document.getElementById("me-close").onclick = () => {
  me.point = null; me.pickMode = false;
  store.set("radar.me", null);
  layerGroups.me.clearLayers();
  document.getElementById("me-hud").hidden = true;
  const btn = document.querySelector('.fbtn[data-layer="me"]');
  if (btn) btn.classList.remove("on");
};

// ── Звук і сповіщення: критичне не має губитися у вкладці ──────────────
const sound = { on: store.get("radar.sound", false), ctx: null };

function updateSoundBtn() {
  const b = document.getElementById("btn-sound");
  b.textContent = sound.on ? "🔔 Звук" : "🔕 Звук";
  b.classList.toggle("on", sound.on);
}

function beep() {
  if (!sound.on) return;
  try {
    sound.ctx = sound.ctx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = sound.ctx;
    if (ctx.state === "suspended") ctx.resume();
    // Двотональний сигнал: коротка пара, щоб не плутати з системними звуками.
    [0, 0.26].forEach((offset, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = i === 0 ? 880 : 660;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.24);
    });
  } catch { /* браузер без WebAudio */ }
}

function notifyCritical(a) {
  beep();
  if (!sound.on) return;
  try {
    if (window.Notification && Notification.permission === "granted") {
      new Notification("⚠ Критична загроза", {
        body: `${a.label} → ${a.asset}, ETA ${Math.round(a.eta_min)} хв`,
        tag: a.id,
      });
    }
  } catch { /* сповіщення недоступні */ }
}

document.getElementById("btn-sound").onclick = () => {
  sound.on = !sound.on;
  store.set("radar.sound", sound.on);
  updateSoundBtn();
  if (sound.on) {
    beep();
    if (window.Notification && Notification.permission === "default") Notification.requestPermission();
  }
};
updateSoundBtn();

// ── SITREP: зведення, яке можна передати далі ──────────────────────────
function sitrepText(d) {
  const t = new Date(d.generated_at * 1000);
  const L = [];
  L.push(`ЗВЕДЕННЯ ПОВІТРЯНОЇ ОБСТАНОВКИ`);
  L.push(`Час: ${t.toLocaleString("uk-UA")}`);
  L.push(`Активних треків: ${d.summary.tracks} · зон тривог: ${d.summary.zones} · областей у тривозі: ${d.summary.oblasts_with_alert} · сповіщень: ${d.summary.alerts}`);
  L.push("");
  L.push("ЗА ОБЛАСТЯМИ (за тиском):");
  for (const r of d.regions.slice(0, 12)) {
    L.push(`  ${r.oblast}: тиск ${r.pressure}, цілей ${r.tracks} (свіжих ${r.fresh}), ${r.agreement_label}${r.min_eta_min != null ? `, найближчий ETA ${Math.round(r.min_eta_min)} хв` : ""}`);
    if (r.threatened_assets.length) L.push(`      під загрозою: ${r.threatened_assets.join(", ")}`);
  }
  if (d.alerts.length) {
    L.push("");
    L.push("СПОВІЩЕННЯ:");
    for (const a of d.alerts.slice(0, 15)) {
      L.push(`  [${(SEV_LABEL[a.severity] || a.severity)}] ${a.label} → ${a.asset} (${a.asset_category}), ETA ${Math.round(a.eta_min)} хв, впевненість ${(a.confidence * 100) | 0}%`);
    }
  }
  L.push("");
  L.push("ЦІЛІ:");
  for (const o of d.tracks.slice(0, 60)) {
    L.push(`  ${o.label}${o.count > 1 ? " ×" + o.count : ""} @ ${o.lat.toFixed(2)},${o.lon.toFixed(2)} ${o.oblast || ""} · курс ${o.heading != null ? Math.round(o.heading) + "°" : "—"} · ${o.speed_kmh} км/год · фікс ${fmtAge(o.age_sec)} тому${o.extrapolated ? " (позиція вирахувана)" : ""} · ${(o.confidence * 100) | 0}% · джерела: ${(o.operators || []).join(", ") || o.channel}`);
  }
  L.push("");
  L.push(`Походження: дані OSINT-агрегатора та незалежного джерела обласних тривог. Позначка «вирахувана» означає екстраполяцію за курсом, а не спостереження.`);
  return L.join("\n");
}

document.getElementById("btn-sitrep").onclick = async () => {
  const btn = document.getElementById("btn-sitrep");
  const old = btn.textContent;
  btn.textContent = "…";
  try {
    const d = await fetch("/api/sitrep").then((r) => r.json());
    const text = sitrepText(d);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sitrep-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    btn.textContent = "✓ SITREP";
  } catch {
    btn.textContent = "✕ помилка";
  }
  setTimeout(() => { btn.textContent = old; }, 2200);
};

// ── Зони, логи, метрики ────────────────────────────────────────────────
let zoneLayers = [];
function setZones(zones) {
  zoneLayers.forEach((l) => layerGroups.zones.removeLayer(l));
  zoneLayers = [];
  for (const z of zones) {
    for (const ring of z.polygons) {
      const p = L.polygon(ring, { color: "#ff4d4d", weight: 1, fillColor: "#ff4d4d", fillOpacity: 0.08 })
        .bindPopup(`<b style="color:#ff4d4d">Тривога</b><br>${esc(z.region)}`);
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
  const toks = (l.tokens || []).map((x) => `<span class="tok">${esc(x)}</span>`).join("");
  row.innerHTML = `<div class="meta"><span class="ch">@${esc(l.channel || "osint")}</span>${l.reliability ? `<span class="rel rel-${l.reliability}">${l.reliability}</span>` : ""}<span>${t}</span><span class="cf">${((l.confidence || 0) * 100) | 0}%</span></div>
    <div class="text">${esc(l.text || "")}</div>${toks ? `<div class="tokens">${toks}</div>` : ""}`;
  const stream = document.getElementById("log-stream");
  stream.prepend(row);
  while (stream.children.length > 120) stream.lastChild.remove();
  logCount++;
  document.getElementById("log-count").textContent = logCount;
  rateWindow.push(Date.now());
}

function refreshMetrics() {
  const all = [...objects.values()].map((e) => e.data);
  const shown = all.filter(rowVisible);
  const fresh = shown.filter((o) => o.freshness === "fresh").length;
  document.getElementById("hud-count").textContent = shown.length;
  document.getElementById("hud-fresh").textContent =
    `${fresh} свіжих · ${shown.length - fresh} згасають${oblastFilter ? " · " + oblastFilter : ""}`;
  document.getElementById("hud-count").title = `${targets(shown.length)} у видачі`;
  document.getElementById("m-targets").textContent = all.length;
  document.getElementById("tm-count").textContent = shown.length;
  meAssess();
}

setInterval(() => {
  const cutoff = Date.now() - 60000;
  rateWindow = rateWindow.filter((t) => t > cutoff);
  document.getElementById("m-rate").textContent = rateWindow.length;
}, 3000);
// Вік даних тече й без нових повідомлень — картка не має «завмирати» свіжою.
setInterval(() => {
  const now = Date.now() / 1000;
  for (const [, e] of objects) {
    const o = e.data;
    o.age_sec = Math.max(0, Math.round(now - o.ts));
    o.freshness = o.age_sec < 300 ? "fresh" : o.age_sec < 900 ? "aging" : "stale";
    e.marker.setIcon(targetIcon(o));
    e.row.innerHTML = rowHtml(o);
  }
  refreshMetrics();
}, 15000);

// ── Панелі, вкладки, мобільний режим ───────────────────────────────────
function showPane(name) {
  document.querySelectorAll(".ptab").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll("#panel-left .panel-body").forEach((p) => { p.hidden = p.dataset.pane !== name; });
}
document.querySelector(".panel-tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".ptab");
  if (b) showPane(b.dataset.tab);
});

document.getElementById("mobile-nav").addEventListener("click", (e) => {
  const b = e.target.closest(".mnav");
  if (!b) return;
  document.querySelectorAll(".mnav").forEach((x) => x.classList.toggle("on", x === b));
  const v = b.dataset.view;
  document.body.classList.remove("m-left", "m-right", "m-map");
  if (v === "left" || v === "regions") {
    document.body.classList.add("m-left");
    showPane(v === "regions" ? "regions" : "targets");
  } else if (v === "right") document.body.classList.add("m-right");
  else document.body.classList.add("m-map");
  setTimeout(() => map.invalidateSize(), 220);
});
document.body.classList.add("m-map");

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
  } else if (layer === "graph") {
    toggleGraph(on);
  } else if (layer === "me") {
    if (on) enableMe();
    else {
      layerGroups.me.clearLayers();
      document.getElementById("me-hud").hidden = true;
      me.pickMode = false;
    }
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
    `${d.toLocaleTimeString("uk-UA")} · ${plural(seen.size, "трек", "треки", "треків")}`;
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

// ── Граф звʼязків (link analysis) ────────────────────────────────────────
const graph = { visible: false, raf: 0, nodes: [], edges: [], W: 800, H: 600 };

function toggleGraph(on) {
  graph.visible = on;
  document.getElementById("graph-overlay").hidden = !on;
  if (on) buildGraph(); else cancelAnimationFrame(graph.raf);
}

function scheduleGraph() { if (graph.visible) buildGraph(); }

function buildGraph() {
  const svg = document.getElementById("graph-svg");
  const rect = svg.getBoundingClientRect();
  graph.W = rect.width || 800; graph.H = rect.height || 600;
  const nodes = new Map(); // key -> node
  const edges = [];
  const node = (key, label, kind, weight) => {
    let n = nodes.get(key);
    if (!n) {
      n = { key, label, kind, deg: 0,
        x: graph.W / 2 + (Math.random() - 0.5) * 200,
        y: graph.H / 2 + (Math.random() - 0.5) * 200, vx: 0, vy: 0,
        r: kind === "asset" ? 9 : kind === "zone" ? 8 : kind === "chan" ? 6 : 7 };
      nodes.set(key, n);
    }
    if (weight) n.deg += weight;
    return n;
  };
  for (const [id, e] of objects) {
    const o = e.data;
    const tn = node("t:" + id, o.label + (o.count > 1 ? " ×" + o.count : ""), "track", 1);
    // Вузол каналу — за ОПЕРАТОРОМ: два канали одного власника не мають
    // виглядати у графі як два незалежні джерела.
    for (const op of (o.operators && o.operators.length ? o.operators : [o.channel || o.source])) {
      if (!op) continue;
      node("c:" + op, op, "chan", 1);
      edges.push({ a: "t:" + id, b: "c:" + op, kind: "src" });
    }
    if (o.in_zone && o.zone_region) {
      node("z:" + o.zone_region, o.zone_region, "zone", 1);
      edges.push({ a: "t:" + id, b: "z:" + o.zone_region, kind: "zone" });
    }
    const hits = lastThreatened[id] || [];
    for (const h of hits.slice(0, 3)) {
      node("a:" + h.name, h.name, "asset", 1);
      edges.push({ a: "t:" + id, b: "a:" + h.name, kind: "threat", eta: h.eta_min });
    }
    tn.deg += hits.length;
  }
  graph.nodes = [...nodes.values()];
  graph.edges = edges.filter((e) => nodes.has(e.a) && nodes.has(e.b));
  if (!graph.nodes.length) {
    svg.innerHTML = `<text x="50%" y="50%" fill="#6b7a8d" font-size="12" text-anchor="middle" font-family="var(--mono)">немає активних звʼязків</text>`;
    return;
  }
  runForce(60);
  drawGraph();
}

function runForce(iters) {
  const { nodes, edges, W, H } = graph;
  const idx = new Map(nodes.map((n, i) => [n.key, i]));
  const K = Math.sqrt((W * H) / nodes.length) * 0.7;
  for (let it = 0; it < iters; it++) {
    for (const n of nodes) { n.fx = 0; n.fy = 0; }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy || 0.01;
        const rep = (K * K) / d2;
        const d = Math.sqrt(d2);
        a.fx += (dx / d) * rep; a.fy += (dy / d) * rep;
        b.fx -= (dx / d) * rep; b.fy -= (dy / d) * rep;
      }
    }
    for (const e of edges) {
      const a = nodes[idx.get(e.a)], b = nodes[idx.get(e.b)];
      let dx = a.x - b.x, dy = a.y - b.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const att = (d * d) / K;
      a.fx -= (dx / d) * att; a.fy -= (dy / d) * att;
      b.fx += (dx / d) * att; b.fy += (dy / d) * att;
    }
    const damp = 0.85, cx = W / 2, cy = H / 2;
    for (const n of nodes) {
      n.fx += (cx - n.x) * 0.01; n.fy += (cy - n.y) * 0.01; // легке тяжіння до центру
      n.x += Math.max(-16, Math.min(16, n.fx * 0.02)) * damp;
      n.y += Math.max(-16, Math.min(16, n.fy * 0.02)) * damp;
      n.x = Math.max(n.r + 6, Math.min(W - n.r - 6, n.x));
      n.y = Math.max(n.r + 20, Math.min(H - n.r - 6, n.y));
    }
  }
}

const NODE_COLOR = { track: "#ff9900", asset: "#ff4d4d", zone: "#22d3ee", chan: "#6b7a8d" };
const EDGE_COLOR = { threat: "#ff4d4d", zone: "#22d3ee", src: "#3a4658" };
function drawGraph() {
  const svg = document.getElementById("graph-svg");
  const { nodes, edges, W, H } = graph;
  const idx = new Map(nodes.map((n) => [n.key, n]));
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  let s = "";
  for (const e of edges) {
    const a = idx.get(e.a), b = idx.get(e.b);
    const w = e.kind === "threat" ? 1.8 : 1;
    const dash = e.kind === "src" ? ' stroke-dasharray="2 4"' : "";
    s += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${EDGE_COLOR[e.kind]}" stroke-width="${w}" opacity="0.55"${dash}/>`;
  }
  for (const n of nodes) {
    const c = NODE_COLOR[n.kind];
    const rr = n.r + Math.min(4, n.deg);
    s += `<g class="gnode"><circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${rr.toFixed(1)}" fill="${c}22" stroke="${c}" stroke-width="1.5"/>`;
    s += `<text x="${n.x.toFixed(1)}" y="${(n.y - rr - 3).toFixed(1)}" fill="#d7e0ea" font-size="9" text-anchor="middle" font-family="var(--mono)">${esc(n.label).slice(0, 22)}</text></g>`;
  }
  svg.innerHTML = s;
}

// ── WebSocket ──────────────────────────────────────────────────────────
function setWs(on) {
  document.getElementById("ws-led").className = "led " + (on ? "on" : "off");
  document.getElementById("ws-text").textContent = on ? "потік активний" : "перепідключення…";
}

fetch("/api/health").then((r) => r.json()).then((h) => {
  document.getElementById("m-geo").textContent = (h.geo_names || 0).toLocaleString("uk-UA");
  if (h.oblasts_with_alert != null) document.getElementById("m-oblasts").textContent = h.oblasts_with_alert;
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
      renderRegions(msg.regions || []);
      (msg.logs || []).slice().forEach(addLog);
    } else if (msg.type === "upsert") upsertObject(msg.object);
    else if (msg.type === "remove") removeObject(msg.id);
    else if (msg.type === "zones") setZones(msg.zones);
    else if (msg.type === "threatened") { applyThreatened(msg.threatened); if (msg.regions) renderRegions(msg.regions); }
    else if (msg.type === "oblast_alerts") renderRegions(msg.regions || lastRegions);
    else if (msg.type === "alert_feed") applyAlerts(msg.alerts);
    else if (msg.type === "log") addLog(msg.log);
  };
}
connect();

// Точка користувача переживає перезавантаження — її не треба ставити щоразу.
if (me.point) {
  const btn = document.querySelector('.fbtn[data-layer="me"]');
  if (btn) btn.classList.add("on");
  meLayerRender();
  meAssess();
}
