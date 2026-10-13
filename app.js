/* SkovPlan Felt – enkel feltapp (PWA).
 *
 * Læser skovens GeoPackage direkte på telefonen (sql.js), viser litraerne på et
 * kort med GPS-position og gemmer prøveflader, fotos og noter i telefonens
 * IndexedDB.  «Eksportér» laver en zip med:
 *   - taksationsark_felt_<dato>.csv  – samme kolonner som SkovPlans taksationsark,
 *     så filen kan indlæses med «Importér bevoksningsliste fra Excel/CSV…»
 *   - registreringer.geojson         – alle registreringer som punkter (WGS84)
 *   - fotos/                          – billederne
 */
"use strict";

const LAYERS = {
  skovafdelinger: { required: true },
  ejendomsgraense: { style: { color: "#b3261e", weight: 2.5, fill: false, dashArray: "6 4" } },
  adgangsveje: { style: { color: "#7a5230", weight: 3 } },
  kortlinjer: { style: { color: "#555", weight: 1.5, dashArray: "3 3" } },
  indgange: { style: { color: "#7a5230", radius: 5 } },
};
const STAND_FIELDS = ["compartment_id", "navn", "afdeling", "afdeling_nr", "litra", "træart", "etableringsaar",
  "alder", "middelhoejde_m", "middeldiameter_cm", "stamtal_ha", "grundflade_m2_ha", "vedmasse_m3_ha",
  "areal_ha", "bemærkning", "taksationsaar", "dataaar"];
const RADII = [5.64, 7.98, 10, 12.62, 15];
const YEAR = new Date().getFullYear();

/* ------------------------------------------------------------------ helpers */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = v => { if (v === null || v === undefined || v === "") return null; const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) ? n : null; };
const fmt = (v, d = 1) => v === null || v === undefined || !Number.isFinite(Number(v)) ? "–" : Number(v).toLocaleString("da-DK", { minimumFractionDigits: d, maximumFractionDigits: d });
const csvNum = (v, d) => v === null || v === undefined || !Number.isFinite(v) ? "" : (d === 0 ? String(Math.round(v)) : v.toFixed(d).replace(".", ","));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => new Date().toISOString().slice(0, 10);
function toast(msg, ms = 2600) { const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add("hidden"), ms); }
const standKey = p => `${p.afdeling_nr ?? ""}|${String(p.litra ?? "").trim().toLowerCase()}`;
const standLabel = p => p.afdeling || `${p.afdeling_nr ?? ""}${p.litra ?? ""}` || p.navn || "?";

/* ------------------------------------------------------------------ IndexedDB */
const db = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const r = indexedDB.open("skovplan-felt", 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("kv"); r.result.createObjectStore("regs", { keyPath: "id" }); };
      r.onsuccess = () => res(this._db = r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async tx(store, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode); const s = t.objectStore(store); let out;
      Promise.resolve(fn(s)).then(v => { out = v; });
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error);
    });
  },
  req: r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }),
  get(store, key) { return this.tx(store, "readonly", s => this.req(s.get(key))); },
  put(store, val, key) { return this.tx(store, "readwrite", s => { key === undefined ? s.put(val) : s.put(val, key); }); },
  del(store, key) { return this.tx(store, "readwrite", s => { s.delete(key); }); },
  all(store) { return this.tx(store, "readonly", s => this.req(s.getAll())); },
};

/* ------------------------------------------------------------------ UTM 32N (ETRS89) -> WGS84 */
function utmToLatLon(E, N, zone = 32) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2), x = E - 500000, y = N;
  const M = y / k0, mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1);
  const N1 = a / Math.sqrt(1 - e2 * s * s), T1 = t * t, C1 = ep2 * c * c, R1 = a * (1 - e2) / (1 - e2 * s * s) ** 1.5, D = x / (N1 * k0);
  const lat = p1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / c;
  return [lon * 180 / Math.PI + (zone * 6 - 183), lat * 180 / Math.PI];
}

/* ------------------------------------------------------------------ GeoPackage geometry (GP header + WKB) */
function gpkgToGeoJSON(blob, transform) {
  if (!blob || blob.length < 8 || blob[0] !== 0x47 || blob[1] !== 0x50) return null;
  const flags = blob[3], envLen = [0, 32, 48, 48, 64][(flags >> 1) & 7] || 0;
  if (flags & 0x10) return null; // tom geometri
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let o = 8 + envLen;
  function geom() {
    const le = dv.getUint8(o) === 1; o += 1;
    let type = dv.getUint32(o, le); o += 4;
    let dims = 2;
    if (type & 0x80000000) dims++; if (type & 0x40000000) dims++; type &= 0x0fffffff; // EWKB
    if (type > 1000) { const k = Math.floor(type / 1000); dims = k === 3 ? 4 : 3; type %= 1000; } // ISO Z/M
    const pt = () => { const X = dv.getFloat64(o, le), Y = dv.getFloat64(o + 8, le); o += 8 * dims; return transform(X, Y); };
    const line = () => { const n = dv.getUint32(o, le); o += 4; const r = []; for (let i = 0; i < n; i++) r.push(pt()); return r; };
    const poly = () => { const n = dv.getUint32(o, le); o += 4; const r = []; for (let i = 0; i < n; i++) r.push(line()); return r; };
    const multi = () => { const n = dv.getUint32(o, le); o += 4; const r = []; for (let i = 0; i < n; i++) r.push(geom().coordinates); return r; };
    switch (type) {
      case 1: return { type: "Point", coordinates: pt() };
      case 2: return { type: "LineString", coordinates: line() };
      case 3: return { type: "Polygon", coordinates: poly() };
      case 4: return { type: "MultiPoint", coordinates: multi() };
      case 5: return { type: "MultiLineString", coordinates: multi() };
      case 6: return { type: "MultiPolygon", coordinates: multi() };
      default: throw new Error("Ukendt geometritype " + type);
    }
  }
  return geom();
}

