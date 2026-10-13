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
  delPrefix(store, prefix) { return this.tx(store, "readwrite", s => { s.delete(IDBKeyRange.bound(prefix, prefix + "\uffff")); }); },
  keys(store) { return this.tx(store, "readonly", s => this.req(s.getAllKeys())); },
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
const state = { data: null, regs: [], allRegs: [], selected: null, me: null, standLayer: null, overlays: [], basemap: 0 };
const map = L.map("map", { zoomControl: false, attributionControl: true, maxZoom: 21 }).setView([56.0, 9.5], 7);
L.control.zoom({ position: "bottomright" }).addTo(map);
/* Ortofoto fra SkovPlan (MBTiles, gemt i telefonens IndexedDB) */
/* Fliserne tegnes på et lærred, så kanten af ortofotoet (sort i JPEG-fliser) males grå uden for fotoets udstrækning. */
const OrthoLayer = L.GridLayer.extend({
  createTile(c, done) {
    const cv = document.createElement("canvas"); cv.width = cv.height = 256;
    db.get("tiles", `${this.options.prefix || ""}${c.z}/${c.x}/${c.y}`).then(b => {
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
  return new OrthoLayer({ prefix: m.prefix || "", minZoom: 0, maxZoom: 21, minNativeZoom: m.minzoom, maxNativeZoom: m.maxzoom, attribution: m.attribution || "Ortofoto",
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
  if (!state.data) { state.standLayer = null; return; }
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
    const km = kmFromForest(lat, lon);
    if (follow && km <= 1) map.setView([lat, lon], Math.max(map.getZoom(), 16));
    const st = standAt(lon, lat);
    $("#where").textContent = km > 1 ? `${state.data?.name || ""} · du er ${fmt(km, km < 10 ? 1 : 0)} km væk`
      : (st ? `Du står i ${standLabel(st.properties)} · ` : "") + `±${Math.round(accuracy)} m`;
    trackPoint(lat, lon, accuracy, pos.timestamp); updateNav();
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
/* Afstand (km) fra et punkt til skovens ramme; 0 inde i skoven. */
function kmFromForest(lat, lon) {
  if (!state.data) return 0;
  let b; try { b = L.geoJSON(state.data.layers.skovafdelinger).getBounds(); } catch (e) { return 0; }
  if (!b.isValid()) return 0;
  const near = L.latLng(Math.min(Math.max(lat, b.getSouth()), b.getNorth()), Math.min(Math.max(lon, b.getWest()), b.getEast()));
  return map.distance(L.latLng(lat, lon), near) / 1000;
}
$("#btnLocate").onclick = () => {
  if (!state.me) return toast("Venter på GPS …");
  const km = kmFromForest(state.me.lat, state.me.lon);
  if (km > 1) { follow = false; fitData(); return toast(`Du er ca. ${fmt(km, km < 10 ? 1 : 0)} km fra ${state.data?.name || "skoven"}, så kortet viser skoven.`, 5000); }
  follow = true; map.setView([state.me.lat, state.me.lon], Math.max(map.getZoom(), 16));
  const st = standAt(state.me.lon, state.me.lat); if (st) selectStand(st);
};
/* Knap: vis hele skoven */
L.Control.Fit = L.Control.extend({ options: { position: "bottomright" }, onAdd() {
  const b = L.DomUtil.create("button", "fit-btn"); b.type = "button"; b.title = "Vis hele skoven"; b.setAttribute("aria-label", "Vis hele skoven"); b.textContent = "⤢";
  L.DomEvent.on(b, "click", e => { L.DomEvent.stop(e); follow = false; fitData(); }); return b; } });
new L.Control.Fit().addTo(map);
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
    <button class="big" data-act="goStand">➜ Gå til ${esc(standLabel(p))}</button>
    ${s.plots || s.Hg != null || s.Dg != null ? `<div class="result"><b>Feltdata ${YEAR}:</b> ${[s.plots ? `${s.plots} prøveflade${s.plots === 1 ? "" : "r"}` : "",
      s.Hg != null ? `Hg ${fmt(s.Hg)} m` : "", s.Dg != null ? `Dg ${fmt(s.Dg)} cm` : "", s.N ? `${fmt(s.N, 0)} stk/ha` : "",
      s.G ? `G ${fmt(s.G)} m²/ha` : "", s.Bk != null ? `Bk ${fmt(s.Bk, 0)} %` : ""].filter(Boolean).join(" · ")}</div>` : ""}
    <ul class="list">${regs.filter(r => !r.data.parent).map(regItem).join("")}</ul>`);
  hydrateThumbs();
}

function regItem(r) {
  const when = new Date(r.created).toLocaleString("da-DK", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  let txt = "";
  if (r.type === "proeveflade") { const s = plotStats(r.data); txt = `Prøveflade r=${fmt(r.data.radius, 2)} m · ${s.n} træer · Dg ${fmt(s.Dg)} · ${fmt(s.N, 0)} stk/ha`; }
  else if (r.type === "foto") txt = "Foto" + (r.data.note ? ": " + esc(r.data.note) : "");
  else if (r.type === "note") { const n = childPhotos(r).length; txt = (r.data.general ? "<b>Generel note</b>" + (r.data.note ? ": " : "") : "") + esc(r.data.note) + (n ? ` · 📷 ${n}` : ""); }
  else if (r.type === "taksation") txt = `Taksation: Hg ${fmt(num(r.data.hg))} · Dg ${fmt(num(r.data.dg))} · ${fmt(num(r.data.n), 0)} stk/ha`;
  else if (r.type === "stak" || r.type === "stok") txt = pileText(r) + (r.data.note ? ": " + esc(r.data.note) : "");
  else if (r.type === "spor") txt = `Rute ${fmtLen(r.data.length_m)} · ${Math.round(r.data.minutes || 0)} min` + (r.data.note ? ": " + esc(r.data.note) : "");
  const thumb = r.type === "foto" ? r.id : r.type === "note" ? childPhotos(r)[0]?.id : null;
  return `<li data-id="${r.id}">${thumb ? `<img data-thumb="${thumb}" alt="">` : ""}
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
      ${!reg._new && reg.lat ? '<button id="goReg">➜ Gå hertil</button>' : ""}
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
  if ($("#goReg")) $("#goReg").onclick = () => { closeSheet(); goTo(reg.lat, reg.lon, "Prøveflade " + (reg.stand?.label || "")); };
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
    <label>Ny træart (kun hvis den er forkert)</label><select id="tArt"><option value="">Uændret (${esc(reg.stand.art || "–")})</option>
      ${speciesOptions(d.art).map(a => `<option${a === d.art ? " selected" : ""}>${esc(a)}</option>`).join("")}</select>
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

/* -------- note / foto
   En note kan have flere billeder. Hvert billede gemmes som sin egen «foto»-registrering med data.parent = notens id,
   så SkovPlan, synk og eksport behandler dem som før. En generel note hører ikke til et litra (stand = null). */
const childPhotos = reg => state.regs.filter(r => r.type === "foto" && r.data.parent === reg.id);
function noteForm(reg) {
  if (reg.type === "foto" && reg.data.parent) { const p = state.regs.find(r => r.id === reg.data.parent); if (p) return editReg(p.id); }
  const isNote = reg.type === "note";
  reg._add = reg._add || []; reg._drop = reg._drop || [];
  const title = reg.type === "foto" ? "Foto" : reg.data.general ? "Generel note" : "Note";
  openSheet(`
    <div class="head"><h3>${title}${reg.data.general ? "" : " · " + esc(reg.stand?.label || "uden litra")}</h3><button data-act="cancelForm" class="close">Annullér</button></div>
    ${reg.photo ? `<img id="nImg" style="width:100%;border-radius:10px;margin:6px 0" alt="">` : ""}
    <label>${reg.type === "foto" ? "Tekst til billedet" : "Note"}</label><textarea id="nNote">${esc(reg.data.note || "")}</textarea>
    ${isNote ? `<div id="nPhotos" class="thumbs"></div>
    <div class="actions"><button id="nCam">📷 Tag billede</button><button id="nGal">🖼 Vælg billeder</button></div>` : ""}
    <div class="stack"><button class="primary big" id="nSave">Gem</button>${reg._new ? "" : '<button class="danger" id="nDel">Slet</button>'}
    ${!reg._new && reg.lat ? '<button id="goReg">➜ Gå hertil</button>' : ""}</div>`);
  if (reg.photo) $("#nImg").src = URL.createObjectURL(reg.photo);
  if (isNote) {
    state.noteDraft = reg;
    const draw = () => {
      const kept = childPhotos(reg).filter(c => !reg._drop.includes(c.id)).map(c => ({ id: c.id, blob: c.photo }));
      const all = [...kept, ...reg._add];
      $("#nPhotos").innerHTML = all.map(x => `<span class="thumb"><img data-ph="${x.id}" alt=""><button data-rm="${x.id}" aria-label="Fjern">×</button></span>`).join("");
      all.forEach(x => { const img = $("#nPhotos").querySelector(`img[data-ph="${x.id}"]`); if (img && x.blob) img.src = URL.createObjectURL(x.blob); });
      $("#nPhotos").querySelectorAll("button[data-rm]").forEach(b => b.onclick = ev => {
        ev.preventDefault(); ev.stopPropagation(); const id = b.dataset.rm;
        if (reg._add.some(x => x.id === id)) reg._add = reg._add.filter(x => x.id !== id); else reg._drop.push(id);
        draw();
      });
    };
    reg._draw = draw; draw();
    $("#nCam").onclick = () => $("#photoInput").click();
    $("#nGal").onclick = () => $("#galleryInput").click();
  }
  $("#nSave").onclick = async () => {
    reg.data.note = $("#nNote").value.trim();
    const photos = isNote ? childPhotos(reg).filter(c => !reg._drop.includes(c.id)).length + reg._add.length : 0;
    if (isNote && !reg.data.note && !photos) return toast("Skriv en note eller tilføj et billede");
    const add = reg._add || [], drop = reg._drop || [];
    for (const k of ["_add", "_drop", "_draw"]) delete reg[k];
    state.noteDraft = null;
    await saveReg(reg);
    if (isNote) {
      for (const id of drop) { await db.del("regs", id); dropRegs(r => r.id === id); }
      for (const c of childPhotos(reg)) if (c.data.note !== reg.data.note) { c.data.note = reg.data.note; await saveReg(c); }
      for (const x of add) await saveReg({ id: x.id, type: "foto", created: x.created, lat: reg.lat, lon: reg.lon, accuracy: reg.accuracy,
        stand: reg.stand, data: { note: reg.data.note, parent: reg.id, general: !!reg.data.general }, photo: x.blob });
      if (drop.length) { drawRegMarkers(); refreshMenuInfo(); scheduleSync(true); }
    }
    toast("Gemt"); backToStand(reg);
  };
  if ($("#nDel")) $("#nDel").onclick = () => deleteReg(reg);
  if ($("#goReg")) $("#goReg").onclick = () => { closeSheet(); goTo(reg.lat, reg.lon, (reg.data.general ? "Generel note" : reg.type === "foto" ? "Foto" : "Note") + (reg.stand ? " · " + reg.stand.label : "")); };
}
async function takePhoto(file) {
  const blob = await shrinkImage(file, 1600, 0.82);
  const draft = state.noteDraft;
  if (draft && $("#nPhotos")) { draft._add.push({ id: uid(), blob, created: new Date().toISOString() }); return draft._draw(); }
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
function newReg(type, general = false) {
  const stand = general ? null : currentStand();
  const base = { id: uid(), _new: true, type, created: new Date().toISOString(), ...pos(), stand };
  if (type === "proeveflade") return plotForm({ ...base, data: { radius: 10, trees: [], hg: null, bk: null, note: "" } });
  if (type === "taksation") return stand ? taxForm({ ...base, data: {} }) : toast("Vælg et litra først");
  if (type === "note") return noteForm({ ...base, data: general ? { note: "", general: true } : { note: "" } });
}
/* state.allRegs: alle registreringer på telefonen; state.regs: kun den aktive ejendoms. */
function dropRegs(pred) { state.regs = state.regs.filter(r => !pred(r)); state.allRegs = state.allRegs.filter(r => !pred(r)); }
const regsFor = d => state.allRegs.filter(r => !r.ejendom || !d || r.ejendom === d.name);
async function saveReg(reg) {
  delete reg._new; reg.updated = new Date().toISOString(); delete reg.exported; delete reg.synced;
  if (!reg.ejendom) reg.ejendom = state.data?.name || null;
  await db.put("regs", reg);
  for (const list of [state.regs, state.allRegs]) { const i = list.findIndex(r => r.id === reg.id); i >= 0 ? list[i] = reg : list.push(reg); }
  drawRegMarkers(); restyle(); refreshMenuInfo(); scheduleSync();
}
async function deleteReg(reg) {
  if (!confirm("Slet denne registrering?")) return;
  const gone = new Set([reg.id, ...childPhotos(reg).map(c => c.id)]);
  for (const id of gone) await db.del("regs", id);
  dropRegs(r => gone.has(r.id)); state.noteDraft = null;
  drawRegMarkers(); restyle(); refreshMenuInfo(); backToStand(reg); scheduleSync(true);
}
function backToStand(reg) {
  state.noteDraft = null;
  const f = reg.stand && state.data?.layers.skovafdelinger.features.find(x => standKey(x.properties) === reg.stand.key);
  f ? selectStand(f) : listAll();
}
let regLayer = null;
function drawRegMarkers() {
  if (regLayer) map.removeLayer(regLayer);
  regLayer = L.layerGroup(state.regs.filter(r => r.lat).map(r => r.type === "spor"
    ? L.polyline(r.data.points.map(p => [p[0], p[1]]), { color: "#e8710a", weight: 3, opacity: 0.8, dashArray: "1 6", lineCap: "round" }).on("click", () => editReg(r.id))
    : L.circleMarker([r.lat, r.lon], {
    radius: r.type === "proeveflade" ? 7 : 5, color: "#fff", weight: 2, fillOpacity: 1,
    fillColor: { proeveflade: "#7a1fa2", foto: "#e8710a", note: "#1a73e8", taksation: "#0b8043", stak: "#8d5524", stok: "#5d4037" }[r.type],
  }).on("click", () => editReg(r.id)))).addTo(map);
}
function editReg(id) {
  const r = state.regs.find(x => x.id === id); if (!r) return;
  const copy = { ...r, data: JSON.parse(JSON.stringify(r.data)) };
  ({ proeveflade: plotForm, taksation: taxForm, foto: noteForm, note: noteForm, spor: trackForm, stak: stakForm, stok: stokForm })[r.type](copy);
}
function listAll() {
  state.selected = null; restyle();
  const regs = state.regs.filter(r => !r.data.parent).sort((a, b) => b.created.localeCompare(a.created));
  openSheet(`<div class="head"><h3>Alle registreringer (${regs.length})</h3><button class="close">Luk</button></div>
    <div class="actions"><button class="primary" data-act="newPlot">+ Prøveflade</button><button data-act="photo">📷 Foto</button><button data-act="note">✎ Note</button></div>
    <button class="big" data-act="generalNote">✎ Generel note (ikke knyttet til et litra)</button>
    <button class="big" data-act="pileList">Stakke og stokke (opmåling)</button>
    ${regs.length ? `<ul class="list">${regs.map(regItem).join("")}</ul>` : '<p class="muted">Ingen registreringer endnu. Tryk på et litra på kortet for at begynde.</p>'}
    <button class="primary big" data-act="export">Eksportér til SkovPlan</button>`);
  hydrateThumbs();
}

/* ------------------------------------------------------------------ stakke og stokke
   Stak: længde × dybde × højde = rummeter; × fastmasse-% = m³ fast; flis: × omregningsfaktor = m³ løs flis.
   Stok: stokke målt med længde og midtdiameter (Hubers formel: π/4 · d² · L), evt. flere ens stokke pr. linje.
   Flere mål i ét felt (fx højden målt tre steder: «2,1 2,4 2,2») giver gennemsnittet. */
const STAK_TYPES = { flis: "Flis", braende: "Brænde", rundtrae: "Rundtræ" };
const FASTMASSE = [["Grot / toppe", 20], ["Heltræ, små træer", 35], ["Energitræ, rundtræ", 55], ["Rundtræ stablet", 65], ["Brænde stablet", 65], ["Brænde løst kastet", 45]];
const SORTIMENTER = ["Skovflis", "Heltræ", "Grot", "Energitræ", "Brænde", "Industritræ", "Gavntræ", "Kævler", "Savtømmer", "Pæle"];
const avgNum = v => { const xs = String(v ?? "").trim().split(/[\s;+\/]+/).map(num).filter(x => x !== null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
function stakCalc(d) {
  const L = avgNum(d.l), D = avgNum(d.d), H = avgNum(d.h), pct = num(d.pct), k = num(d.faktor);
  const rm = L && D && H ? L * D * H : null, fast = rm !== null && pct ? rm * pct / 100 : null;
  return { L, D, H, rm, fast, flis: d.type === "flis" && fast !== null && k ? fast * k : null };
}
const stokVol = t => { const L = num(t.l), dcm = num(t.d), n = num(t.n) ?? 1; return L && dcm ? Math.PI / 4 * (dcm / 100) ** 2 * L * n : 0; };
function stokCalc(d) { const rows = (d.stokke || []).filter(t => num(t.l) && num(t.d)); return { n: rows.reduce((a, t) => a + (num(t.n) ?? 1), 0), m3: rows.reduce((a, t) => a + stokVol(t), 0) }; }
const pileM3 = r => r.type === "stak" ? stakCalc(r.data).fast : r.type === "stok" ? stokCalc(r.data).m3 : null;
function nextPileNr() {
  const nrs = state.allRegs.filter(r => r.type === "stak" || r.type === "stok").map(r => parseInt(r.data.nr, 10)).filter(Number.isFinite);
  return String(Math.max(nrs.length ? Math.max(...nrs) : 0, parseInt(safeLS("sidsteStakNr") || "0", 10) || 0) + 1);
}
function pileText(r) {
  const d = r.data, what = r.type === "stak" ? "Stak" : "Stok";
  const m3 = pileM3(r), extra = r.type === "stak" ? stakCalc(d) : stokCalc(d);
  return `<b>${what} ${esc(d.nr || "")}</b> · ${m3 ? fmt(m3, 1) + " m³" : "ikke målt"}` +
    (r.type === "stak" && extra.flis ? ` · ${fmt(extra.flis, 1)} m³ flis` : "") + (r.type === "stok" && extra.n ? ` · ${fmt(extra.n, 0)} stk` : "") +
    [d.sortiment, d.art].filter(Boolean).map(x => " · " + esc(x)).join("");
}
function pileBase(reg, extra = "") {
  const d = reg.data, inp = (id, lbl, v, list) => `<label>${lbl}</label><input id="${id}" value="${esc(v ?? "")}"${list ? ` list="${list}"` : ""} autocomplete="off">`;
  const known = k => [...new Set(state.allRegs.filter(r => r.data?.[k]).map(r => r.data[k]))];
  return `
    <div class="row"><div><label>Nr.</label><input id="pNr" inputmode="numeric" value="${esc(d.nr ?? "")}"></div>
      <div><label>&nbsp;</label><button id="pNext" type="button">Næste nr.</button></div></div>
    <div class="row"><div><label>Træart</label><select id="pArt"><option value="">–</option>
      ${["Blandet", ...speciesOptions(d.art)].map(a => `<option${a === d.art ? " selected" : ""}>${esc(a)}</option>`).join("")}</select></div>
      <div>${inp("pSort", "Sortiment", d.sortiment, "dlSort")}</div></div>
    ${extra}
    <datalist id="dlSort">${[...new Set([...SORTIMENTER, ...known("sortiment")])].map(s => `<option value="${esc(s)}">`).join("")}</datalist>
    ${inp("pKunde", "Kunde (køber)", d.kunde, "dlKunde")}<datalist id="dlKunde">${known("kunde").map(s => `<option value="${esc(s)}">`).join("")}</datalist>
    ${inp("pOrdre", "Ordre", d.ordre, "dlOrdre")}<datalist id="dlOrdre">${known("ordre").map(s => `<option value="${esc(s)}">`).join("")}</datalist>
    ${inp("pHugst", "Hugstopgave", d.hugst, "dlHugst")}<datalist id="dlHugst">${known("hugst").map(s => `<option value="${esc(s)}">`).join("")}</datalist>
    ${inp("pAfd", "Afdeling", d.afdeling ?? reg.stand?.label ?? "")}
    ${inp("pSkover", "Skover", d.skover, "dlSkover")}<datalist id="dlSkover">${known("skover").map(s => `<option value="${esc(s)}">`).join("")}</datalist>
    ${inp("pUdk", "Udkører", d.udkoerer, "dlUdk")}<datalist id="dlUdk">${known("udkoerer").map(s => `<option value="${esc(s)}">`).join("")}</datalist>
    <label>Bemærkning</label><textarea id="pNote">${esc(d.note || "")}</textarea>`;
}
function readPileBase(reg) {
  Object.assign(reg.data, { nr: $("#pNr").value.trim(), art: $("#pArt").value, sortiment: $("#pSort").value.trim(), kunde: $("#pKunde").value.trim(),
    ordre: $("#pOrdre").value.trim(), hugst: $("#pHugst").value.trim(), afdeling: $("#pAfd").value.trim(), skover: $("#pSkover").value.trim(),
    udkoerer: $("#pUdk").value.trim(), note: $("#pNote").value.trim() });
}
function pileFooter(reg) {
  return `<div class="stack"><button class="primary big" id="pSave">Gem</button>
    ${reg._new ? "" : '<button class="danger" id="pDel">Slet</button>'}${!reg._new && reg.lat ? '<button id="goReg">➜ Gå hertil</button>' : ""}</div>`;
}
function wirePile(reg, read) {
  $("#pNext").onclick = () => { $("#pNr").value = nextPileNr(); };
  $("#pSave").onclick = async () => {
    readPileBase(reg); read();
    if (!reg.data.nr) return toast("Skriv et nummer (eller tryk «Næste nr.»)");
    if (!reg.lat && state.me) Object.assign(reg, pos());
    if (parseInt(reg.data.nr, 10)) safeLS("sidsteStakNr", String(Math.max(parseInt(reg.data.nr, 10), parseInt(safeLS("sidsteStakNr") || "0", 10) || 0)));
    await saveReg(reg); toast((reg.type === "stak" ? "Stak " : "Stok ") + reg.data.nr + " er gemt"); pileList();
  };
  if ($("#pDel")) $("#pDel").onclick = async () => { await deleteReg(reg); pileList(); };
  if ($("#goReg")) $("#goReg").onclick = () => { closeSheet(); goTo(reg.lat, reg.lon, (reg.type === "stak" ? "Stak " : "Stok ") + reg.data.nr); };
}
function stakForm(reg) {
  const d = reg.data, f = (id, lbl, v) => `<div><label>${lbl}</label><input id="${id}" inputmode="decimal" value="${esc(typeof v === "number" ? String(v).replace(".", ",") : v ?? "")}"></div>`;
  openSheet(`
    <div class="head"><h3>${reg._new ? "Ny stak" : "Stak " + esc(d.nr)}${reg.stand ? " · " + esc(reg.stand.label) : ""}</h3><button data-act="pileList" class="close">Fortryd</button></div>
    <h4>Grunddata</h4>${pileBase(reg, `<label>Type</label>
    <div class="seg" id="sType">${Object.entries(STAK_TYPES).map(([k, v]) => `<button type="button" data-t="${k}" class="${d.type === k ? "on" : ""}">${v}</button>`).join("")}</div>`)}
    <h4>Målinger</h4>
    <div class="row3">${f("sL", "Længde (m)", d.l)}${f("sD", "Dybde (m)", d.d)}${f("sH", "Højde (m)", d.h)}</div>
    <p class="muted small">Målt flere steder? Skriv målene med mellemrum, fx «2,1 2,4 2,2», så bruges gennemsnittet.</p>
    <div class="row"><div><label>Fastmasse</label><select id="sPre">${FASTMASSE.map(([n, p]) => `<option value="${p}">${n} (${p} %)</option>`).join("")}<option value="">Egen</option></select></div>
      ${f("sPct", "Fastmasse (%)", d.pct)}</div>
    <div class="row"><div><label>Rummeter</label><input id="sRm" readonly tabindex="-1"></div><div><label>Volumen (m³ fast)</label><input id="sVol" readonly tabindex="-1"></div></div>
    <div class="row">${f("sK", "Konverteringsfaktor (flis)", d.faktor)}<div><label>Flis rummeter</label><input id="sFlis" readonly tabindex="-1"></div></div>
    <p class="muted small" id="sRes"></p>
    ${pileFooter(reg)}`, true);
  const pre = $("#sPre"), match = FASTMASSE.find(([n, p]) => n === d.preset) || FASTMASSE.find(([, p]) => p === num(d.pct));
  pre.selectedIndex = match ? FASTMASSE.indexOf(match) : FASTMASSE.length;
  const read = () => Object.assign(d, { l: $("#sL").value.trim(), d: $("#sD").value.trim(), h: $("#sH").value.trim(), pct: num($("#sPct").value),
    faktor: num($("#sK").value), preset: pre.value ? FASTMASSE[pre.selectedIndex][0] : "" });
  const show = () => {
    read(); const c = stakCalc(d);
    $("#sRm").value = c.rm === null ? "" : fmt(c.rm, 2); $("#sVol").value = c.fast === null ? "" : fmt(c.fast, 2);
    $("#sFlis").value = c.flis === null ? (d.type === "flis" ? "" : "– (kun flis)") : fmt(c.flis, 2);
    $("#sRes").textContent = c.rm === null ? "Udfyld længde, dybde og højde; resten regnes ud." :
      ([c.L, c.D, c.H].some((x, i) => x !== null && String([d.l, d.d, d.h][i]).trim().split(/[\s;+\/]+/).length > 1) ? `Gennemsnit: ${fmt(c.L, 2)} × ${fmt(c.D, 2)} × ${fmt(c.H, 2)} m` : "");
  };
  pre.onchange = () => { if (pre.value) $("#sPct").value = pre.value; show(); };
  $("#sType").onclick = e => { const b = e.target.closest("[data-t]"); if (!b) return; d.type = b.dataset.t;
    $("#sType").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    const want = { flis: 0, braende: 4, rundtrae: 3 }[d.type];
    if (pre.value && reg._new) { pre.selectedIndex = want; $("#sPct").value = FASTMASSE[want][1]; }
    show(); };
  for (const id of ["sL", "sD", "sH", "sPct", "sK"]) $("#" + id).oninput = show;
  $("#sPct").addEventListener("input", () => { if (num($("#sPct").value) !== num(pre.value)) pre.selectedIndex = FASTMASSE.length; });
  show(); wirePile(reg, read);
}
function stokForm(reg) {
  const d = reg.data; d.stokke = d.stokke?.length ? d.stokke : [{ n: 1, l: "", d: "" }];
  openSheet(`
    <div class="head"><h3>${reg._new ? "Ny stok" : "Stok " + esc(d.nr)}${reg.stand ? " · " + esc(reg.stand.label) : ""}</h3><button data-act="pileList" class="close">Fortryd</button></div>
    <h4>Grunddata</h4>${pileBase(reg)}
    <h4>Målinger</h4>
    <p class="muted small">Længde og diameter på midten af stokken. Ens stokke kan stå på samme linje med et antal.</p>
    <table class="stokke"><thead><tr><th>#</th><th>Antal</th><th>Længde m</th><th>Midtdiam. cm</th><th>m³</th><th></th></tr></thead><tbody id="kRows"></tbody></table>
    <button id="kAdd" type="button">+ Stok</button>
    <div class="result" id="kRes"></div>
    ${pileFooter(reg)}`, true);
  const draw = (focus) => {
    $("#kRows").innerHTML = d.stokke.map((t, i) => `<tr><td>${i + 1}</td>
      <td><input data-i="${i}" data-k="n" inputmode="numeric" value="${esc(t.n ?? 1)}"></td>
      <td><input data-i="${i}" data-k="l" inputmode="decimal" value="${esc(t.l ?? "")}"></td>
      <td><input data-i="${i}" data-k="d" inputmode="decimal" value="${esc(t.d ?? "")}"></td>
      <td class="v" id="kV${i}"></td><td><button type="button" data-rm="${i}" aria-label="Fjern">×</button></td></tr>`).join("");
    sum(); if (focus !== undefined) $(`#kRows input[data-i="${focus}"][data-k="l"]`)?.focus();
  };
  const sum = () => {
    d.stokke.forEach((t, i) => { const v = stokVol(t); $("#kV" + i).textContent = v ? fmt(v, 2) : ""; });
    const c = stokCalc(d); $("#kRes").innerHTML = c.n ? `<b>${fmt(c.n, 0)} stokke · ${fmt(c.m3, 2)} m³</b>` : "Udfyld længde og diameter.";
  };
  $("#kRows").oninput = e => { const x = e.target; if (x.dataset.k) { d.stokke[+x.dataset.i][x.dataset.k] = x.value.trim(); sum(); } };
  $("#kRows").onclick = e => { const b = e.target.closest("[data-rm]"); if (!b) return; d.stokke.splice(+b.dataset.rm, 1); if (!d.stokke.length) d.stokke.push({ n: 1, l: "", d: "" }); draw(); };
  $("#kAdd").onclick = () => { const last = d.stokke[d.stokke.length - 1] || {}; d.stokke.push({ n: 1, l: last.l || "", d: "" }); draw(d.stokke.length - 1); };
  draw();
  wirePile(reg, () => { d.stokke = d.stokke.filter(t => num(t.l) || num(t.d)); });
}
function newPile(type) {
  const base = { id: uid(), _new: true, type, created: new Date().toISOString(), ...pos(), stand: currentStand() };
  const last = state.allRegs.filter(r => r.type === type).sort((a, b) => b.created.localeCompare(a.created))[0]?.data || {};
  const keep = { art: last.art || "", sortiment: last.sortiment || "", kunde: last.kunde || "", ordre: last.ordre || "", hugst: last.hugst || "", skover: last.skover || "", udkoerer: last.udkoerer || "" };
  if (type === "stak") return stakForm({ ...base, data: { nr: nextPileNr(), type: last.type || "flis", pct: last.pct ?? 20, preset: last.preset ?? FASTMASSE[0][0], faktor: last.faktor ?? 2.8, ...keep } });
  stokForm({ ...base, data: { nr: nextPileNr(), stokke: [], ...keep } });
}
function pileList(q) {
  state.selected = null; restyle();
  q = q ?? state.pileQuery ?? ""; state.pileQuery = q;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const all = state.regs.filter(r => r.type === "stak" || r.type === "stok").sort((a, b) => b.created.localeCompare(a.created));
  const hay = r => [r.type, r.data.nr, r.data.art, r.data.sortiment, r.data.kunde, r.data.ordre, r.data.hugst, r.data.udkoerer, r.data.skover, r.data.afdeling, r.data.note, r.stand?.label,
    STAK_TYPES[r.data.type], r.created.slice(0, 10)].filter(Boolean).join(" ").toLowerCase();
  const shown = all.filter(r => words.every(w => hay(r).includes(w)));
  const total = shown.reduce((a, r) => a + (pileM3(r) || 0), 0), flis = shown.reduce((a, r) => a + (r.type === "stak" ? stakCalc(r.data).flis || 0 : 0), 0);
  openSheet(`<div class="head"><h3>Stakke og stokke</h3><button class="close">Luk</button></div>
    <div class="actions"><button class="primary" data-act="newStak">+ Stak</button><button class="primary" data-act="newStok">+ Stok</button></div>
    <div class="search"><input id="pQ" type="search" placeholder="Søg: nr., art, sortiment, køber, hugst …" value="${esc(q)}"><button id="pClr" type="button">Ryd</button></div>
    ${all.length ? `<p class="muted">${shown.length} af ${all.length} · ${fmt(total, 1)} m³${flis ? ` · ${fmt(flis, 1)} m³ flis` : ""}</p>
      <ul class="list">${shown.map(regItem).join("")}</ul>` : '<p class="muted">Ingen stakke eller stokke endnu.</p>'}`, true);
  const qi = $("#pQ");
  qi.oninput = () => { clearTimeout(pileList.t); pileList.t = setTimeout(() => { const p = qi.selectionStart; pileList(qi.value); const n = $("#pQ"); n.focus(); n.setSelectionRange(p, p); }, 250); };
  $("#pClr").onclick = () => pileList("");
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
    // Noter og fotos går ikke i litraets bemærkning; SkovPlan viser dem for sig under «Fra felten».
    const hasMeasure = ["Hg", "Dg", "N", "G", "V", "Bk"].some(k => s[k] !== undefined && s[k] !== null) || s.art;
    if (!hasMeasure) continue;
    lines.push([st.afd, st.litra, csvNum(standArea(key) || st.areal, 2), st.art, "", hasMeasure ? YEAR : "",
      csvNum(s.Hg, 1), csvNum(s.Dg, 1), csvNum(s.N, 0), csvNum(s.G, 1), csvNum(s.V, 0), csvNum(s.Bk, 0), "", s.art || "", ""].map(csvCell).join(";"));
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
/* Stakke og stokke, én række pr. stak/stok – åbner direkte i Excel. */
function buildPileCsv() {
  const head = ["Hvad", "Nr", "Dato", "Type", "Træart", "Sortiment", "Kunde", "Ordre", "Hugstopgave", "Afdeling", "Skover", "Udkører", "Afd", "Litra", "Længde (m)", "Dybde (m)", "Højde (m)",
    "Rummeter", "Fastmasse (%)", "m³ fast", "Flis-faktor", "m³ flis", "Antal stokke", "Bemærkning", "Bredde", "Længde"];
  const lines = [head.join(";")];
  const piles = state.regs.filter(r => r.type === "stak" || r.type === "stok").sort((a, b) => (parseInt(a.data.nr, 10) || 0) - (parseInt(b.data.nr, 10) || 0));
  for (const r of piles) {
    const d = r.data, c = r.type === "stak" ? stakCalc(d) : {}, k = r.type === "stok" ? stokCalc(d) : {};
    lines.push([r.type === "stak" ? "Stak" : "Stok", d.nr, r.created.slice(0, 10), r.type === "stak" ? STAK_TYPES[d.type] || "" : "", d.art, d.sortiment, d.kunde, d.ordre, d.hugst, d.afdeling ?? r.stand?.label ?? "", d.skover, d.udkoerer,
      r.stand?.afd ?? "", r.stand?.litra ?? "", csvNum(c.L, 2), csvNum(c.D, 2), csvNum(c.H, 2), csvNum(c.rm, 2), r.type === "stak" ? csvNum(num(d.pct), 0) : "",
      csvNum(r.type === "stak" ? c.fast : k.m3, 2), r.type === "stak" && d.type === "flis" ? csvNum(num(d.faktor), 2) : "", csvNum(c.flis, 2), r.type === "stok" ? k.n : "", d.note || "",
      r.lat ? r.lat.toFixed(6).replace(".", ",") : "", r.lon ? r.lon.toFixed(6).replace(".", ",") : ""].map(csvCell).join(";"));
  }
  return { csv: "\ufeff" + lines.join("\r\n") + "\r\n", rows: piles.length };
}
function photoName(r) { return `fotos/${(r.stand?.label || "uden-litra").replace(/[^\wæøåÆØÅ-]+/g, "_")}_${r.created.slice(0, 19).replace(/[:T]/g, "-")}_${r.id.slice(-4)}.jpg`; }
function buildGeoJSON() {
  return {
    type: "FeatureCollection",
    features: state.regs.map(r => {
      const props = { id: r.id, type: r.type, oprettet: r.created, gps_noejagtighed_m: r.accuracy ? Math.round(r.accuracy) : null,
        afd: r.stand?.afd ?? null, litra: r.stand?.litra ?? null, litra_navn: r.stand?.label ?? null, compartment_id: r.stand?.compartment_id ?? null,
        note: r.data.note || null, note_id: r.data.parent || null, generel: r.data.general ? 1 : null };
      if (r.type === "proeveflade") { const s = plotStats(r.data); Object.assign(props, { radius_m: r.data.radius, antal_traeer: s.n, stamtal_ha: Math.round(s.N),
        grundflade_m2_ha: +s.G.toFixed(2), dg_cm: s.Dg && +s.Dg.toFixed(1), hg_m: s.Hg && +s.Hg.toFixed(1), bk_pct: r.data.bk, traeer_json: JSON.stringify(r.data.trees) }); }
      if (r.type === "taksation") Object.assign(props, { hg_m: r.data.hg, dg_cm: r.data.dg, stamtal_ha: r.data.n, grundflade_m2_ha: r.data.g, vedmasse_m3_ha: r.data.v, bk_pct: r.data.bk, ny_traeart: r.data.art || null });
      if (r.type === "foto") props.foto = photoName(r);
      if (r.type === "stak" || r.type === "stok") {
        const d = r.data, c = r.type === "stak" ? stakCalc(d) : null, k = r.type === "stok" ? stokCalc(d) : null;
        Object.assign(props, { stak_nr: d.nr || null, sortiment: d.sortiment || null, traeart: d.art || null, koeber: d.kunde || null, ordre: d.ordre || null,
          hugst: d.hugst || null, udkoerer: d.udkoerer || null, skover: d.skover || null, afdeling: d.afdeling || null, volumen_m3: (c ? c.fast : k.m3) != null ? +(c ? c.fast : k.m3).toFixed(2) : null,
          rummeter: c?.rm != null ? +c.rm.toFixed(2) : null, flis_rm: c?.flis != null ? +c.flis.toFixed(2) : null, fastmasse_pct: c ? d.pct : null,
          stak_type: c ? STAK_TYPES[d.type] || null : null, antal_stokke: k ? k.n : null, maal_json: JSON.stringify(d) });
      }
      if (r.type === "spor") {
        Object.assign(props, { laengde_m: r.data.length_m, varighed_min: Math.round(r.data.minutes || 0), slut: r.data.points.length ? new Date(r.data.points[r.data.points.length - 1][2] * 1000).toISOString() : null });
        return { type: "Feature", geometry: { type: "LineString", coordinates: r.data.points.map(p => [p[1], p[0]]) }, properties: props };
      }
      return { type: "Feature", geometry: r.lat ? { type: "Point", coordinates: [+r.lon.toFixed(7), +r.lat.toFixed(7)] } : null, properties: props };
    }),
  };
}
function buildExportZip(withPhotos = true) {
  const zip = new JSZip(), stamp = today(), { csv, rows } = buildTaxCsv();
  zip.file(`taksationsark_felt_${stamp}.csv`, csv);
  zip.file("registreringer.geojson", JSON.stringify({ ...buildGeoJSON(), skovplan: { ejendom: state.data?.name || null, ...(state.data?.pakke || {}) } }, null, 1));
  const trees = buildTreeCsv(); if (trees.rows) zip.file(`enkelttraeer_${stamp}.csv`, trees.csv);
  const piles = buildPileCsv(); if (piles.rows) zip.file(`stakke_og_stokke_${stamp}.csv`, piles.csv);
  if (withPhotos) state.regs.filter(r => r.photo).forEach(r => zip.file(photoName(r), r.photo));
  zip.file("LAES-MIG.txt", [
    `SkovPlan Felt – eksport ${new Date().toLocaleString("da-DK")}`, `Skov: ${state.data?.name || ""}`, "",
    "Hent filen ind i SkovPlan med «Hent data fra app» (Import og ældre driftsplaner).", "",
    `taksationsark_felt_${stamp}.csv: ${rows} litra (indlæses automatisk af «Hent data fra app»).`,
    "  Tomme celler betyder «behold SkovPlans tal». Hg/Dg/stamtal/grundflade er beregnet fra prøvefladerne (gennemsnit pr. litra).",
    "enkelttraeer_<dato>.csv: alle målte træer, én række pr. træ (art, diameter, højde, bemærkning). Åbner i Excel.",
    "stakke_og_stokke_<dato>.csv: opmålte stakke og stokke med rummeter, m³ fast og m³ flis. Åbner i Excel.",
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
    ${syncCfg() ? `<p class="ok-note">Online-synk er slået til, så registreringerne sendes automatisk til SkovPlan, når telefonen har net. Filen her er kun en ekstra sikkerhedskopi.</p>` : ""}
    <p><b>${esc(name)}</b> · ${blob.size < 1048576 ? Math.max(1, Math.round(blob.size / 1024)) + " kB" : fmt(blob.size / 1048576, 1) + " MB"} · ${state.regs.length} registrering${state.regs.length === 1 ? "" : "er"}</p>
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
  dropRegs(r => r.exported); drawRegMarkers(); restyle(); refreshMenuInfo(); closeSheet();
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
    headers: Object.assign({ "Content-Type": "application/json", apikey: c.anon },
      /^eyJ/.test(c.anon) ? { Authorization: "Bearer " + c.anon } : {}), body: JSON.stringify(body) });
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
  $("#btnMenu").classList.toggle("pending", c ? ns > 0 : ne > 0);
  $("#btnMenu").title = c ? (ns ? `${ns} venter på at blive sendt` : "Alt er sendt til SkovPlan") : (ne ? `${ne} ikke eksporteret` : "");
  $("#btnUpdatePkg")?.classList.toggle("hidden", !onlinePackageUrl());
  propertyList().then(l => $("#btnChoose")?.classList.toggle("hidden", !(l.length > 1 || safeLS("kundeUrl"))));
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
  generalNote: () => newReg("note", true),
  goStand: () => { const f = state.selected; if (!f) return; const c = standTarget(f); closeSheet(); goTo(c.lat, c.lng, "Litra " + standLabel(f.properties)); },
  track: toggleTrack,
  pileList: () => pileList(), newStak: () => newPile("stak"), newStok: () => newPile("stok"),
  packageLink: askPackageLink,
  chooseProperty: () => propertySheet(),
  updatePackage: () => { const u = onlinePackageUrl(); u ? downloadPackage(u) : askPackageLink(); },
  install: async () => {
    if (state.installPrompt) { state.installPrompt.prompt(); const r = await state.installPrompt.userChoice; state.installPrompt = null;
      if (r.outcome === "accepted") $("#btnInstall").classList.add("hidden"); return; }
    alert("Tryk på Del-knappen (firkanten med pilen) i Safari og vælg «Føj til hjemmeskærm». Så ligger SkovPlan Felt som en app.");
  },
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
$("#galleryInput").onchange = async e => { const fs = [...e.target.files]; e.target.value = ""; for (const f of fs) await takePhoto(f); };
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
/* Feltpakke online: SkovPlan lægger pakken i Supabase og giver et link …/?pakke=<adresse>. */
function onlinePackageUrl() {
  const c = state.data?.pakke?.sync;
  if (c?.rest && c?.noegle) return c.rest.replace(/\/rest\/v1\/?$/, "") + `/storage/v1/object/public/feltpakker/${c.noegle}/feltpakke.zip`;
  return safeLS("pakkeUrl");
}
function packageUrlFrom(text) {
  text = String(text || "").trim(); if (!text) return null;
  try { const u = new URL(text); const p = u.searchParams.get("pakke"); return p ? new URL(p).href : u.href; } catch (e) { return null; }
}
async function downloadPackage(url) {
  if (!url) return;
  if (!navigator.onLine) return toast("Telefonen har ikke net lige nu. Prøv igen, når den har.", 5000);
  try {
    const res = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error(res.status === 400 || res.status === 404 ? "pakken findes ikke (er linket rigtigt?)" : "HTTP " + res.status);
    const total = +res.headers.get("content-length") || 0, reader = res.body.getReader(), parts = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      parts.push(value); got += value.length;
      toast(`Henter feltpakken … ${total ? Math.round(got / total * 100) + " %" : Math.round(got / 1048576) + " MB"}`, 60000);
    }
    safeLS("pakkeUrl", url);
    await openFiles([new File(parts, "feltpakke.zip", { type: "application/zip" })]);
  } catch (err) { console.error(err); toast("Feltpakken kunne ikke hentes: " + err.message, 7000); }
}
/* Kunde med flere ejendomme: …/?kunde=<kunde.json>. Kunden vælger ejendom; én ad gangen ligger på telefonen. */
async function chooseProperty(url) {
  if (url) safeLS("kundeUrl", url);
  if (!safeLS("kundeUrl")) return askPackageLink();
  if (!navigator.onLine) toast("Telefonen har ikke net lige nu, så kun ejendomme på telefonen vises.", 5000);
  return propertySheet();
}
function askPackageLink() {
  const text = prompt("Indsæt linket, som du har fået fra SkovPlan:");
  try { const k = new URL(String(text || "").trim()).searchParams.get("kunde"); if (k) return chooseProperty(new URL(k).href); } catch (e) { /* ikke et kundelink */ }
  const url = packageUrlFrom(text);
  if (url) downloadPackage(url); else toast("Det ligner ikke et link fra SkovPlan");
}
async function loadGpkg(g, f, meta) {
  const data = readGpkg(g, f);
  if (meta) { const { _extra, ...pakke } = meta; data.pakke = pakke; if (_extra) data.extra = _extra; }
  data.id = propId(data);
  await db.put("kv", data, "skovkort:" + data.id);
  await activateProperty(data, await db.get("kv", "ortofoto:" + data.id));
  await rememberProperty(data);
  scheduleSync();
  toast(`Indlæst: ${data.layers.skovafdelinger.features.length} litradele`);
}
/* Læs ortofotoet (MBTiles fra SkovPlan) og læg fliserne i telefonens lager, så det virker uden net. */
async function loadOrtho(g, f) {
  {
    const meta = {};
    (g.exec("SELECT name, value FROM metadata")[0]?.values || []).forEach(([k, v]) => meta[k] = v);
    const total = g.exec("SELECT count(*) FROM tiles")[0].values[0][0];
    if (!total) throw new Error("filen har ingen fliser");
    const id = state.data?.id || "uden-skovkort", prefix = id + "|";
    await removeTiles(await db.get("kv", "ortofoto:" + id));
    const st = g.prepare("SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles");
    const type = /png/i.test(meta.format || "") ? "image/png" : "image/jpeg";
    let batch = [], done = 0, minz = 99, maxz = 0;
    while (st.step()) {
      const [z, x, row, data] = st.get();
      minz = Math.min(minz, z); maxz = Math.max(maxz, z);
      batch.push([`${prefix}${z}/${x}/${(1 << z) - 1 - row}`, new Blob([data], { type })]);
      if (batch.length >= 300) { await db.putMany("tiles", batch); done += batch.length; batch = []; toast(`Gemmer ortofoto … ${Math.round(done / total * 100)} %`, 60000); }
    }
    st.free(); if (batch.length) await db.putMany("tiles", batch);
    state.ortho = { name: f.name, minzoom: minz, maxzoom: maxz, attribution: meta.attribution || "Ortofoto",
      bounds: meta.bounds ? meta.bounds.split(",").map(Number) : null, loaded: new Date().toISOString(), tiles: total, prefix };
    await db.put("kv", state.ortho, "ortofoto:" + id);
    if (state.data) await rememberProperty(state.data);
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


/* ------------------------------------------------------------------ «Gå til»: kompas, afstand og linje på kortet */
let navLine = null, navMarker = null, heading = null;
const toRad = d => d * Math.PI / 180;
function bearing(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const compassName = b => ["N", "NØ", "Ø", "SØ", "S", "SV", "V", "NV"][Math.round(b / 45) % 8];
const fmtLen = m => m >= 1000 ? fmt(m / 1000, m < 10000 ? 2 : 1) + " km" : Math.round(m || 0) + " m";
/* Et punkt inde i litraet (midten af den største del, hvis midten ligger udenfor: et punkt i polygonen). */
function standTarget(f) {
  const layer = L.geoJSON(f), parts = [];
  layer.eachLayer(l => parts.push(l));
  let best = parts[0], area = 0;
  for (const l of parts) { const b = l.getBounds(), a = (b.getNorth() - b.getSouth()) * (b.getEast() - b.getWest()); if (a > area) { area = a; best = l; } }
  const c = best.getBounds().getCenter();
  if (standAt(c.lng, c.lat)?.properties === f.properties) return c;
  const ring = best.getLatLngs().flat(3); return ring.length ? L.latLngBounds(ring.slice(0, 3)).getCenter() : c;
}
async function goTo(lat, lon, label) {
  state.nav = { lat, lon, label };
  try {   // iPhone kræver tilladelse til kompasset
    if (typeof DeviceOrientationEvent !== "undefined" && DeviceOrientationEvent.requestPermission) await DeviceOrientationEvent.requestPermission();
  } catch (e) { /* uden kompas */ }
  startCompass();
  if (navMarker) map.removeLayer(navMarker);
  navMarker = L.marker([lat, lon], { icon: L.divIcon({ className: "", html: '<div class="nav-target"></div>', iconSize: [22, 22] }) }).addTo(map);
  $("#navbar").classList.remove("hidden"); $("#navLabel").textContent = label || "Punkt";
  if (state.me) map.fitBounds(L.latLngBounds([[lat, lon], [state.me.lat, state.me.lon]]).pad(0.3), { maxZoom: 18 });
  else map.setView([lat, lon], Math.max(map.getZoom(), 16));
  follow = false; updateNav();
}
function stopNav() {
  state.nav = null; $("#navbar").classList.add("hidden");
  for (const l of [navLine, navMarker]) if (l) map.removeLayer(l);
  navLine = navMarker = null;
}
let compassOn = false;
function startCompass() {
  if (compassOn) return; compassOn = true;
  const on = e => {
    let h = null;
    if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === "number") h = 360 - e.alpha;
    if (h === null) return;
    heading = (h + (screen.orientation?.angle || 0) + 360) % 360; updateNav();
  };
  if ("ondeviceorientationabsolute" in window) window.addEventListener("deviceorientationabsolute", on);
  else window.addEventListener("deviceorientation", on);
}
function updateNav() {
  const n = state.nav; if (!n) return;
  if (!state.me) { $("#navDist").textContent = "Venter på GPS …"; return; }
  const me = L.latLng(state.me.lat, state.me.lon), to = L.latLng(n.lat, n.lon);
  const d = map.distance(me, to), b = bearing(me, to);
  if (navLine) navLine.setLatLngs([me, to]);
  else navLine = L.polyline([me, to], { color: "#1a73e8", weight: 3, dashArray: "6 6", interactive: false }).addTo(map);
  const here = d <= Math.max(5, state.me.accuracy || 0);
  $("#navDist").textContent = here ? "Du er fremme" : `${fmtLen(d)} mod ${compassName(b)}`;
  $("#navArrow").style.transform = `rotate(${heading === null ? b : b - heading}deg)`;
  $("#navArrow").classList.toggle("here", here);
  $("#navHint").textContent = heading === null ? "Pilen peger i forhold til kortet (nord op)" : "Pilen peger, hvor du skal gå";
}
$("#navStop").onclick = stopNav;
map.on("contextmenu", e => {
  L.popup().setLatLng(e.latlng).setContent('<button class="primary" id="goHere">➜ Gå hertil</button>').openOn(map);
  setTimeout(() => { const b = document.getElementById("goHere"); if (b) b.onclick = () => { map.closePopup(); goTo(e.latlng.lat, e.latlng.lng, "Punkt på kortet"); }; }, 0);
});

/* ------------------------------------------------------------------ spor: optag den rute, der er gået
   Punkter gemmes, når GPS'en er god nok (±25 m) og man har flyttet sig 5 m. Undervejs gemmes sporet i kv «spor-igang»,
   så det ikke går tabt, hvis appen lukkes. Skærmen holdes tændt (wake lock), fordi telefonen ellers stopper GPS'en. */
let trackLine = null, wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* ikke understøttet */ }
}
document.addEventListener("visibilitychange", () => { if (state.track && document.visibilityState === "visible") keepAwake(true); });
function trackLength(pts) { let m = 0; for (let i = 1; i < pts.length; i++) m += map.distance(pts[i - 1], pts[i]); return m; }
function drawTrack() {
  const pts = state.track?.points.map(p => [p[0], p[1]]) || [];
  if (!state.track) { if (trackLine) map.removeLayer(trackLine); trackLine = null; }
  else if (trackLine) trackLine.setLatLngs(pts);
  else trackLine = L.polyline(pts, { color: "#e8710a", weight: 4, opacity: 0.9, interactive: false }).addTo(map);
  const b = $("#btnTrack");
  if (b) b.textContent = state.track ? `■ Stop ruten (${fmtLen(trackLength(pts))})` : "● Optag ruten, jeg går";
  $("#trackDot").classList.toggle("hidden", !state.track);
}
function trackPoint(lat, lon, acc, t) {
  const tr = state.track; if (!tr || acc > 25) return;
  const last = tr.points[tr.points.length - 1];
  if (last && map.distance([last[0], last[1]], [lat, lon]) < 5) return;
  tr.points.push([+lat.toFixed(6), +lon.toFixed(6), Math.round((t || Date.now()) / 1000)]);
  db.put("kv", tr, "spor-igang").catch(() => {});
  drawTrack();
}
async function toggleTrack() {
  if (!state.track) {
    state.track = { id: uid(), start: new Date().toISOString(), ejendom: state.data?.name || null, points: [] };
    await db.put("kv", state.track, "spor-igang"); keepAwake(true); drawTrack();
    if (state.me) trackPoint(state.me.lat, state.me.lon, state.me.accuracy, Date.now());
    return toast("Ruten optages. Hold appen åben, så GPS'en kører.", 5000);
  }
  const tr = state.track; state.track = null; keepAwake(false); drawTrack(); await db.del("kv", "spor-igang");
  if (tr.points.length < 2) return toast("Ruten var for kort til at blive gemt");
  const len = trackLength(tr.points.map(p => [p[0], p[1]]));
  const reg = { id: tr.id, type: "spor", created: tr.start, lat: tr.points[0][0], lon: tr.points[0][1], stand: null, ejendom: tr.ejendom,
    data: { points: tr.points, length_m: Math.round(len), minutes: (tr.points[tr.points.length - 1][2] - tr.points[0][2]) / 60, note: "" } };
  await saveReg(reg); trackForm({ ...reg, data: { ...reg.data } });
}
function trackForm(reg) {
  openSheet(`<div class="head"><h3>Rute · ${fmtLen(reg.data.length_m)}</h3><button class="close">Luk</button></div>
    <p class="muted">${new Date(reg.created).toLocaleString("da-DK", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} ·
      ${Math.round(reg.data.minutes || 0)} min · ${reg.data.points.length} punkter</p>
    <label>Note til ruten</label><textarea id="sNote">${esc(reg.data.note || "")}</textarea>
    <div class="stack"><button class="primary big" id="sSave">Gem</button><button class="danger" id="sDel">Slet ruten</button></div>`);
  map.fitBounds(L.latLngBounds(reg.data.points.map(p => [p[0], p[1]])).pad(0.2));
  $("#sSave").onclick = async () => { reg.data.note = $("#sNote").value.trim(); await saveReg(reg); closeSheet(); toast("Ruten er gemt"); };
  $("#sDel").onclick = () => deleteReg(reg);
}

/* ------------------------------------------------------------------ flere ejendomme på telefonen
   Hver ejendom gemmes for sig: kv «skovkort:<id>», kv «ortofoto:<id>» og fliser med nøglen «<id>|z/x/y».
   kv «ejendomme» er listen, kv «aktiv» er den viste. Registreringerne har ejendommens navn (reg.ejendom). */
const propId = d => d.pakke?.sync?.noegle || "navn:" + (d.name || "skov");
async function removeTiles(ortho) {
  if (!ortho) return;
  if (ortho.prefix) return db.delPrefix("tiles", ortho.prefix);
  const keys = await db.keys("tiles");               // ældre version: fliser uden ejendom foran
  await db.tx("tiles", "readwrite", s => { for (const k of keys) if (/^\d+\/\d+\/\d+$/.test(k)) s.delete(k); });
}
async function propertyList() { return (await db.get("kv", "ejendomme")) || []; }
async function rememberProperty(d) {
  const list = (await propertyList()).filter(p => p.id !== d.id);
  const o = await db.get("kv", "ortofoto:" + d.id);
  list.push({ id: d.id, name: d.name, kunde: d.pakke?.kunde || null, loaded: d.loaded, ortho: !!o, tiles: o?.tiles || 0, url: onlinePackageUrlFor(d) });
  list.sort((a, b) => a.name.localeCompare(b.name, "da"));
  await db.put("kv", list, "ejendomme");
}
function onlinePackageUrlFor(d) {
  const c = d?.pakke?.sync;
  return c?.rest && c?.noegle ? c.rest.replace(/\/rest\/v1\/?$/, "") + `/storage/v1/object/public/feltpakker/${c.noegle}/feltpakke.zip` : null;
}
async function activateProperty(d, ortho) {
  state.data = d; state.ortho = ortho || null; state.selected = null;
  await db.put("kv", d.id, "aktiv");
  state.regs = regsFor(d); state.syncHash = syncCfg() ? safeLS("syncHash:" + syncCfg().noegle) : null;
  drawData(); fitData(); setBasemap(state.ortho ? 0 : (state.basemap || 1)); drawRegMarkers(); restyle(); refreshMenuInfo();
}
async function switchProperty(id) {
  if (state.data?.id === id) return closeSheet();
  if (syncCfg() && state.regs.some(r => !r.synced)) { try { await syncNow(false); } catch (e) { /* sendes senere */ } }
  const d = await db.get("kv", "skovkort:" + id);
  if (!d) return toast("Ejendommen findes ikke længere på telefonen");
  closeSheet(); await activateProperty(d, await db.get("kv", "ortofoto:" + id)); toast(d.name);
}
async function removeProperty(id) {
  const p = (await propertyList()).find(x => x.id === id); if (!p) return;
  const waiting = state.allRegs.filter(r => r.ejendom === p.name && !r.synced && !r.exported).length;
  if (!confirm(`Fjern ${p.name} fra telefonen?` + (waiting ? `\n\n${waiting} registreringer er ikke sendt endnu og bliver også slettet.` : ""))) return;
  await removeTiles(await db.get("kv", "ortofoto:" + id));
  await db.del("kv", "skovkort:" + id); await db.del("kv", "ortofoto:" + id);
  for (const r of state.allRegs.filter(r => r.ejendom === p.name)) await db.del("regs", r.id);
  dropRegs(r => r.ejendom === p.name);
  await db.put("kv", (await propertyList()).filter(x => x.id !== id), "ejendomme");
  if (state.data?.id === id) {
    const next = (await propertyList())[0];
    if (next) await switchProperty(next.id); else { state.data = null; state.ortho = null; state.regs = []; drawData(); setBasemap(1); await db.del("kv", "aktiv"); showWelcome(true); }
  }
  propertySheet();
}
/* Gamle versioner havde én ejendom i kv «skovkort»/«ortofoto». */
async function migrateSingle() {
  const old = await db.get("kv", "skovkort"); if (!old) return;
  old.id = propId(old);
  await db.put("kv", old, "skovkort:" + old.id);
  const o = await db.get("kv", "ortofoto"); if (o) await db.put("kv", { ...o, prefix: "" }, "ortofoto:" + old.id);
  await db.put("kv", old.id, "aktiv"); await rememberProperty(old);
  await db.del("kv", "skovkort"); await db.del("kv", "ortofoto");
}
async function propertySheet() {
  const list = await propertyList();
  let customer = null;
  const url = safeLS("kundeUrl");
  if (url && navigator.onLine) {
    try { const res = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" }); if (res.ok) customer = await res.json(); } catch (e) { /* uden net */ }
  }
  const local = new Set(list.map(p => p.name));
  const remote = (customer?.ejendomme || []).filter(e => !local.has(e.navn));
  const mb = n => n ? ` · ortofoto` : " · uden ortofoto";
  $("#empty").classList.add("hidden");
  openSheet(`<div class="head"><h3>Ejendomme</h3><button class="close">Luk</button></div>
    ${list.length ? `<p class="muted">På telefonen (virker uden net):</p><ul class="list">${list.map(p => `<li><div class="grow"><b>${esc(p.name)}</b>
      <br><span class="muted">${p.id === state.data?.id ? "vises nu" : "hentet " + new Date(p.loaded).toLocaleDateString("da-DK")}${mb(p.ortho)}</span></div>
      ${p.id === state.data?.id ? "" : `<button class="primary" data-open="${esc(p.id)}">Åbn</button>`}
      ${p.url ? `<button data-update="${esc(p.id)}" title="Hent nyeste version">↻</button>` : ""}
      <button class="danger" data-remove="${esc(p.id)}" title="Fjern fra telefonen">✕</button></li>`).join("")}</ul>` : ""}
    ${remote.length ? `<p class="muted">${esc(customer.kunde || "Flere ejendomme")} – kan hentes:</p><ul class="list">${remote.map((e, i) => `<li><div class="grow"><b>${esc(e.navn)}</b></div>
      <button class="primary" data-get="${i}">Hent</button></li>`).join("")}</ul>` : ""}
    ${url && !customer ? `<p class="muted">Kundens øvrige ejendomme vises, når telefonen har net.</p>` : ""}
    <button class="big" data-act="packageLink">Indsæt link fra SkovPlan</button>
    <button class="big" data-act="openGpkg">Vælg feltpakke-fil</button>`);
  sheet.querySelectorAll("[data-open]").forEach(b => b.onclick = () => switchProperty(b.dataset.open));
  sheet.querySelectorAll("[data-remove]").forEach(b => b.onclick = () => removeProperty(b.dataset.remove));
  sheet.querySelectorAll("[data-update]").forEach(b => b.onclick = () => { const p = list.find(x => x.id === b.dataset.update); closeSheet(); downloadPackage(p.url); });
  sheet.querySelectorAll("[data-get]").forEach(b => b.onclick = async () => {
    const e = remote[+b.dataset.get]; closeSheet();
    if (syncCfg() && state.regs.some(r => !r.synced)) { try { await syncNow(false); } catch (err) { /* sendes senere */ } }
    downloadPackage(e.url);
  });
}

/* ------------------------------------------------------------------ start */
(async function start() {
  try { await navigator.storage?.persist?.(); } catch (e) { /* ok */ }
  try {
    await migrateSingle();
    state.allRegs = await db.all("regs");
    const aktiv = await db.get("kv", "aktiv");
    if (aktiv) { state.data = await db.get("kv", "skovkort:" + aktiv); state.ortho = await db.get("kv", "ortofoto:" + aktiv); }
    state.regs = regsFor(state.data);
    const running = await db.get("kv", "spor-igang");
    if (running) { state.track = running; keepAwake(true); setTimeout(() => { drawTrack(); toast("Ruten optages stadig", 4000); }, 500); }
  } catch (e) { console.error(e); toast("Telefonens lager kunne ikke åbnes: " + e.message, 6000); }
  const saved = safeLS("basemap"); setBasemap(saved === null ? 0 : +saved % BASEMAPS.length);
  if (state.data) { drawData(); fitData(); }
  showWelcome();
  drawRegMarkers(); startGps();
  const params = new URLSearchParams(location.search);
  const linked = packageUrlFrom(params.get("pakke") ? location.href : "");
  let customer = null; try { customer = params.get("kunde") ? new URL(params.get("kunde")).href : null; } catch (e) { /* ugyldigt */ }
  if (linked || customer) history.replaceState(null, "", location.pathname);
  if (customer) chooseProperty(customer); else if (linked) downloadPackage(linked);
  if (syncCfg()) { state.syncHash = safeLS("syncHash:" + syncCfg().noegle); scheduleSync(); }
  // Installér som app (Android/Chrome viser sin egen dialog; iPhone: Del › Føj til hjemmeskærm)
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); state.installPrompt = e; $("#btnInstall")?.classList.remove("hidden"); });
  if (!standalone && /iPhone|iPad/.test(navigator.userAgent)) $("#btnInstall")?.classList.remove("hidden");
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW", e));
})();
