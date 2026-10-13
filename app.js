/* SkovPlan Felt – enkel feltapp (PWA).
 *
 * Læser skovens GeoPackage direkte på telefonen (sql.js), viser litraerne på et
 * kort med GPS-position og gemmer prøveflader, fotos og noter i telefonens
 * IndexedDB.  Skovkort og ortofoto kommer fra SkovPlans «Lav feltpakke til appen» (én zip).
 * «Eksportér» laver en zip, som SkovPlan henter med «Hent data fra app»:
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
  aflaegningspladser: { style: { color: "#5b3a17", fillColor: "#f2c14e", fillOpacity: 1, weight: 2, radius: 7 } },
};
/* Lokale hensyn fra feltpakken (feltlag.json): navn i menuen «Vis lag», stil og evt. tekst ved klik. */
const EXTRA = {
  naturtyper: { name: "§3-naturtyper", style: { color: "#0a8f5a", weight: 2, dashArray: "6 3", fillColor: "#0a8f5a", fillOpacity: 0.14 },
    label: p => "§3 " + (p.Natyp_navn || "natur") },
  diger: { name: "Beskyttede diger", style: { color: "#6b4f2a", weight: 3.5, dashArray: "2 5", lineCap: "round" },
    info: p => "Beskyttet dige" + (p.Digetypebeskrivelse ? ": " + p.Digetypebeskrivelse : "") + (p.Stendige ? " (stendige)" : "") },
  fortidsminde_zoner: { name: "Fortidsminders beskyttelseszone", style: { color: "#8a3ffc", weight: 1.5, dashArray: "4 4", fill: false } },
  fortidsminder: { name: "Fortidsminder", style: { color: "#fff", weight: 2, fillColor: "#8a3ffc", fillOpacity: 1, radius: 7 },
    info: p => "Fortidsminde: " + [p.anlaegstype, p.datering, p.frednr ? "fredningsnr. " + p.frednr : ""].filter(Boolean).join(" · ") },
};
const STAND_FIELDS = ["compartment_id", "navn", "afdeling", "afdeling_nr", "litra", "træart", "etableringsaar",
  "alder", "middelhoejde_m", "middeldiameter_cm", "stamtal_ha", "grundflade_m2_ha", "vedmasse_m3_ha",
  "areal_ha", "bemærkning", "taksationsaar", "dataaar", "p3_status", "p3_naturtyper"];
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
      const r = indexedDB.open("skovplan-felt", 2);
      r.onupgradeneeded = () => {
        const d = r.result, have = n => d.objectStoreNames.contains(n);
        if (!have("kv")) d.createObjectStore("kv");
        if (!have("regs")) d.createObjectStore("regs", { keyPath: "id" });
        if (!have("tiles")) d.createObjectStore("tiles");
      };
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
  clear(store) { return this.tx(store, "readwrite", s => { s.clear(); }); },
  putMany(store, entries) { return this.tx(store, "readwrite", s => { for (const [k, v] of entries) s.put(v, k); }); },
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
/* QGIS gemmer GeoPackages i WAL-tilstand, som sql.js ikke kan åbne. Vi læser kun, så filen sættes til almindelig journal. */
function sqliteBytes(buf) {
  const b = new Uint8Array(buf);
  if (b.length > 100 && b[18] === 2 && b[19] === 2) { b[18] = 1; b[19] = 1; }
  return b;
}
async function openSqlite(file) {
  SQL = SQL || await initSqlJs({ locateFile: f => "lib/" + f });
  return new SQL.Database(sqliteBytes(await file.arrayBuffer()));
}
const hasTable = (g, t) => !!g.exec(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='${t}'`)[0];
function readGpkg(g, file) {
  {
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
      const keep = name === "skovafdelinger" ? STAND_FIELDS.filter(c => cols.includes(c)) : cols.filter(c => ["navn", "type", "vejtype", "linjetype", "sortiment", "aktivitet", "bemærkning"].includes(c));
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
  }
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
const map = L.map("map", { zoomControl: false, attributionControl: true, maxZoom: 21 }).setView([56.0, 9.5], 7);
L.control.zoom({ position: "bottomright" }).addTo(map);
/* Ortofoto fra SkovPlan (MBTiles, gemt i telefonens IndexedDB) */
/* Fliserne tegnes på et lærred, så kanten af ortofotoet (sort i JPEG-fliser) males grå uden for fotoets udstrækning. */
const OrthoLayer = L.GridLayer.extend({
  createTile(c, done) {
    const cv = document.createElement("canvas"); cv.width = cv.height = 256;
    db.get("tiles", `${c.z}/${c.x}/${c.y}`).then(b => {
      if (!b) return done(null, cv);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(img.src);
        const g = cv.getContext("2d"); g.drawImage(img, 0, 0, 256, 256);
        const bb = this.options.bounds;
        if (bb) {
          const a = this._map.project(bb.getNorthWest(), c.z), z = this._map.project(bb.getSouthEast(), c.z);
          const x0 = a.x - c.x * 256, y0 = a.y - c.y * 256, x1 = z.x - c.x * 256, y1 = z.y - c.y * 256;
          g.fillStyle = "#dddddd";
          if (y0 > 0) g.fillRect(0, 0, 256, Math.ceil(y0));
          if (y1 < 256) g.fillRect(0, Math.floor(y1), 256, 256);
          if (x0 > 0) g.fillRect(0, 0, Math.ceil(x0), 256);
          if (x1 < 256) g.fillRect(Math.floor(x1), 0, 256, 256);
        }
        done(null, cv);
      };
      img.onerror = () => done(null, cv);
      img.src = URL.createObjectURL(b);
    }).catch(e => done(e, cv));
    return cv;
  },
});
const BASEMAPS = [
  { name: "Ortofoto (gemt)", layer: null, ortho: true },
  { name: "OpenStreetMap", layer: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20, maxNativeZoom: 19, attribution: "© OpenStreetMap" }) },
  { name: "Ingen baggrund", layer: null },
];
function makeOrtho() {
  const m = state.ortho; if (!m) return null;
  return new OrthoLayer({ minZoom: 0, maxZoom: 21, minNativeZoom: m.minzoom, maxNativeZoom: m.maxzoom, attribution: m.attribution || "Ortofoto",
    bounds: m.bounds ? L.latLngBounds([m.bounds[1], m.bounds[0]], [m.bounds[3], m.bounds[2]]) : undefined });
}
function setBasemap(i) {
  BASEMAPS.forEach(b => b.layer && map.removeLayer(b.layer));
  if (BASEMAPS[i].ortho && !state.ortho) i = 1;
  if (BASEMAPS[0].layer && BASEMAPS[0].layer._skovMeta !== state.ortho) BASEMAPS[0].layer = null;
  if (BASEMAPS[i].ortho && !BASEMAPS[0].layer) { BASEMAPS[0].layer = makeOrtho(); BASEMAPS[0].layer._skovMeta = state.ortho; }
  state.basemap = i; const b = BASEMAPS[i]; if (b.layer) b.layer.addTo(map).bringToBack();
  try { localStorage.setItem("basemap", i); } catch (e) { /* ok */ }
}
function safeLS(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

/* SkovPlans litrafarver (træart -> fyldfarve), som de står i SkovPlan-projektet. */
const SPECIES_COLORS = {
  "Agerjord": "#e0eeec", "Almindelig ædelgran": "#6a3d9a", "Anden anvendelse": "#f4f3bf", "andet": "#f4f3bf",
  "Bjergfyr": "#e59a59", "Blandet løvskov": "#f6f57f", "Blandet løv": "#f6f57f", "Blandet nåleskov": "#bda662",
  "Blandet nål": "#bda662", "Bøg": "#c3f88d", "Contortafyr": "#f2c29b", "Douglasgran": "#e0b030", "Eg": "#f8a9a8",
  "Eng": "#daf3bf", "Lysåbent": "#d8c76a", "Lysåben": "#d8c76a", "Grandis": "#5e35b1", "Hus": "#9b6a58",
  "Ikke fastlagt": "#e1e1e1", "Ikke bestemt": "#e1e1e1", "Lærk": "#8bc34a", "Mose": "#6b9c86",
  "Naturlig succession": "#e99758", "Naturforyngelse": "#e99758", "Nobilis": "#b39ddb", "Ædelgran": "#8e6bbf",
  "Rødgran": "#7f8c8d", "Serbisk gran": "#2e5f8a", "Omorika": "#3b74a8", "Sitkagran": "#4a90a4", "Skovbryn": "#4272cc",
  "Skovfyr": "#c8742b", "Udyrket areal": "#d82e83", "Udyrket": "#d82e83", "Sø": "#6e99f1", "Søer": "#6e99f1",
  "Vand": "#6e99f1", "Vej": "#ffffff", "Blandet løv og nål": "#8fa8d9", "Rødel": "#2f8f6b", "Poppel": "#e8b4d4",
  "Birk": "#f4f0a0", "Vestamerikansk hemlock": "#00897b", "Hemlock": "#30d10c", "Ask": "#ddb4f5", "Ær": "#f7d26c",
  "Løn": "#f7d26c", "Ær, Løn": "#f7d26c", "Andet løvtræ": "#f6f57f", "Andet nåletræ": "#9e9d24", "Vandløb": "#4276b4",
  "Slette, Overdrev": "#daf3bf", "Ahorn": "#e69f76", "Avnbøg": "#d2ad48", "Bygning/bebygget areal": "#c78f5b",
  "Cypres": "#455a64", "Europæisk lærk": "#c5e1a5", "Fuglekirsebær": "#50c4ca", "Gran": "#9fb4c7",
  "Græsareal": "#77c574", "Hede": "#cd5aa5", "Hybridasp": "#5bdbe7", "Hybridlærk": "#aed581", "Japansk lærk": "#689f38",
  "Krat": "#7345d5", "Liggeplads": "#caa147", "Læhegn": "#cfc558", "Mark": "#8072cf", "Naturareal": "#4ad56f",
  "OP42": "#63c9c2", "Overdrev": "#4ecac2", "Park/have": "#576fc6", "Rødeg": "#c66679", "Stilkeg": "#70c6d1",
  "Tsuga": "#4db6ac", "Vildtager": "#e0665b", "Vortebirk": "#8de471", "Vådområde": "#c6455b", "Å": "#bca84d",
};
const NO_SPECIES_COLOR = "#afafa5";
const normName = s => String(s ?? "").split(/\s+/).filter(Boolean).join(" ").toLocaleLowerCase("da");
const COLOR_LOOKUP = Object.fromEntries(Object.entries(SPECIES_COLORS).map(([k, v]) => [normName(k), v]));
const autoColors = {};
/* Samme automatiske farve som SkovPlan giver arter uden fast farve (sha256 -> HSV). */
async function prepareAutoColors(names) {
  for (const name of names) {
    const key = normName(name);
    if (!key || COLOR_LOOKUP[key] || autoColors[key] || !crypto?.subtle) continue;
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
    autoColors[key] = hsvHex(((d[0] << 8) | d[1]) % 360, 105 + (d[2] % 75), 185 + (d[3] % 55));
  }
}
function hsvHex(h, s, v) {
  s /= 255; v /= 255; const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return "#" + [r, g, b].map(t => Math.round((t + m) * 255).toString(16).padStart(2, "0")).join("");
}
const colorFor = art => { const k = normName(art); return k ? (COLOR_LOOKUP[k] || autoColors[k] || NO_SPECIES_COLOR) : NO_SPECIES_COLOR; };

function drawData() {
  state.overlays.forEach(l => map.removeLayer(l)); state.overlays = [];
  (state.extraLabels || []).forEach(t => t.remove()); state.extraLabels = [];
  if (!state.data) return;
  const L_ = state.data.layers;
  for (const name of ["kortlinjer", "adgangsveje", "ejendomsgraense", "indgange"]) {
    if (!L_[name]) continue; const st = LAYERS[name].style;
    const lyr = L.geoJSON(L_[name], { style: () => st, pointToLayer: (f, ll) => L.circleMarker(ll, st), interactive: false }).addTo(map);
    state.overlays.push(lyr);
  }
  const hidden = hiddenLayers(), extra = state.data.extra?.lag || {};
  const counts = countByStand();
  state.standLayer = L.geoJSON(L_.skovafdelinger, {
    style: f => standStyle(f, counts),
    onEachFeature: (f, lyr) => {
      lyr.on("click", () => selectStand(f));
      lyr.bindTooltip(labelHtml(f.properties, true, counts), { permanent: true, direction: "center", className: "litra-label" });
    },
  }).addTo(map);
  state.overlays.push(state.standLayer);
  // hensyn oven på litraerne: §3-naturtyper, diger, fortidsminder, aflægningspladser
  state.extraLabels = [];
  for (const [key, def] of Object.entries(EXTRA)) {
    if (!extra[key] || hidden.has(key)) continue;
    const lyr = L.geoJSON(extra[key], {
      style: () => def.style, interactive: !!def.info,
      pointToLayer: (f, ll) => L.circleMarker(ll, def.style),
      onEachFeature: (f, l) => {
        if (def.info) l.bindPopup(esc(def.info(f.properties)));
        if (def.label) state.extraLabels.push(L.tooltip({ permanent: true, direction: "center", className: "natur-label", interactive: false })
          .setLatLng(l.getBounds().getCenter()).setContent(esc(def.label(f.properties))));
      },
    }).addTo(map);
    state.overlays.push(lyr);
  }
  if (L_.aflaegningspladser && !hidden.has("aflaegningspladser")) {
    const st = LAYERS.aflaegningspladser.style;
    const lyr = L.geoJSON(L_.aflaegningspladser, { pointToLayer: (f, ll) => L.circleMarker(ll, st),
      onEachFeature: (f, l) => l.bindPopup(esc(["Aflægningsplads", f.properties.navn, f.properties.sortiment, f.properties["bemærkning"]].filter(Boolean).join(" · "))) }).addTo(map);
    state.overlays.push(lyr);
  }
  updateLabels();
  prepareAutoColors(new Set(L_.skovafdelinger.features.map(f => f.properties["træart"]))).then(restyle);
  $("#where").textContent = state.data.name || "";
}
function standStyle(f, counts) {
  const sel = state.selected && standKey(state.selected.properties) === standKey(f.properties);
  const has = counts[standKey(f.properties)];
  return { color: sel ? "#0b57d0" : has ? "#7a1fa2" : "#232323", weight: sel ? 4 : has ? 2.5 : 1,
    fillColor: colorFor(f.properties["træart"]), fillOpacity: state.basemap === 2 ? 0.85 : 0.66 };
}
function restyle() { if (!state.standLayer) return; const c = countByStand(); state.standLayer.eachLayer(l => l.setStyle(standStyle(l.feature, c))); }
/* Mærkaten som på SkovPlans kort (litra, art, år, §3), hvis feltpakken har den; ellers afd+litra.
   Langt ude vises kun litraet, tæt på hele mærkaten. */
function labelHtml(p, full, counts = countByStand()) {
  const m = state.data?.extra?.maerkater?.[p.compartment_id];
  const lines = m ? String(m).split(/\n/).filter(Boolean) : [standLabel(p)];
  const shown = full ? lines : lines.slice(0, 1);
  return shown.map(esc).join("<br>") + (counts[standKey(p)] ? " ●" : "");
}
function updateLabels() {
  if (!state.standLayer) return; const z = map.getZoom(), show = z >= 14, full = z >= 16;
  const counts = countByStand();
  state.standLayer.eachLayer(l => {
    const t = l.getTooltip(); if (!t) return;
    if (t._full !== full) { t.setContent(labelHtml(l.feature.properties, full, counts)); t._full = full; }
    show ? l.openTooltip() : l.closeTooltip();
  });
  (state.extraLabels || []).forEach(t => z >= 15 ? t.addTo(map) : t.remove());
  if (show) requestAnimationFrame(declutter);
}
/* Som i SkovPlan: mærkater må ikke overlappe; det største litra vinder, de mindre skjules. */
function declutter() {
  if (!state.standLayer) return;
  const area = l => { const b = l.getBounds(); return (b.getEast() - b.getWest()) * (b.getNorth() - b.getSouth()); };
  const items = [];
  state.standLayer.eachLayer(l => { const el = l.getTooltip()?.getElement(); if (el) { el.style.visibility = ""; items.push([area(l), el]); } });
  items.sort((a, b) => b[0] - a[0]);
  const placed = [];
  for (const [, el] of items) {
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    if (placed.some(q => r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top)) el.style.visibility = "hidden";
    else placed.push(r);
  }
}
map.on("moveend", () => state.standLayer && map.getZoom() >= 14 && requestAnimationFrame(declutter));
function hiddenLayers() { try { return new Set(JSON.parse(safeLS("hiddenLayers") || "[]")); } catch (e) { return new Set(); } }
function layerMenu() {
  const extra = state.data?.extra?.lag || {}, hidden = hiddenLayers();
  const items = Object.entries(EXTRA).filter(([k]) => extra[k]).map(([k, d]) => [k, d.name, extra[k].features.length]);
  if (state.data?.layers.aflaegningspladser) items.push(["aflaegningspladser", "Aflægningspladser", state.data.layers.aflaegningspladser.features.length]);
  openSheet(`<div class="head"><h3>Vis lag</h3><button class="close">Luk</button></div>
    ${items.length ? items.map(([k, n, c]) => `<label class="check"><input type="checkbox" data-layer="${k}" ${hidden.has(k) ? "" : "checked"}> ${esc(n)} <span class="muted">(${c})</span></label>`).join("")
      : `<p class="muted">Feltpakken har ingen naturtyper eller andre hensyn. Lav en ny feltpakke i SkovPlan, så kommer de med.</p>`}`);
  sheet.querySelectorAll("[data-layer]").forEach(cb => cb.onchange = () => {
    const h = hiddenLayers(); cb.checked ? h.delete(cb.dataset.layer) : h.add(cb.dataset.layer);
    safeLS("hiddenLayers", JSON.stringify([...h])); (state.extraLabels || []).forEach(t => t.remove()); drawData(); restyle();
  });
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
    ${p.p3_status === "Ja" ? `<p class="p3">§3-beskyttet${p.p3_naturtyper ? ": " + esc(p.p3_naturtyper) : ""}</p>` : ""}
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

function speciesOptions(extra) {
  const set = new Set(["Rødgran", "Sitkagran", "Douglasgran", "Ædelgran", "Nobilis", "Grandis", "Skovfyr", "Lærk", "Bøg", "Eg", "Ask", "Ahorn", "Birk", "Rødel", "Andet nåletræ", "Andet løvtræ"]);
  const notTree = /^(sø|søer|å|vand|vandløb|vej|eng|mose|hede|hus|mark|agerjord|krat|overdrev|slette|græs|park|vildtager|liggeplads|lysåben|udyrket|anden anvendelse|andet$|ikke |bygning|naturareal|vådområde|skovbryn|naturlig succession|naturforyngelse)/i;
  (state.data?.layers.skovafdelinger.features || []).forEach(f => { const a = f.properties["træart"]; if (a && !notTree.test(a)) set.add(a); });
  if (extra) set.add(extra);
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, "da"));
}
function perSpecies(p) {
  const by = {};
  for (const t of p.trees) { if (!num(t.d)) continue; (by[t.art || "?"] = by[t.art || "?"] || []).push(t); }
  return Object.entries(by).map(([art, trees]) => ({ art, ...plotStats({ ...p, hg: null, trees }) })).sort((a, b) => b.G - a.G);
}

/* -------- prøveflade-formular: én række pr. træ, som et taksationsark */
function plotForm(reg) {
  const d = reg.data, defArt = reg.stand?.art || "";
  const arts = speciesOptions(defArt);
  const blank = art => ({ art, d1: "", d2: "", h: "", note: "" });
  const trees = d.trees.map(t => ({ art: t.art || defArt, d1: t.d1 ?? t.d ?? "", d2: t.d2 ?? "", h: t.h ?? "", note: t.note || "" }));
  if (!trees.length) trees.push(blank(defArt));
  /* Krydsklupning: gennemsnittet af de to målinger; kun én måling = den ene. */
  const meanD = t => { const a = num(t.d1), b = num(t.d2); return a && b ? (a + b) / 2 : a || b || null; };
  openSheet(`
    <div class="head"><h3>Prøveflade · ${esc(reg.stand?.label || "uden litra")}</h3><button data-act="cancelForm" class="close">Annullér</button></div>
    <div class="row">
      <div><label>Radius (m)</label><select id="pRadius">${RADII.map(r => `<option value="${r}" ${r === d.radius ? "selected" : ""}>${fmt(r, 2)} m (${Math.round(Math.PI * r * r)} m²)</option>`).join("")}</select></div>
      <div><label>Position</label><button id="pPos" style="width:100%">${reg.lat ? `±${Math.round(reg.accuracy || 0)} m ✓` : "Brug GPS"}</button></div>
    </div>
    <label>Enkelttræer – krydsklup: D1, Enter, D2, Enter … (D = gennemsnit)</label>
    <div class="tablewrap"><table class="trees">
      <thead><tr><th>Nr</th><th>Træart</th><th>D1 (cm)</th><th>D2 (cm)</th><th>D</th><th>H (m)</th><th>Bemærkning</th><th></th></tr></thead>
      <tbody id="pRows"></tbody>
    </table></div>
    <button id="pAdd" style="width:100%;margin-top:6px">+ Træ</button>
    <div class="result" id="pRes"></div>
    <div class="row">
      <div><label>Hg (m) – hvis ikke målt på træer</label><input id="pHg" inputmode="decimal" value="${esc(d.hg ?? "")}"></div>
      <div><label>Bk (%)</label><input id="pBk" inputmode="numeric" value="${esc(d.bk ?? "")}"></div>
    </div>
    <label>Note til prøvefladen</label><textarea id="pNote">${esc(d.note || "")}</textarea>
    <div class="stack">
      <button class="primary big" id="pSave">Gem prøveflade</button>
      ${reg._new ? "" : '<button class="danger" id="pDel">Slet prøveflade</button>'}
    </div>`, true);
  const body = $("#pRows");
  const opts = sel => arts.map(a => `<option ${a === sel ? "selected" : ""}>${esc(a)}</option>`).join("");
  const rowHtml = (t, i) => `<tr data-i="${i}">
      <td class="nr">${i + 1}</td>
      <td><select data-k="art">${opts(t.art)}</select></td>
      <td><input data-k="d1" inputmode="decimal" value="${esc(t.d1)}" enterkeyhint="next"></td>
      <td><input data-k="d2" inputmode="decimal" value="${esc(t.d2)}" enterkeyhint="next"></td>
      <td class="dm">${meanD(t) ? fmt(meanD(t), 1) : ""}</td>
      <td><input data-k="h" inputmode="decimal" value="${esc(t.h)}" enterkeyhint="next"></td>
      <td><input data-k="note" value="${esc(t.note)}" placeholder=""></td>
      <td><button class="del" data-del="${i}" aria-label="Fjern træ">✕</button></td></tr>`;
  const drawRows = () => { body.innerHTML = trees.map(rowHtml).join(""); };
  const summary = () => {
    const p = { radius: +$("#pRadius").value, trees: trees.filter(meanD).map(t => ({ ...t, d: meanD(t), h: num(t.h) })), hg: $("#pHg").value };
    const s = plotStats(p), arts = perSpecies(p);
    $("#pRes").innerHTML = `<b>${s.n} træer</b> · ${fmt(s.N, 0)} stk/ha · G ${fmt(s.G)} m²/ha · Dg ${fmt(s.Dg)} cm · Hg ${fmt(s.Hg)} m${s.heights ? ` (${s.heights} højder)` : ""}`
      + (arts.length > 1 ? "<br>" + arts.map(a => `${esc(a.art)}: ${a.n} stk, G ${fmt(a.G)}, Dg ${fmt(a.Dg)}`).join(" · ") : "");
  };
  const addRow = () => {
    const last = trees[trees.length - 1];
    trees.push(blank(last ? last.art : defArt));
    drawRows(); summary();
    body.querySelector(`tr[data-i="${trees.length - 1}"] input[data-k="d1"]`).focus();
  };
  body.addEventListener("input", e => {
    const tr = e.target.closest("tr"), k = e.target.dataset.k; if (!tr || !k) return;
    trees[+tr.dataset.i][k] = e.target.value; summary();
    if (k === "d1" || k === "d2") { const m = meanD(trees[+tr.dataset.i]); tr.querySelector(".dm").textContent = m ? fmt(m, 1) : ""; }
  });
  body.addEventListener("change", e => {
    const tr = e.target.closest("tr"), k = e.target.dataset.k; if (!tr || !k) return;
    trees[+tr.dataset.i][k] = e.target.value; summary();
  });
  body.addEventListener("keydown", e => {
    if (e.key !== "Enter") return; e.preventDefault();
    const tr = e.target.closest("tr"), i = +tr.dataset.i, k = e.target.dataset.k;
    if (k === "d1") { if (String(trees[i].d1).trim()) tr.querySelector('input[data-k="d2"]').focus(); return; }
    if (!meanD(trees[i])) return;
    const next = body.querySelector(`tr[data-i="${i + 1}"] input[data-k="d1"]`);
    next ? next.focus() : addRow();
  });
  body.addEventListener("click", e => {
    const b = e.target.closest("[data-del]"); if (!b) return;
    trees.splice(+b.dataset.del, 1); if (!trees.length) trees.push(blank(defArt));
    drawRows(); summary();
  });
  $("#pAdd").onclick = addRow;
  $("#pRadius").onchange = summary; $("#pHg").oninput = summary;
  $("#pPos").onclick = () => { if (!state.me) return toast("Venter på GPS …"); Object.assign(reg, pos()); $("#pPos").textContent = `±${Math.round(reg.accuracy)} m ✓`; };
  $("#pSave").onclick = async () => {
    const badNum = v => String(v).trim() && (!num(v) || num(v) <= 0 || num(v) > 200);
    const bad = trees.find(t => badNum(t.d1) || badNum(t.d2));
    if (bad) return toast(`Træ ${trees.indexOf(bad) + 1}: diameteren skal være et tal i cm`);
    const kept = trees.filter(meanD).map(t => ({ art: t.art, d1: num(t.d1), d2: num(t.d2), d: +meanD(t).toFixed(2), h: num(t.h), note: String(t.note || "").trim() }));
    reg.data = { radius: +$("#pRadius").value, trees: kept, hg: num($("#pHg").value), bk: num($("#pBk").value), note: $("#pNote").value.trim() };
    if (!kept.length && reg.data.hg === null) return toast("Prøvefladen er tom");
    await saveReg(reg); toast("Prøveflade gemt"); backToStand(reg);
  };
  if ($("#pDel")) $("#pDel").onclick = () => deleteReg(reg);
  drawRows(); summary();
  if (reg._new) body.querySelector('input[data-k="d1"]').focus();
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
  delete reg._new; reg.updated = new Date().toISOString(); delete reg.exported; delete reg.synced;
  if (!reg.ejendom) reg.ejendom = state.data?.name || null;
  await db.put("regs", reg);
  const i = state.regs.findIndex(r => r.id === reg.id); i >= 0 ? state.regs[i] = reg : state.regs.push(reg);
  drawRegMarkers(); restyle(); refreshMenuInfo(); scheduleSync();
}
async function deleteReg(reg) {
  if (!confirm("Slet denne registrering?")) return;
  await db.del("regs", reg.id); state.regs = state.regs.filter(r => r.id !== reg.id);
  drawRegMarkers(); restyle(); refreshMenuInfo(); backToStand(reg); scheduleSync(true);
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
/* Alle målte træer, én række pr. træ – åbner direkte i Excel. */
function buildTreeCsv() {
  const head = ["Afd", "Litra", "Prøveflade", "Dato", "Radius (m)", "Træ nr", "Træart", "D1 (cm)", "D2 (cm)", "Diameter (cm)", "Højde (m)", "Bemærkning", "Bk (%)", "Note til prøvefladen", "Bredde", "Længde", "GPS ± (m)"];
  const lines = [head.join(";")]; let rows = 0;
  const plots = state.regs.filter(r => r.type === "proeveflade").sort((a, b) => (a.stand?.label || "").localeCompare(b.stand?.label || "", "da") || a.created.localeCompare(b.created));
  const nrBy = {};
  for (const p of plots) {
    const key = p.stand?.key || "-"; nrBy[key] = (nrBy[key] || 0) + 1;
    p.data.trees.forEach((t, i) => {
      lines.push([p.stand?.afd ?? "", p.stand?.litra ?? "", nrBy[key], p.created.slice(0, 10), csvNum(p.data.radius, 2), i + 1, t.art || p.stand?.art || "",
        csvNum(num(t.d1 ?? t.d), 1), csvNum(num(t.d2), 1), csvNum(num(t.d), 1), csvNum(num(t.h), 1), t.note || "", i === 0 ? csvNum(num(p.data.bk), 0) : "", i === 0 ? (p.data.note || "") : "",
        p.lat ? p.lat.toFixed(6).replace(".", ",") : "", p.lon ? p.lon.toFixed(6).replace(".", ",") : "", p.accuracy ? Math.round(p.accuracy) : ""].map(csvCell).join(";"));
      rows++;
    });
  }
  return { csv: "\ufeff" + lines.join("\r\n") + "\r\n", rows };
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
function buildExportZip(withPhotos = true) {
  const zip = new JSZip(), stamp = today(), { csv, rows } = buildTaxCsv();
  zip.file(`taksationsark_felt_${stamp}.csv`, csv);
  zip.file("registreringer.geojson", JSON.stringify({ ...buildGeoJSON(), skovplan: { ejendom: state.data?.name || null, ...(state.data?.pakke || {}) } }, null, 1));
  const trees = buildTreeCsv(); if (trees.rows) zip.file(`enkelttraeer_${stamp}.csv`, trees.csv);
  if (withPhotos) state.regs.filter(r => r.photo).forEach(r => zip.file(photoName(r), r.photo));
  zip.file("LAES-MIG.txt", [
    `SkovPlan Felt – eksport ${new Date().toLocaleString("da-DK")}`, `Skov: ${state.data?.name || ""}`, "",
    "Hent filen ind i SkovPlan med «Hent data fra app» (Import og ældre driftsplaner).", "",
    `taksationsark_felt_${stamp}.csv: ${rows} litra (indlæses automatisk af «Hent data fra app»).`,
    "  Tomme celler betyder «behold SkovPlans tal». Hg/Dg/stamtal/grundflade er beregnet fra prøvefladerne (gennemsnit pr. litra).",
    "enkelttraeer_<dato>.csv: alle målte træer, én række pr. træ (art, diameter, højde, bemærkning). Åbner i Excel.",
    "registreringer.geojson: alle prøveflader, fotos og noter som punkter (WGS84). Kan trækkes direkte ind i QGIS.",
    "fotos/: billederne; filnavnet står i feltet «foto» i geojson-filen.",
  ].join("\r\n"));
  return { zip, rows, stamp };
}
async function doExport() {
  if (!state.regs.length) return toast("Der er intet at eksportere endnu");
  const { zip, rows, stamp } = buildExportZip(true);
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const name = `skovplan-felt_${(state.data?.name || "skov").replace(/[^\wæøåÆØÅ-]+/g, "_")}_${stamp}.zip`;
  const file = new File([blob], name, { type: "application/zip" });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  openSheet(`<div class="head"><h3>Gem eksporten</h3><button class="close">Luk</button></div>
    <p><b>${esc(name)}</b> · ${blob.size < 1048576 ? Math.max(1, Math.round(blob.size / 1024)) + " kB" : fmt(blob.size / 1048576, 1) + " MB"} · ${state.regs.length} registreringer</p>
    ${canShare ? `<p>Tryk <b>Gem på Drev</b>, vælg <b>Drev</b> og gem i mappen <b>SkovPlan Felt</b>.
      Drev husker mappen næste gang.</p>` : `<p>Filen hentes til telefonens Overførsler. Læg den i Drev-mappen <b>SkovPlan Felt</b>.</p>`}
    <p class="muted">På pc'en henter SkovPlan den selv med «Hent data fra app».</p>
    <button class="primary big" id="btnShare">${canShare ? "Gem på Drev" : "Hent filen"}</button>`);
  const download = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); };
  $("#btnShare").onclick = async () => {
    if (canShare) {
      // Nogle telefoner afviser zip-filer i del-menuen; så prøves som almindelig fil, og ellers gemmes den i Overførsler.
      let ok = false, err = null;
      for (const f of [file, new File([blob], name, { type: "application/octet-stream" })]) {
        try { await navigator.share({ files: [f] }); ok = true; break; }
        catch (e) { if (e.name === "AbortError") return; err = e; console.warn("share", e); }
      }
      if (!ok) { download(); toast("Telefonen ville ikke dele filen (" + (err?.name || "fejl") + "), så den er gemt i Overførsler. Læg den i Drev-mappen SkovPlan Felt.", 9000); }
    } else download();
    const t = new Date().toISOString();
    for (const r of state.regs) { r.exported = t; await db.put("regs", r); }
    closeSheet(); refreshMenuInfo(); toast(`Eksporteret: ${state.regs.length} registreringer, ${rows} litra i taksationsarket`, 4000);
  };
}
async function clearExported() {
  const done = state.regs.filter(r => r.exported);
  if (!done.length) return toast("Ingen eksporterede registreringer at slette");
  if (!confirm(`Slet ${done.length} registreringer, der allerede er eksporteret?`)) return;
  for (const r of done) await db.del("regs", r.id);
  state.regs = state.regs.filter(r => !r.exported); drawRegMarkers(); restyle(); refreshMenuInfo(); closeSheet();
}

/* ------------------------------------------------------------------ online synkronisering
   Har feltpakken en «sync»-blok (Supabase), sendes registreringerne automatisk, når der er net:
   først nye fotos (ét ad gangen), derefter hele eksporten uden fotos som én zip. SkovPlan henter selv. */
const syncCfg = () => state.data?.pakke?.sync?.rest && state.data.pakke.sync.noegle ? state.data.pakke.sync : null;
let syncTimer = null, syncing = false;
function scheduleSync(force) {
  if (!syncCfg()) return;
  if (force) state.syncHash = null;
  clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 2500);
}
async function rpc(fn, body) {
  const c = syncCfg();
  const res = await fetch(`${c.rest}/rpc/${fn}`, { method: "POST",
    headers: { "Content-Type": "application/json", apikey: c.anon, Authorization: "Bearer " + c.anon }, body: JSON.stringify(body) });
  if (!res.ok) { let m = ""; try { m = (await res.json()).message; } catch (e) { /* ok */ } throw new Error(m || "HTTP " + res.status); }
  return res.json();
}
const b64 = async blob => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
async function syncNow(manual) {
  const c = syncCfg();
  if (!c) { if (manual) toast("Feltpakken har ingen online-synkronisering. Lav en ny feltpakke i SkovPlan.", 5000); return; }
  if (syncing) return; if (!navigator.onLine) { if (manual) toast("Ingen forbindelse – sendes, når der er net"); return; }
  syncing = true; setSyncStatus("sender …");
  try {
    const mine = state.regs.filter(r => !r.ejendom || r.ejendom === state.data.name);
    for (const r of mine.filter(r => r.photo && !r.photoSynced)) {
      await rpc("felt_foto", { p_noegle: c.noegle, p_navn: photoName(r).split("/").pop(), p_data: await b64(r.photo) });
      r.photoSynced = new Date().toISOString(); await db.put("regs", r);
    }
    const hash = JSON.stringify(mine.map(r => [r.id, r.updated || r.created]));
    if (mine.length && (hash !== state.syncHash || manual)) {
      const all = state.regs; state.regs = mine;
      let built; try { built = buildExportZip(false); } finally { state.regs = all; }
      const zip64 = await built.zip.generateAsync({ type: "base64", compression: "DEFLATE" });
      await rpc("felt_indsend", { p_noegle: c.noegle, p_navn: `skovplan-felt_${(state.data.name || "skov").replace(/[^\wæøåÆØÅ-]+/g, "_")}_${built.stamp}.zip`, p_zip: zip64, p_antal: mine.length });
      state.syncHash = hash; safeLS("syncHash:" + c.noegle, hash);
      const t = new Date().toISOString();
      for (const r of mine) { r.synced = t; r.exported = r.exported || t; await db.put("regs", r); }
    }
    safeLS("syncAt:" + c.noegle, new Date().toISOString());
    setSyncStatus("sendt " + new Date().toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" }));
    if (manual) toast(`Sendt til SkovPlan: ${mine.length} registreringer`, 3500);
  } catch (err) {
    console.warn("sync", err); setSyncStatus("ikke sendt (" + err.message + ")");
    if (manual) toast("Kunne ikke sende: " + err.message, 6000);
  } finally { syncing = false; refreshMenuInfo(); }
}
function setSyncStatus(t) { state.syncStatus = t; refreshMenuInfo(); }
window.addEventListener("online", () => scheduleSync());

/* ------------------------------------------------------------------ handlinger */
function refreshMenuInfo() {
  const n = state.regs.length, ne = state.regs.filter(r => !r.exported).length;
  const c = syncCfg(), ns = state.regs.filter(r => !r.synced).length;
  $("#menuInfo").textContent = `${state.data ? (state.data.name + " · indlæst " + new Date(state.data.loaded).toLocaleDateString("da-DK")) : "Intet skovkort"} · ${state.ortho ? "ortofoto gemt" : "intet ortofoto"} · ${n} registreringer` +
    (c ? ` · online: ${ns ? ns + " venter" : "alt sendt"}${state.syncStatus ? " (" + state.syncStatus + ")" : ""}` : (ne ? `, ${ne} ikke eksporteret` : ""));
  $("#btnSync")?.classList.toggle("hidden", !c);
}
const ACTIONS = {
  openGpkg: () => $("#gpkgInput").click(),
  welcome: () => showWelcome(true),
  layers: layerMenu,
  sync: () => syncNow(true),
  closeWelcome: () => { if (!state.ortho) safeLS("skipOrtho", "1"); $("#empty").classList.add("hidden"); },
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
  const files = [...e.target.files]; e.target.value = ""; if (files.length) openFiles(files);
};
/* Åbn hvad som helst fra SkovPlan: en feltpakke (zip med kort + ortofoto), skovdriftsplan.gpkg eller ortofoto-mbtiles.
   Filtypen afgøres af indholdet, ikke navnet, så «skovdriftsplan (1).gpkg» fra Drev også virker. */
async function openFiles(files) {
  const items = [];
  for (const f of files) {
    try {
      const head = new Uint8Array(await f.slice(0, 16).arrayBuffer());
      if (head[0] === 0x50 && head[1] === 0x4b) {           // PK = zip
        toast("Pakker " + f.name + " ud …", 60000);
        const zip = await JSZip.loadAsync(f);
        let meta = null;
        const mj = zip.file(/feltpakke\.json$/i)[0];
        if (mj) try { meta = JSON.parse(await mj.async("string")); } catch (err) { /* ok */ }
        const fl = zip.file(/feltlag\.json$/i)[0];
        if (fl) try { meta = { ...(meta || {}), _extra: JSON.parse(await fl.async("string")) }; } catch (err) { console.warn("feltlag", err); }
        const inner = zip.file(/\.(gpkg|mbtiles)$/i);
        if (!inner.length) throw new Error(zip.file(/registreringer\.geojson$/i).length
          ? "det er en eksport fra appen. Den skal hentes ind i SkovPlan med «Hent data fra app»"
          : "zip-filen indeholder hverken skovkort eller ortofoto");
        for (const z of inner) items.push({ file: new File([await z.async("blob")], z.name.split("/").pop()), meta });
      } else if (new TextDecoder().decode(head).startsWith("SQLite format 3")) items.push({ file: f });
      else throw new Error("filen er hverken en feltpakke, et skovkort (.gpkg) eller et ortofoto (.mbtiles)");
    } catch (err) { console.error(err); toast("Kunne ikke åbne " + f.name + ": " + err.message, 7000); }
  }
  // skovkortet først, så ortofotoet kan zoome til skoven
  items.sort((a, b) => /\.mbtiles$/i.test(a.file.name) - /\.mbtiles$/i.test(b.file.name));
  for (const { file, meta } of items) {
    let g = null;
    try {
      toast("Læser " + file.name + " …", 60000);
      g = await openSqlite(file);
      if (hasTable(g, "tiles") && hasTable(g, "metadata")) await loadOrtho(g, file);
      else if (hasTable(g, "gpkg_contents")) await loadGpkg(g, file, meta);
      else throw new Error("ukendt filtype");
    } catch (err) { console.error(err); toast("Kunne ikke læse " + file.name + ": " + err.message, 7000); }
    finally { g?.close(); }
  }
  showWelcome();
}
async function loadGpkg(g, f, meta) {
  const data = readGpkg(g, f);
  if (meta) { const { _extra, ...pakke } = meta; data.pakke = pakke; if (_extra) data.extra = _extra; }
  await db.put("kv", data, "skovkort"); state.data = data; drawData(); fitData(); scheduleSync();
  toast(`Indlæst: ${data.layers.skovafdelinger.features.length} litradele`);
}
/* Læs ortofotoet (MBTiles fra SkovPlan) og læg fliserne i telefonens lager, så det virker uden net. */
async function loadOrtho(g, f) {
  {
    const meta = {};
    (g.exec("SELECT name, value FROM metadata")[0]?.values || []).forEach(([k, v]) => meta[k] = v);
    const total = g.exec("SELECT count(*) FROM tiles")[0].values[0][0];
    if (!total) throw new Error("filen har ingen fliser");
    await db.clear("tiles");
    const st = g.prepare("SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles");
    const type = /png/i.test(meta.format || "") ? "image/png" : "image/jpeg";
    let batch = [], done = 0, minz = 99, maxz = 0;
    while (st.step()) {
      const [z, x, row, data] = st.get();
      minz = Math.min(minz, z); maxz = Math.max(maxz, z);
      batch.push([`${z}/${x}/${(1 << z) - 1 - row}`, new Blob([data], { type })]);
      if (batch.length >= 300) { await db.putMany("tiles", batch); done += batch.length; batch = []; toast(`Gemmer ortofoto … ${Math.round(done / total * 100)} %`, 60000); }
    }
    st.free(); if (batch.length) await db.putMany("tiles", batch);
    state.ortho = { name: f.name, minzoom: minz, maxzoom: maxz, attribution: meta.attribution || "Ortofoto",
      bounds: meta.bounds ? meta.bounds.split(",").map(Number) : null, loaded: new Date().toISOString(), tiles: total };
    await db.put("kv", state.ortho, "ortofoto");
    setBasemap(0); restyle();
    if (!state.data && state.ortho.bounds) { const b = state.ortho.bounds; map.fitBounds([[b[1], b[0]], [b[3], b[2]]]); }
    toast(`Ortofoto gemt (${total} fliser) – virker uden net`, 4000);
  }
}
/* Velkomstkortet viser, hvad der mangler: skovkort og/eller ortofoto. */
function showWelcome(force) {
  const hasMap = !!state.data, hasOrtho = !!state.ortho;
  $("#stMap").className = hasMap ? "ok" : ""; $("#stMap").textContent = hasMap ? "Skovkort: " + state.data.name : "Skovkort mangler";
  $("#stOrtho").className = hasOrtho ? "ok" : ""; $("#stOrtho").textContent = hasOrtho ? "Ortofoto gemt" : "Ortofoto mangler";
  $("#welcomeClose").classList.toggle("hidden", !hasMap);
  $("#empty").classList.toggle("hidden", !force && hasMap && hasOrtho || !force && hasMap && safeLS("skipOrtho") === "1");
}
function fitData() { try { map.fitBounds(L.geoJSON(state.data.layers.skovafdelinger).getBounds(), { padding: [20, 20] }); } catch (e) { /* tom */ } }

/* ------------------------------------------------------------------ start */
(async function start() {
  try { await navigator.storage?.persist?.(); } catch (e) { /* ok */ }
  try {
    state.data = await db.get("kv", "skovkort");
    state.ortho = await db.get("kv", "ortofoto");
    state.regs = await db.all("regs");
  } catch (e) { console.error(e); toast("Telefonens lager kunne ikke åbnes: " + e.message, 6000); }
  const saved = safeLS("basemap"); setBasemap(saved === null ? 0 : +saved % BASEMAPS.length);
  if (state.data) { drawData(); fitData(); }
  showWelcome();
  drawRegMarkers(); startGps();
  if (syncCfg()) { state.syncHash = safeLS("syncHash:" + syncCfg().noegle); scheduleSync(); }
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW", e));
})();