let SQL = null;
async function readGpkg(file) {
  SQL = SQL || await initSqlJs({ locateFile: f => "lib/" + f });
  const data = new Uint8Array(await file.arrayBuffer());
  const g = new SQL.Database(data);
  try {
    const contents = {};
    const r = g.exec("SELECT table_name, srs_id FROM gpkg_contents WHERE data_type='features'");
    (r[0]?.values || []).forEach(([t, srs]) => contents[t] = srs);
    if (!("skovafdelinger" in contents)) throw new Error("Filen har ikke laget «skovafdelinger». Er det SkovPlans GeoPackage?");
    const out = {};
    for (const name of Object.keys(LAYERS)) {
      if (!(name in contents)) continue;
      const srs = contents[name];
      const transform = srs === 25832 ? (x, y) => utmToLatLon(x, y, 32).map(v => +v.toFixed(7))
        : srs === 25833 ? (x, y) => utmToLatLon(x, y, 33).map(v => +v.toFixed(7))
        : srs === 4326 ? (x, y) => [x, y] : null;
      if (!transform) { console.warn("Springer over", name, "srs", srs); continue; }
      const cols = g.exec(`PRAGMA table_info("${name}")`)[0].values.map(v => v[1]);
      const geomCol = (g.exec(`SELECT column_name FROM gpkg_geometry_columns WHERE table_name='${name}'`)[0]?.values[0][0]) || "geom";
      const keep = name === "skovafdelinger" ? STAND_FIELDS.filter(c => cols.includes(c)) : cols.filter(c => ["navn", "type", "vejtype", "linjetype"].includes(c));
      const sel = [`"${geomCol}"`, ...keep.map(c => `"${c}"`)].join(",");
      const res = g.exec(`SELECT ${sel} FROM "${name}"`)[0];
      const feats = [];
      for (const row of res?.values || []) {
        const geometry = gpkgToGeoJSON(row[0], transform);
        if (!geometry) continue;
        const props = {}; keep.forEach((c, i) => props[c] = row[i + 1]);
        feats.push({ type: "Feature", geometry, properties: props });
      }
      out[name] = { type: "FeatureCollection", features: feats };
    }
    let propName = "";
    try { propName = g.exec("SELECT navn FROM ejendomsgraense WHERE navn IS NOT NULL LIMIT 1")[0]?.values[0][0] || ""; } catch (e) { /* intet */ }
    return { layers: out, name: propName || file.name.replace(/\.gpkg$/i, ""), file: file.name, loaded: new Date().toISOString() };
  } finally { g.close(); }
}

/* ------------------------------------------------------------------ prøveflade-beregning */
function plotStats(p) {
  const area = Math.PI * p.radius ** 2, ef = 10000 / area;
  let n = 0, sg = 0, sd2 = 0, sd3 = 0, sgh = 0, sgH = 0;
  for (const t of p.trees) {
    const d = num(t.d); if (!d) continue;
    const g = Math.PI / 4 * (d / 100) ** 2; n++; sg += g; sd2 += d * d; sd3 += d ** 3;
    const h = num(t.h); if (h) { sgh += g * h; sgH += g; }
  }
  return {
    ef, n, N: n * ef, G: sg * ef, Dg: sd2 ? sd3 / sd2 : null,
    Hg: num(p.hg) ?? (sgH ? sgh / sgH : null), heights: p.trees.filter(t => num(t.h)).length,
    _sd2: sd2 * ef, _sd3: sd3 * ef, _sgh: sgh * ef, _sgH: sgH * ef,
  };
}
function standSummary(regs) {
  const plots = regs.filter(r => r.type === "proeveflade");
  const tax = regs.filter(r => r.type === "taksation").sort((a, b) => a.created.localeCompare(b.created)).pop();
  const out = { plots: plots.length };
  if (plots.length) {
    const st = plots.map(p => plotStats(p.data));
    const mean = k => st.reduce((s, x) => s + x[k], 0) / st.length;
    const sum = k => st.reduce((s, x) => s + x[k], 0);
    out.N = mean("N"); out.G = mean("G");
    out.Dg = sum("_sd2") ? sum("_sd3") / sum("_sd2") : null;
    const manual = plots.map(p => num(p.data.hg)).filter(v => v !== null);
    out.Hg = sum("_sgH") ? sum("_sgh") / sum("_sgH") : manual.length ? manual.reduce((a, b) => a + b, 0) / manual.length : null;
    const bks = plots.map(p => num(p.data.bk)).filter(v => v !== null);
    if (bks.length) out.Bk = bks.reduce((a, b) => a + b, 0) / bks.length;
  }
  if (tax) {
    const d = tax.data;
    for (const [k, f] of [["Hg", "hg"], ["Dg", "dg"], ["N", "n"], ["G", "g"], ["V", "v"], ["Bk", "bk"]]) if (num(d[f]) !== null) out[k] = num(d[f]);
    if (d.art) out.art = d.art;
  }
  return out;
}

/* ------------------------------------------------------------------ state + kort */
const state = { data: null, regs: [], selected: null, me: null, standLayer: null, overlays: [], basemap: 0 };
const map = L.map("map", { zoomControl: false, attributionControl: true }).setView([56.0, 9.5], 7);
L.control.zoom({ position: "bottomright" }).addTo(map);
const BASEMAPS = [
  { name: "OpenStreetMap", layer: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, maxNativeZoom: 19, attribution: "© OpenStreetMap" }) },
  { name: "Ingen baggrund", layer: null },
];
function setBasemap(i) {
  BASEMAPS.forEach(b => b.layer && map.removeLayer(b.layer));
  state.basemap = i; const b = BASEMAPS[i]; if (b.layer) b.layer.addTo(map).bringToBack();
  try { localStorage.setItem("basemap", i); } catch (e) { /* ok */ }
}
setBasemap(+(safeLS("basemap") || 0) % BASEMAPS.length);
function safeLS(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

const SPECIES_COLORS = [
  [/rødgran|omorika|sitka|ædelgran|nobilis|grandis|douglas|tsuga|nåle|gran/i, "#3d7a46"],
  [/fyr|contorta/i, "#6f8f3a"], [/lærk/i, "#9bbf4d"],
  [/bøg/i, "#d9a441"], [/eg$|^eg|eg\b/i, "#b9772c"], [/løv|ask|ahorn|birk|el$|elm|lind|poppel/i, "#e3c25b"],
  [/sø|å$|vand/i, "#6aa9d8"], [/eng|mose|hede|succession|udyrket/i, "#c8d6a0"],
];
const colorFor = art => (SPECIES_COLORS.find(([re]) => re.test(art || "")) || [null, "#b8b8b8"])[1];

function drawData() {
  state.overlays.forEach(l => map.removeLayer(l)); state.overlays = [];
  if (!state.data) return;
  const L_ = state.data.layers;
  for (const name of ["kortlinjer", "adgangsveje", "ejendomsgraense", "indgange"]) {
    if (!L_[name]) continue; const st = LAYERS[name].style;
    const lyr = L.geoJSON(L_[name], { style: () => st, pointToLayer: (f, ll) => L.circleMarker(ll, st), interactive: false }).addTo(map);
    state.overlays.push(lyr);
  }
  const counts = countByStand();
  state.standLayer = L.geoJSON(L_.skovafdelinger, {
    style: f => standStyle(f, counts),
    onEachFeature: (f, lyr) => {
      lyr.on("click", () => selectStand(f));
      lyr.bindTooltip(esc(standLabel(f.properties)) + (counts[standKey(f.properties)] ? " ●" : ""),
        { permanent: true, direction: "center", className: "litra-label" });
    },
  }).addTo(map);
  state.overlays.push(state.standLayer);
  updateLabels();
  $("#where").textContent = state.data.name || "";
}
function standStyle(f, counts) {
  const sel = state.selected && standKey(state.selected.properties) === standKey(f.properties);
  const has = counts[standKey(f.properties)];
  return { color: sel ? "#0b57d0" : has ? "#7a1fa2" : "#24402a", weight: sel ? 4 : has ? 2.5 : 1,
    fillColor: colorFor(f.properties["træart"]), fillOpacity: state.basemap === 1 ? 0.65 : 0.35 };
}
function restyle() { if (!state.standLayer) return; const c = countByStand(); state.standLayer.eachLayer(l => l.setStyle(standStyle(l.feature, c))); }
function updateLabels() {
  if (!state.standLayer) return; const show = map.getZoom() >= 14;
  state.standLayer.eachLayer(l => { const t = l.getTooltip(); if (t) show ? l.openTooltip() : l.closeTooltip(); });
}
map.on("zoomend", updateLabels);
function countByStand() { const c = {}; state.regs.forEach(r => { if (r.stand) c[r.stand.key] = (c[r.stand.key] || 0) + 1; }); return c; }

/* ------------------------------------------------------------------ GPS */
let meMarker = null, meCircle = null, follow = false;
function startGps() {
  if (!("geolocation" in navigator)) return;
  navigator.geolocation.watchPosition(pos => {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    state.me = { lat, lon, accuracy, t: pos.timestamp };
    if (!meMarker) {
      meMarker = L.marker([lat, lon], { icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18] }), interactive: false }).addTo(map);
      meCircle = L.circle([lat, lon], { radius: accuracy, color: "#1a73e8", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    } else { meMarker.setLatLng([lat, lon]); meCircle.setLatLng([lat, lon]).setRadius(accuracy); }
    if (follow) map.setView([lat, lon], Math.max(map.getZoom(), 16));
    const st = standAt(lon, lat);
    $("#where").textContent = (st ? `Du står i ${standLabel(st.properties)} · ` : "") + `±${Math.round(accuracy)} m`;
  }, err => toast("GPS er ikke tilgængelig" + (err.message ? ": " + err.message : "")), { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function standAt(lon, lat) {
  if (!state.data) return null;
  for (const f of state.data.layers.skovafdelinger.features) {
    const g = f.geometry, polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const p of polys) if (inRing(lon, lat, p[0]) && !p.slice(1).some(h => inRing(lon, lat, h))) return f;
  }
  return null;
}
$("#btnLocate").onclick = () => {
  if (state.me) { follow = true; map.setView([state.me.lat, state.me.lon], Math.max(map.getZoom(), 16)); const st = standAt(state.me.lon, state.me.lat); if (st) selectStand(st); }
  else toast("Venter på GPS …");
};
map.on("dragstart", () => { follow = false; });

/* ------------------------------------------------------------------ bundark (UI) */
const sheet = $("#sheet");
function openSheet(html, full = false) { sheet.innerHTML = '<div class="grab"></div>' + html; sheet.classList.remove("hidden"); sheet.classList.toggle("full", full); sheet.scrollTop = 0; }
function closeSheet() { sheet.classList.add("hidden"); state.selected = null; restyle(); }
sheet.addEventListener("click", e => { if (e.target.closest(".close")) closeSheet(); });

function standInfo(p) { return { key: standKey(p), label: standLabel(p), afd: p.afdeling_nr, litra: p.litra, compartment_id: p.compartment_id, art: p["træart"], areal: p.areal_ha }; }
function standArea(key) {
  return state.data.layers.skovafdelinger.features.filter(f => standKey(f.properties) === key)
    .reduce((s, f) => s + (num(f.properties.areal_ha) || 0), 0);
}

function selectStand(f) {
  state.selected = f; restyle();
  const p = f.properties, key = standKey(p), regs = state.regs.filter(r => r.stand?.key === key);
  const s = standSummary(regs);
  const fact = (v, lbl, d = 1) => `<div><b>${v === null || v === undefined || v === "" ? "–" : typeof v === "number" ? fmt(v, d) : esc(v)}</b><span>${lbl}</span></div>`;
  openSheet(`
    <div class="head"><h3>${esc(standLabel(p))} · ${esc(p["træart"] || "")}</h3><button class="close">Luk</button></div>
    <div class="facts">
      ${fact(standArea(key), "areal ha", 2)}${fact(p.alder ?? (p.etableringsaar ? YEAR - p.etableringsaar : null), "alder", 0)}${fact(p.etableringsaar ? String(p.etableringsaar) : null, "anlagt")}
      ${fact(num(p.middelhoejde_m), "Hg m")}${fact(num(p.middeldiameter_cm), "Dg cm")}${fact(num(p.stamtal_ha), "stk/ha", 0)}
      ${fact(num(p.grundflade_m2_ha), "G m²/ha")}${fact(num(p.vedmasse_m3_ha), "m³/ha", 0)}${fact(p.taksationsaar || p.dataaar ? String(p.taksationsaar || p.dataaar) : null, "data fra")}
    </div>
    ${p["bemærkning"] ? `<p class="muted">${esc(p["bemærkning"])}</p>` : ""}
    <div class="actions">
      <button class="primary" data-act="newPlot">+ Prøveflade</button>
      <button data-act="photo">📷 Foto</button>
      <button data-act="note">✎ Note</button>
    </div>
    <button class="big" data-act="taksation">Taksér litraet direkte (Hg, Dg, stamtal …)</button>
    ${regs.length ? `<div class="result"><b>Feltdata ${YEAR}:</b> ${s.plots} prøveflade${s.plots === 1 ? "" : "r"} ·
      Hg ${fmt(s.Hg)} m · Dg ${fmt(s.Dg)} cm · ${fmt(s.N, 0)} stk/ha · G ${fmt(s.G)} m²/ha${s.Bk !== undefined ? ` · Bk ${fmt(s.Bk, 0)} %` : ""}</div>` : ""}
    <ul class="list">${regs.map(regItem).join("")}</ul>`);
  hydrateThumbs();
}

function regItem(r) {
  const when = new Date(r.created).toLocaleString("da-DK", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  let txt = "";
  if (r.type === "proeveflade") { const s = plotStats(r.data); txt = `Prøveflade r=${fmt(r.data.radius, 2)} m · ${s.n} træer · Dg ${fmt(s.Dg)} · ${fmt(s.N, 0)} stk/ha`; }
  else if (r.type === "foto") txt = "Foto" + (r.data.note ? ": " + esc(r.data.note) : "");
  else if (r.type === "note") txt = esc(r.data.note);
  else if (r.type === "taksation") txt = `Taksation: Hg ${fmt(num(r.data.hg))} · Dg ${fmt(num(r.data.dg))} · ${fmt(num(r.data.n), 0)} stk/ha`;
  return `<li data-id="${r.id}">${r.type === "foto" ? `<img data-thumb="${r.id}" alt="">` : ""}
    <div class="grow">${txt}<br><span class="muted">${when}${r.stand ? " · " + esc(r.stand.label) : ""}${r.exported ? " · eksporteret" : ""}</span></div>
    <button data-act="edit" data-id="${r.id}">Ret</button></li>`;
}
function hydrateThumbs() {
  sheet.querySelectorAll("img[data-thumb]").forEach(img => {
    const r = state.regs.find(x => x.id === img.dataset.thumb);
    if (r?.photo) img.src = URL.createObjectURL(r.photo);
  });
}

/* -------- prøveflade-formular */
function plotForm(reg) {
  const d = reg.data;
  openSheet(`
    <div class="head"><h3>Prøveflade · ${esc(reg.stand?.label || "uden litra")}</h3><button data-act="cancelForm" class="close">Annullér</button></div>
    <div class="row">
      <div><label>Radius (m)</label><select id="pRadius">${RADII.map(r => `<option value="${r}" ${r === d.radius ? "selected" : ""}>${fmt(r, 2)} m (${Math.round(Math.PI * r * r)} m²)</option>`).join("")}</select></div>
      <div><label>Position</label><button id="pPos" style="width:100%">${reg.lat ? `±${Math.round(reg.accuracy || 0)} m ✓` : "Brug GPS"}</button></div>
    </div>
    <div class="row">
      <div><label>Diameter (cm)</label><input id="pD" inputmode="decimal" placeholder="fx 23,5" autocomplete="off"></div>
      <div><label>Højde (m) – valgfri</label><input id="pH" inputmode="decimal" placeholder="" autocomplete="off"></div>
      <div style="flex:0 0 auto"><button class="primary" id="pAdd">Tilføj</button></div>
    </div>
    <div class="trees" id="pTrees"></div>
    <div class="result" id="pRes"></div>
    <div class="row">
      <div><label>Hg (m) – hvis ikke målt på træer</label><input id="pHg" inputmode="decimal" value="${esc(d.hg ?? "")}"></div>
      <div><label>Bk (%)</label><input id="pBk" inputmode="numeric" value="${esc(d.bk ?? "")}"></div>
    </div>
    <label>Note</label><textarea id="pNote">${esc(d.note || "")}</textarea>
    <div class="stack">
      <button class="primary big" id="pSave">Gem prøveflade</button>
      ${reg._new ? "" : '<button class="danger" id="pDel">Slet prøveflade</button>'}
    </div>`, true);
  const trees = d.trees.map(t => ({ ...t }));
  const draw = () => {
    $("#pTrees").innerHTML = trees.map((t, i) => `<button data-i="${i}" title="Tryk for at fjerne">${fmt(num(t.d), 1)}${num(t.h) ? " / " + fmt(num(t.h), 1) + " m" : ""} ✕</button>`).join("");
    const s = plotStats({ radius: +$("#pRadius").value, trees, hg: $("#pHg").value });
    $("#pRes").innerHTML = `<b>${s.n} træer</b> · ${fmt(s.N, 0)} stk/ha · G ${fmt(s.G)} m²/ha · Dg ${fmt(s.Dg)} cm · Hg ${fmt(s.Hg)} m${s.heights ? ` (${s.heights} højder)` : ""}`;
  };
  const add = () => {
    const dv = num($("#pD").value); if (!dv || dv <= 0 || dv > 200) { toast("Skriv en diameter i cm"); $("#pD").focus(); return; }
    trees.push({ d: dv, h: num($("#pH").value) }); $("#pD").value = ""; $("#pH").value = ""; $("#pD").focus(); draw();
  };
  $("#pAdd").onclick = add;
  $("#pD").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  $("#pH").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  $("#pTrees").onclick = e => { const b = e.target.closest("button"); if (b) { trees.splice(+b.dataset.i, 1); draw(); } };
  $("#pRadius").onchange = draw; $("#pHg").oninput = draw;
  $("#pPos").onclick = () => { if (!state.me) return toast("Venter på GPS …"); Object.assign(reg, pos()); $("#pPos").textContent = `±${Math.round(reg.accuracy)} m ✓`; };
  $("#pSave").onclick = async () => {
    reg.data = { radius: +$("#pRadius").value, trees, hg: num($("#pHg").value), bk: num($("#pBk").value), note: $("#pNote").value.trim() };
    if (!trees.length && reg.data.hg === null) return toast("Prøvefladen er tom");
    await saveReg(reg); toast("Prøveflade gemt"); backToStand(reg);
  };
  if ($("#pDel")) $("#pDel").onclick = () => deleteReg(reg);
  draw();
}

/* -------- direkte taksation */
function taxForm(reg) {
  const d = reg.data, f = (id, lbl, v, mode = "decimal") => `<div><label>${lbl}</label><input id="${id}" inputmode="${mode}" value="${esc(v ?? "")}"></div>`;
  openSheet(`
    <div class="head"><h3>Taksation · ${esc(reg.stand.label)}</h3><button data-act="cancelForm" class="close">Annullér</button></div>
    <p class="muted">Udfyld kun det, du har vurderet. Tomme felter beholder SkovPlans tal ved indlæsning.</p>
    <div class="row">${f("tHg", "Hg (m)", d.hg)}${f("tDg", "Dg (cm)", d.dg)}</div>
    <div class="row">${f("tN", "Stamtal (pr. ha)", d.n, "numeric")}${f("tG", "Grundflade (m²/ha)", d.g)}</div>
    <div class="row">${f("tV", "Vedmasse (m³/ha)", d.v)}${f("tBk", "Bk (%)", d.bk, "numeric")}</div>
    <label>Ny træart (kun hvis den er forkert)</label><input id="tArt" value="${esc(d.art || "")}">
    <label>Note</label><textarea id="tNote">${esc(d.note || "")}</textarea>
    <div class="stack"><button class="primary big" id="tSave">Gem taksation</button>
    ${reg._new ? "" : '<button class="danger" id="tDel">Slet</button>'}</div>`, true);
  $("#tSave").onclick = async () => {
    reg.data = { hg: num($("#tHg").value), dg: num($("#tDg").value), n: num($("#tN").value), g: num($("#tG").value),
      v: num($("#tV").value), bk: num($("#tBk").value), art: $("#tArt").value.trim(), note: $("#tNote").value.trim() };
    if (!reg.lat && state.me) Object.assign(reg, pos());
    await saveReg(reg); toast("Taksation gemt"); backToStand(reg);
  };
  if ($("#tDel")) $("#tDel").onclick = () => deleteReg(reg);
}

/* -------- note / foto */
function noteForm(reg) {
  openSheet(`
    <div class="head"><h3>${reg.type === "foto" ? "Foto" : "Note"} · ${esc(reg.stand?.label || "uden litra")}</h3><button data-act="cancelForm" class="close">Annullér</button></div>
    ${reg.photo ? `<img id="nImg" style="width:100%;border-radius:10px;margin:6px 0" alt="">` : ""}
    <label>${reg.type === "foto" ? "Tekst til billedet" : "Note"}</label><textarea id="nNote">${esc(reg.data.note || "")}</textarea>
    <div class="stack"><button class="primary big" id="nSave">Gem</button>${reg._new ? "" : '<button class="danger" id="nDel">Slet</button>'}</div>`);
  if (reg.photo) $("#nImg").src = URL.createObjectURL(reg.photo);
  $("#nSave").onclick = async () => {
    reg.data.note = $("#nNote").value.trim();
    if (reg.type === "note" && !reg.data.note) return toast("Noten er tom");
    await saveReg(reg); toast("Gemt"); backToStand(reg);
  };
  if ($("#nDel")) $("#nDel").onclick = () => deleteReg(reg);
}
async function takePhoto(file) {
  const blob = await shrinkImage(file, 1600, 0.82);
  const stand = currentStand();
  noteForm({ id: uid(), _new: true, type: "foto", created: new Date().toISOString(), ...pos(), stand, data: { note: "", filename: file.name }, photo: blob });
}
async function shrinkImage(file, max, q) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(b => res(b || file), "image/jpeg", q));
  } catch (e) { return file; }
}

/* -------- fælles */
const pos = () => state.me ? { lat: state.me.lat, lon: state.me.lon, accuracy: state.me.accuracy } : {};
function currentStand() {
  if (state.selected) return standInfo(state.selected.properties);
  if (state.me) { const f = standAt(state.me.lon, state.me.lat); if (f) return standInfo(f.properties); }
  return null;
}
function newReg(type) {
  const stand = currentStand();
  const base = { id: uid(), _new: true, type, created: new Date().toISOString(), ...pos(), stand };
  if (type === "proeveflade") return plotForm({ ...base, data: { radius: 10, trees: [], hg: null, bk: null, note: "" } });
  if (type === "taksation") return stand ? taxForm({ ...base, data: {} }) : toast("Vælg et litra først");
  if (type === "note") return noteForm({ ...base, data: { note: "" } });
}
async function saveReg(reg) {
  delete reg._new; reg.updated = new Date().toISOString(); delete reg.exported;
  await db.put("regs", reg);
  const i = state.regs.findIndex(r => r.id === reg.id); i >= 0 ? state.regs[i] = reg : state.regs.push(reg);
  drawRegMarkers(); restyle(); refreshMenuInfo();
}
async function deleteReg(reg) {
  if (!confirm("Slet denne registrering?")) return;
  await db.del("regs", reg.id); state.regs = state.regs.filter(r => r.id !== reg.id);
  drawRegMarkers(); restyle(); refreshMenuInfo(); backToStand(reg);
}
function backToStand(reg) {
  const f = reg.stand && state.data?.layers.skovafdelinger.features.find(x => standKey(x.properties) === reg.stand.key);
  f ? selectStand(f) : listAll();
}
let regLayer = null;
function drawRegMarkers() {
  if (regLayer) map.removeLayer(regLayer);
  regLayer = L.layerGroup(state.regs.filter(r => r.lat).map(r => L.circleMarker([r.lat, r.lon], {
    radius: r.type === "proeveflade" ? 7 : 5, color: "#fff", weight: 2, fillOpacity: 1,
    fillColor: { proeveflade: "#7a1fa2", foto: "#e8710a", note: "#1a73e8", taksation: "#0b8043" }[r.type],
  }).on("click", () => editReg(r.id)))).addTo(map);
}
function editReg(id) {
  const r = state.regs.find(x => x.id === id); if (!r) return;
  const copy = { ...r, data: JSON.parse(JSON.stringify(r.data)) };
  ({ proeveflade: plotForm, taksation: taxForm, foto: noteForm, note: noteForm })[r.type](copy);
}
function listAll() {
  state.selected = null; restyle();
  const regs = [...state.regs].sort((a, b) => b.created.localeCompare(a.created));
  openSheet(`<div class="head"><h3>Alle registreringer (${regs.length})</h3><button class="close">Luk</button></div>
    <div class="actions"><button class="primary" data-act="newPlot">+ Prøveflade</button><button data-act="photo">📷 Foto</button><button data-act="note">✎ Note</button></div>
    ${regs.length ? `<ul class="list">${regs.map(regItem).join("")}</ul>` : '<p class="muted">Ingen registreringer endnu. Tryk på et litra på kortet for at begynde.</p>'}
    <button class="primary big" data-act="export">Eksportér til SkovPlan</button>`);
  hydrateThumbs();
}

/* ------------------------------------------------------------------ eksport */
const TAX_HEADERS = ["Afd", "Litra", "Areal (ha)", "Træart", "Sidste taksation", "Taksationsår", "Hg (m)", "Dg (cm)",
  "Stamtal (pr. ha)", "Grundflade (m²/ha)", "Vedmasse (m³/ha)", "Bk (%)", "Ny bemærkning", "Ny træart", "Etableringsår"];
const csvCell = v => { const s = String(v ?? ""); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function buildTaxCsv() {
  const by = {};
  state.regs.filter(r => r.stand).forEach(r => (by[r.stand.key] = by[r.stand.key] || []).push(r));
  const lines = [TAX_HEADERS.join(";")];
  const keys = Object.keys(by).sort((a, b) => { const [x, y] = [a, b].map(k => k.split("|")); return (+x[0] - +y[0]) || x[1].localeCompare(y[1], "da"); });
  let rows = 0;
  for (const key of keys) {
    const regs = by[key], st = regs[0].stand, s = standSummary(regs);
    const notes = regs.filter(r => r.data.note).map(r => r.data.note);
    const plots = regs.filter(r => r.type === "proeveflade");
    const radii = [...new Set(plots.map(p => fmt(p.data.radius, 2)))].join("/");
    const head = plots.length ? `${plots.length} prøveflade${plots.length === 1 ? "" : "r"} (r=${radii} m)` : "";
    const photos = regs.filter(r => r.type === "foto").length;
    const bem = [`Felt ${today()}`, head, photos ? `${photos} foto` : "", ...notes].filter(Boolean).join("; ");
    const hasMeasure = ["Hg", "Dg", "N", "G", "V", "Bk"].some(k => s[k] !== undefined && s[k] !== null) || s.art;
    if (!hasMeasure && !notes.length) continue;
    lines.push([st.afd, st.litra, csvNum(standArea(key) || st.areal, 2), st.art, "", hasMeasure ? YEAR : "",
      csvNum(s.Hg, 1), csvNum(s.Dg, 1), csvNum(s.N, 0), csvNum(s.G, 1), csvNum(s.V, 0), csvNum(s.Bk, 0), bem, s.art || "", ""].map(csvCell).join(";"));
    rows++;
  }
  return { csv: "﻿" + lines.join("\r\n") + "\r\n", rows };
}
function photoName(r) { return `fotos/${(r.stand?.label || "uden-litra").replace(/[^\wæøåÆØÅ-]+/g, "_")}_${r.created.slice(0, 19).replace(/[:T]/g, "-")}_${r.id.slice(-4)}.jpg`; }
function buildGeoJSON() {
  return {
    type: "FeatureCollection",
    features: state.regs.map(r => {
      const props = { id: r.id, type: r.type, oprettet: r.created, gps_noejagtighed_m: r.accuracy ? Math.round(r.accuracy) : null,
        afd: r.stand?.afd ?? null, litra: r.stand?.litra ?? null, litra_navn: r.stand?.label ?? null, compartment_id: r.stand?.compartment_id ?? null,
        note: r.data.note || null };
      if (r.type === "proeveflade") { const s = plotStats(r.data); Object.assign(props, { radius_m: r.data.radius, antal_traeer: s.n, stamtal_ha: Math.round(s.N),
        grundflade_m2_ha: +s.G.toFixed(2), dg_cm: s.Dg && +s.Dg.toFixed(1), hg_m: s.Hg && +s.Hg.toFixed(1), bk_pct: r.data.bk, traeer_json: JSON.stringify(r.data.trees) }); }
      if (r.type === "taksation") Object.assign(props, { hg_m: r.data.hg, dg_cm: r.data.dg, stamtal_ha: r.data.n, grundflade_m2_ha: r.data.g, vedmasse_m3_ha: r.data.v, bk_pct: r.data.bk, ny_traeart: r.data.art || null });
      if (r.type === "foto") props.foto = photoName(r);
      return { type: "Feature", geometry: r.lat ? { type: "Point", coordinates: [+r.lon.toFixed(7), +r.lat.toFixed(7)] } : null, properties: props };
    }),
  };
}
async function doExport() {
  if (!state.regs.length) return toast("Der er intet at eksportere endnu");
  const zip = new JSZip(), stamp = today(), { csv, rows } = buildTaxCsv();
  zip.file(`taksationsark_felt_${stamp}.csv`, csv);
  zip.file("registreringer.geojson", JSON.stringify(buildGeoJSON(), null, 1));
  state.regs.filter(r => r.photo).forEach(r => zip.file(photoName(r), r.photo));
  zip.file("LAES-MIG.txt", [
    `SkovPlan Felt – eksport ${new Date().toLocaleString("da-DK")}`, `Skov: ${state.data?.name || ""}`, "",
    `taksationsark_felt_${stamp}.csv: ${rows} litra. Indlæs i SkovPlan med «Importér bevoksningsliste fra Excel/CSV…».`,
    "  Tomme celler betyder «behold SkovPlans tal». Hg/Dg/stamtal/grundflade er beregnet fra prøvefladerne (gennemsnit pr. litra).",
    "registreringer.geojson: alle prøveflader, fotos og noter som punkter (WGS84). Kan trækkes direkte ind i QGIS.",
    "fotos/: billederne; filnavnet står i feltet «foto» i geojson-filen.",
  ].join("\r\n"));
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const name = `skovplan-felt_${(state.data?.name || "skov").replace(/[^\wæøåÆØÅ-]+/g, "_")}_${stamp}.zip`;
  const file = new File([blob], name, { type: "application/zip" });
  let shared = false;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); shared = true; } catch (e) { if (e.name === "AbortError") return; }
  }
  if (!shared) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  const t = new Date().toISOString();
  for (const r of state.regs) { r.exported = t; await db.put("regs", r); }
  refreshMenuInfo(); toast(`Eksporteret: ${state.regs.length} registreringer, ${rows} litra i taksationsarket`, 4000);
}
async function clearExported() {
  const done = state.regs.filter(r => r.exported);
  if (!done.length) return toast("Ingen eksporterede registreringer at slette");
  if (!confirm(`Slet ${done.length} registreringer, der allerede er eksporteret?`)) return;
  for (const r of done) await db.del("regs", r.id);
  state.regs = state.regs.filter(r => !r.exported); drawRegMarkers(); restyle(); refreshMenuInfo(); closeSheet();
}

/* ------------------------------------------------------------------ handlinger */
function refreshMenuInfo() {
  const n = state.regs.length, ne = state.regs.filter(r => !r.exported).length;
  $("#menuInfo").textContent = `${state.data ? (state.data.name + " · indlæst " + new Date(state.data.loaded).toLocaleDateString("da-DK")) : "Intet skovkort"} · ${n} registreringer${ne ? `, ${ne} ikke eksporteret` : ""}`;
}
const ACTIONS = {
  openGpkg: () => $("#gpkgInput").click(),
  listAll, export: doExport, clearRegs: clearExported,
  basemap: () => { setBasemap((state.basemap + 1) % BASEMAPS.length); restyle(); toast(BASEMAPS[state.basemap].name); },
  newPlot: () => newReg("proeveflade"), note: () => newReg("note"), taksation: () => newReg("taksation"),
  photo: () => $("#photoInput").click(),
  edit: el => editReg(el.dataset.id),
  cancelForm: () => { const f = state.selected; f ? selectStand(f) : closeSheet(); },
};
document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]");
  if (el) { e.preventDefault(); $("#menu").classList.add("hidden"); ACTIONS[el.dataset.act]?.(el); return; }
  if (!e.target.closest("#menu, #btnMenu")) $("#menu").classList.add("hidden");
});
$("#btnMenu").onclick = () => { refreshMenuInfo(); $("#menu").classList.toggle("hidden"); };
$("#photoInput").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) takePhoto(f); };
$("#gpkgInput").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  toast("Læser " + f.name + " …", 10000);
  try {
    const data = await readGpkg(f);
    await db.put("kv", data, "skovkort"); state.data = data; drawData(); fitData();
    $("#empty").classList.add("hidden");
    toast(`Indlæst: ${data.layers.skovafdelinger.features.length} litradele`);
  } catch (err) { console.error(err); toast("Kunne ikke læse filen: " + err.message, 6000); }
};
function fitData() { try { map.fitBounds(L.geoJSON(state.data.layers.skovafdelinger).getBounds(), { padding: [20, 20] }); } catch (e) { /* tom */ } }

/* ------------------------------------------------------------------ start */
(async function start() {
  try { await navigator.storage?.persist?.(); } catch (e) { /* ok */ }
  try {
    state.data = await db.get("kv", "skovkort");
    state.regs = await db.all("regs");
  } catch (e) { console.error(e); toast("Telefonens lager kunne ikke åbnes: " + e.message, 6000); }
  if (state.data) { drawData(); fitData(); } else $("#empty").classList.remove("hidden");
  drawRegMarkers(); startGps();
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW", e));
})();
