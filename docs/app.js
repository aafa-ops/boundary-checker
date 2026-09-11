const DATA = "data/";
const ASSET_VERSION = "12"; // bump on deploy if a CDN/proxy ever caches these too aggressively
const FULL_COLOUR = "#2f9e44";
const SPLIT_COLOUR = "#e8590c";

const state = {
  districtsFC: null,        // GeoJSON FeatureCollection of districts (also used for point-in-polygon)
  unitLayerGroup: null,     // current Leaflet layer - only the units visible in the viewport, not all of them
  unitLayerKind: "none",    // which kind is currently shown
  unitLayerIndex: {},       // id -> leaflet layer, for the CURRENTLY RENDERED (visible) subset only
  unitCache: {},            // full GeoJSON FeatureCollection by kind, fetched once
  unitBoundsCache: {},      // kind -> Map(id -> L.LatLngBounds), precomputed once per kind for viewport filtering
  lookup: {},               // postcodes/suburbs/lgas lookup JSON, loaded on demand
  crosswalk: null,
  districtBoundaryWeight: 3.5,
  unitBoundaryWeight: 1.5,
  partyOpacity: 0.55,
  districtFilter: null,     // { name, label } when the split list is showing "what's in this district"
};

const LABEL_ZOOM = { postcodes: 10, suburbs: 12, lgas: 8 };
const MAX_RENDERED_UNITS = 600; // safety cap - a viewport at the render-zoom thresholds shouldn't hit this

const map = L.map("map", { zoomControl: true, renderer: L.canvas() }).setView([-36.9, 144.4], 7);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

// Leaflet's default popup position puts the click point (and whatever's
// under it) roughly behind the popup's centre, obscuring the area you just
// clicked on. The offset below was empirically measured to land the
// popup's bottom-left corner on the click point instead - but that only
// holds if every popup renders at the SAME width, since Leaflet centres
// popups based on their actual rendered width (which varies with content
// length by default). So minWidth/maxWidth are locked to the same value
// here, forcing a constant width regardless of content, which is what
// makes the fixed offset reliable rather than "mostly working".
const POPUP_OPTIONS = { offset: L.point(-127, -47), minWidth: 300, maxWidth: 300 };

async function fetchJSON(url, { versioned = false } = {}) {
  const finalUrl = versioned ? `${url}${url.includes("?") ? "&" : "?"}v=${ASSET_VERSION}` : url;
  const r = await fetch(finalUrl, { cache: "no-cache" });
  if (!r.ok) throw new Error(`Failed to load ${finalUrl}`);
  return r.json();
}

async function fetchTopoAsGeoJSON(path) {
  const topo = await fetchJSON(DATA + path, { versioned: true });
  return topojson.feature(topo, topo.objects.data);
}

function districtPopupHTML(props) {
  const margin = props.margin_pct_points != null ? `${props.margin_pct_points}pt` : "n/a";
  const labelEscaped = props.district_label.replace(/'/g, "\\'");
  const fp = props.first_preference || [];
  const top5 = fp.slice(0, 5);
  const ajp = fp.find((c) => c.party === "Animal Justice Party");
  const ajpInTop5 = !!ajp && top5.includes(ajp);

  const candidateRows = top5.map((c) => `
    <tr>
      <td>${c.rank}</td>
      <td>${c.candidate}</td>
      <td style="color:#666;">${c.party}</td>
      <td style="text-align:right;"><b>${c.pct}%</b></td>
    </tr>`).join("");

  const ajpRow = ajp && !ajpInTop5
    ? `<div class="ajp-callout">Animal Justice Party — ${ajp.candidate}: <b>${ajp.pct}%</b> first-preference (ranked ${ajp.rank} of ${fp.length})</div>`
    : "";

  return `
    <div class="district-popup-header">
      <h3>${props.district_label}</h3>
      <div class="district-margin">${margin}<span class="margin-label">margin</span></div>
    </div>
    <div class="hint" style="margin:0 0 6px;">${props.region_label || ""}</div>
    <div><span class="swatch" style="background:${props.party_colour}"></span><b>${props.member}</b> — ${props.party}</div>
    <div class="hint" style="margin:8px 0 2px;">First-preference votes (2022):</div>
    <table class="fp-table">${candidateRows}</table>
    ${ajpRow}
    <div class="popup-actions">
      <div class="hint" style="margin:0 0 4px;">List what's inside this district, with % of each:</div>
      <button onclick="showUnitsInDistrict('${props.district_name}', '${labelEscaped}', 'postcodes')">Postcodes</button>
      <button onclick="showUnitsInDistrict('${props.district_name}', '${labelEscaped}', 'suburbs')">Suburbs</button>
      <button onclick="showUnitsInDistrict('${props.district_name}', '${labelEscaped}', 'lgas')">LGAs</button>
    </div>`;
}

function unitPopupHTML(entry, kindLabel) {
  const badge = entry.is_split
    ? `<span class="status-badge status-split">Split across ${entry.district_count} districts</span>`
    : `<span class="status-badge status-full">Fully within one district</span>`;
  return `<h3>${entry.name}</h3><div style="font-size:11px;color:#888;margin-bottom:4px;">${kindLabel}</div>${badge}`
    + entry.districts.map(districtRowHTML).join("");
}

async function loadBoundary() {
  const fc = await fetchTopoAsGeoJSON("vic_boundary.topojson");
  L.geoJSON(fc, {
    style: { color: "#1c596e", weight: 2, dashArray: "4 3", fill: false },
    interactive: false,
  }).addTo(map);
}

async function loadDistricts() {
  const fc = await fetchTopoAsGeoJSON("vic_districts.topojson");
  state.districtsFC = fc;
  const layer = L.geoJSON(fc, {
    smoothFactor: 2,
    style: (f) => ({
      color: "#444",
      weight: state.districtBoundaryWeight,
      fillColor: f.properties.party_colour,
      fillOpacity: state.partyOpacity,
    }),
    onEachFeature: (f, l) => l.bindPopup(districtPopupHTML(f.properties), POPUP_OPTIONS),
  });
  state.districtsLayer = layer;
  layer.addTo(map);
  buildPartyLegend(fc);
}

function applyDistrictBoundaryWeight(weight) {
  state.districtBoundaryWeight = weight;
  if (state.districtsLayer) state.districtsLayer.setStyle({ weight });
}

function applyUnitBoundaryWeight(weight) {
  state.unitBoundaryWeight = weight;
  if (state.unitMainLayer) state.unitMainLayer.setStyle({ weight });
  if (state.unitCasingLayer) state.unitCasingLayer.setStyle({ weight: weight + 2.5 });
  if (state.highlightedUnitLayer) state.highlightedUnitLayer.setStyle({ weight: weight + HIGHLIGHT_EXTRA_WEIGHT });
}

function applyPartyOpacity(opacity) {
  state.partyOpacity = opacity;
  if (state.districtsLayer) state.districtsLayer.setStyle({ fillOpacity: opacity });
}

function buildPartyLegend(fc) {
  const seen = new Map();
  fc.features.forEach((f) => {
    if (!seen.has(f.properties.party)) seen.set(f.properties.party, f.properties.party_colour);
  });
  const el = document.getElementById("party-legend");
  el.innerHTML = "";
  for (const [party, colour] of seen) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span class="swatch" style="background:${colour}"></span> ${party}`;
    el.appendChild(row);
  }
}

const UNIT_CONFIG = {
  postcodes: { file: "vic_postcodes.topojson", idProp: "POA_CODE21", nameProp: "POA_NAME21", label: "Postcode", minRenderZoom: 8 },
  suburbs: { file: "vic_suburbs.topojson", idProp: "SAL_CODE21", nameProp: "SAL_NAME21", label: "Suburb", minRenderZoom: 9 },
  lgas: { file: "vic_lgas.topojson", idProp: "LGA_CODE25", nameProp: "LGA_NAME25", label: "LGA", minRenderZoom: 6 },
};

const HIGHLIGHT_EXTRA_WEIGHT = 4;

function highlightUnitLayer(layer) {
  if (state.highlightedUnitLayer && state.highlightedUnitLayer !== layer) {
    state.highlightedUnitLayer.setStyle({ weight: state.unitBoundaryWeight });
  }
  state.highlightedUnitLayer = layer;
  layer.setStyle({ weight: state.unitBoundaryWeight + HIGHLIGHT_EXTRA_WEIGHT });
  layer.bringToFront();
}

function clearUnitLayer() {
  if (state.unitLayerGroup) {
    map.removeLayer(state.unitLayerGroup);
    state.unitLayerGroup = null;
    state.unitMainLayer = null;
    state.unitCasingLayer = null;
  }
  state.unitLayerIndex = {};
  state.highlightedUnitLayer = null;
}

function setZoomHint(text) {
  document.getElementById("zoom-hint").textContent = text;
}

async function setUnitLayer(kind) {
  clearUnitLayer();
  state.unitLayerKind = kind;
  if (kind === "none") {
    setZoomHint("");
    return;
  }
  const cfg = UNIT_CONFIG[kind];
  if (!state.unitCache[kind]) {
    const [fc] = await Promise.all([fetchTopoAsGeoJSON(cfg.file), getLookup(kind)]);
    state.unitCache[kind] = fc;
    // Precompute each feature's bounds once - lets us viewport-filter on every
    // pan/zoom without re-walking coordinates, and locate off-screen units
    // (from the split list) without having rendered them yet.
    state.unitBoundsCache[kind] = new Map(
      fc.features.map((f) => [f.properties[cfg.idProp], L.geoJSON(f).getBounds()])
    );
  } else {
    await getLookup(kind); // no-op once cached; guards a direct setUnitLayer call before init
  }
  refreshUnitLayer();
}

function refreshUnitLayer() {
  const kind = state.unitLayerKind;
  if (kind === "none") return;
  const cfg = UNIT_CONFIG[kind];
  clearUnitLayer();

  // Below this zoom, showing all of them statewide is both illegible and the
  // main cause of pan/zoom lag - so don't render at all until zoomed in enough
  // for a viewport-sized subset to be worth drawing.
  if (map.getZoom() < cfg.minRenderZoom) {
    const total = state.unitCache[kind].features.length;
    setZoomHint(`Zoom in to see ${cfg.label.toLowerCase()} outlines — ${total} statewide is too many to show meaningfully at this zoom.`);
    return;
  }
  setZoomHint("");

  const fc = state.unitCache[kind];
  const boundsCache = state.unitBoundsCache[kind];
  const lookup = state.lookup[kind] || {};
  const viewBounds = map.getBounds().pad(0.25);
  let visible = fc.features.filter((f) => viewBounds.intersects(boundsCache.get(f.properties[cfg.idProp])));
  if (visible.length > MAX_RENDERED_UNITS) visible = visible.slice(0, MAX_RENDERED_UNITS);

  // A white casing behind the coloured line keeps it visible regardless of
  // which party's fill colour it happens to sit on (plain orange all but
  // vanished against a Labor-red district, for instance).
  const featureCollection = { type: "FeatureCollection", features: visible };
  const casing = L.geoJSON(featureCollection, {
    smoothFactor: 2,
    interactive: false,
    style: () => ({ color: "#fff", weight: state.unitBoundaryWeight + 2.5, opacity: 0.9, fill: false }),
  });
  const main = L.geoJSON(featureCollection, {
    smoothFactor: 2,
    style: (f) => ({
      color: f.properties.is_split ? SPLIT_COLOUR : FULL_COLOUR,
      weight: state.unitBoundaryWeight,
      fill: false,
    }),
    onEachFeature: (f, l) => {
      const id = f.properties[cfg.idProp];
      const name = f.properties[cfg.nameProp];
      const entry = lookup[id];
      if (entry) l.bindPopup(unitPopupHTML(entry, cfg.label), POPUP_OPTIONS);
      l.bindTooltip(name, { permanent: true, direction: "center", className: "unit-label" });
      state.unitLayerIndex[id] = l;
    },
  });
  main.on("popupopen", (e) => highlightUnitLayer(e.layer));
  const layerGroup = L.layerGroup([casing, main]);
  state.unitLayerGroup = layerGroup;
  state.unitMainLayer = main;
  state.unitCasingLayer = casing;
  layerGroup.addTo(map);
  updateLabelVisibility();
}

function updateLabelVisibility() {
  const kind = state.unitLayerKind;
  if (!state.unitMainLayer || kind === "none") return;
  const shouldShow = map.getZoom() >= LABEL_ZOOM[kind];
  state.unitMainLayer.eachLayer((l) => {
    if (shouldShow) l.openTooltip();
    else l.closeTooltip();
  });
}
map.on("moveend", refreshUnitLayer);

document.querySelectorAll('input[name="unit-layer"]').forEach((radio) => {
  radio.addEventListener("change", (e) => setUnitLayer(e.target.value));
});
document.getElementById("slider-district-boundary").addEventListener("input", (e) => applyDistrictBoundaryWeight(parseFloat(e.target.value)));
document.getElementById("slider-unit-boundary").addEventListener("input", (e) => applyUnitBoundaryWeight(parseFloat(e.target.value)));
document.getElementById("slider-party").addEventListener("input", (e) => applyPartyOpacity(parseFloat(e.target.value)));

// ---------- Splits table ----------
const SPLITS_CONFIG = {
  postcodes: { lookupFile: "lookup_postcodes.json" },
  suburbs: { lookupFile: "lookup_suburbs.json" },
  lgas: { lookupFile: "lookup_lgas.json" },
};

async function getLookup(kind) {
  if (!state.lookup[kind]) {
    state.lookup[kind] = await fetchJSON(DATA + SPLITS_CONFIG[kind].lookupFile, { versioned: true });
  }
  return state.lookup[kind];
}

async function renderSplitTable(kind, filterText) {
  const lookup = await getLookup(kind);
  const tbody = document.querySelector("#split-table tbody");
  tbody.innerHTML = "";
  const statusEl = document.getElementById("district-filter-status");
  const rows = [];

  if (state.districtFilter) {
    const { name, label } = state.districtFilter;
    for (const unitId in lookup) {
      const entry = lookup[unitId];
      if (filterText && !entry.name.toLowerCase().includes(filterText.toLowerCase())) continue;
      const match = entry.districts.find((d) => d.district === name);
      if (!match) continue;
      rows.push({ unitId, name: entry.name, ...match });
    }
    statusEl.hidden = false;
    statusEl.innerHTML = `Showing every ${UNIT_CONFIG[kind].label.toLowerCase()} touching <b>${label}</b> (${rows.length}) <button onclick="clearDistrictFilter()">Clear</button>`;
  } else {
    statusEl.hidden = true;
    for (const unitId in lookup) {
      const entry = lookup[unitId];
      if (!entry.is_split) continue;
      if (filterText && !entry.name.toLowerCase().includes(filterText.toLowerCase())) continue;
      for (const d of entry.districts) rows.push({ unitId, name: entry.name, ...d });
    }
  }

  rows.sort((a, b) => a.name.localeCompare(b.name) || b.pct_area - a.pct_area);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" id="split-table-empty">No matches.</td></tr>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of rows.slice(0, 1000)) {
    const tr = document.createElement("tr");
    const districtCell = `<span class="district-link" onclick="event.stopPropagation(); locateDistrict('${r.district}')">${r.district_label}</span>`;
    tr.innerHTML = `<td><span class="name-link">${r.name}</span></td><td>${districtCell}</td><td>${r.member}</td><td>${r.party}</td><td>${r.pct_area}%</td>`;
    tr.addEventListener("click", () => locateUnitOnMap(kind, r.unitId));
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

async function showUnitsInDistrict(districtName, districtLabel, kind) {
  state.districtFilter = { name: districtName, label: districtLabel };
  const radio = document.querySelector(`input[name="split-type"][value="${kind}"]`);
  if (radio) radio.checked = true;
  currentSplitKind = kind;
  document.getElementById("split-search").value = "";
  await renderSplitTable(kind, "");
  document.getElementById("splits-full").scrollIntoView({ behavior: "smooth", block: "start" });
}

function clearDistrictFilter() {
  state.districtFilter = null;
  renderSplitTable(currentSplitKind, document.getElementById("split-search").value);
}

async function locateUnitOnMap(kind, unitId) {
  const radio = document.querySelector(`input[name="unit-layer"][value="${kind}"]`);
  if (radio) radio.checked = true;
  if (state.unitLayerKind !== kind || !state.unitCache[kind]) {
    await setUnitLayer(kind);
  }
  const targetBounds = state.unitBoundsCache[kind].get(unitId);
  if (!targetBounds) return;
  // fitBounds's view change isn't always applied synchronously (e.g. when
  // called shortly after other view setup) - wait for the real moveend
  // rather than assume it, with a timeout fallback in case bounds were
  // already satisfied and no moveend fires at all.
  const moved = new Promise((resolve) => map.once("moveend", resolve));
  map.fitBounds(targetBounds, { maxZoom: Math.max(UNIT_CONFIG[kind].minRenderZoom + 2, LABEL_ZOOM[kind] + 1) });
  await Promise.race([moved, new Promise((resolve) => setTimeout(resolve, 500))]);
  refreshUnitLayer();
  const target = state.unitLayerIndex[unitId];
  if (target) target.openPopup();
}

let currentSplitKind = "postcodes";
document.querySelectorAll('input[name="split-type"]').forEach((radio) => {
  radio.addEventListener("change", (e) => {
    currentSplitKind = e.target.value;
    renderSplitTable(currentSplitKind, document.getElementById("split-search").value);
  });
});
document.getElementById("split-search").addEventListener("input", (e) => {
  renderSplitTable(currentSplitKind, e.target.value);
});

// Generic "click this name to jump to it on the map" link, reused anywhere
// a district/postcode/suburb/LGA name is displayed as text.
function districtLinkHTML(districtName, label) {
  return `<span class="district-link" onclick="locateDistrict('${districtName}')">${label}</span>`;
}
function unitLinkHTML(kind, id, label) {
  return `<span class="district-link" onclick="locateUnitOnMap('${kind}', '${id}')">${label}</span>`;
}

// ---------- Lookup panel: postcode -> suburb -> address ----------
function districtRowHTML(d) {
  const margin = d.margin_pct_points != null ? `${d.margin_pct_points}%` : "n/a";
  const tcp = d.winner_pct != null && d.runner_up_pct != null
    ? ` — won ${d.winner_pct}% to ${d.runner_up_pct}% (${d.runner_up_party || "runner-up"})`
    : "";
  return `<div class="district-row">
    <span><span class="swatch" style="background:${d.party_colour}"></span>${districtLinkHTML(d.district, d.district_label)}</span>
    <span>${d.pct_area}%</span>
  </div>
  <div style="font-size:12px;color:#555;margin:-4px 0 6px 16px;">${d.member} (${d.party}), margin ${margin}${tcp}</div>`;
}

function locateDistrict(districtName) {
  let target = null;
  state.districtsLayer.eachLayer((l) => {
    if (l.feature.properties.district_name === districtName) target = l;
  });
  if (!target) return;
  map.fitBounds(target.getBounds(), { maxZoom: 11 });
  target.openPopup();
}

async function handlePostcodeInput(value) {
  const el = document.getElementById("lookup-result");
  const code = value.trim();
  if (!/^\d{4}$/.test(code)) {
    el.innerHTML = code ? `<div class="hint">Enter a 4-digit VIC postcode (3xxx).</div>` : "";
    return;
  }
  const lookup = await getLookup("postcodes");
  const entry = lookup[code];
  if (!entry) {
    el.innerHTML = `<div class="hint">No VIC postcode "${code}" found in this dataset.</div>`;
    return;
  }

  let html = entry.is_split
    ? `<span class="status-badge status-split">Split across ${entry.district_count} districts</span>`
    : `<span class="status-badge status-full">Fully within one district</span>`;
  html += entry.districts.map(districtRowHTML).join("");

  if (entry.is_split) {
    const crosswalk = state.crosswalk || (state.crosswalk = await fetchJSON(DATA + "crosswalk_postcode_suburbs.json", { versioned: true }));
    const suburbs = crosswalk[code] || [];
    if (suburbs.length > 1) {
      html += `<div class="hint">Postcode ${code} spans multiple suburbs — pick yours for a more precise answer:</div>`;
      html += `<select id="suburb-select"><option value="">Select suburb...</option>${suburbs
        .map((s) => `<option value="${s.sal_code}">${s.suburb}</option>`)
        .join("")}</select>`;
    }
  }
  el.innerHTML = html;

  const select = document.getElementById("suburb-select");
  if (select) select.addEventListener("change", (e) => handleSuburbSelect(e.target.value, code));
}

async function handleSuburbSelect(salCode, postcode) {
  const el = document.getElementById("lookup-result");
  if (!salCode) return;
  const lookup = await getLookup("suburbs");
  const entry = lookup[salCode];
  if (!entry) return;

  let html = entry.is_split
    ? `<span class="status-badge status-split">${entry.name} is itself split across ${entry.district_count} districts</span>`
    : `<span class="status-badge status-full">${entry.name} is fully within one district</span>`;
  html += entry.districts.map(districtRowHTML).join("");

  if (entry.is_split) {
    html += `<div class="hint">Still not certain — enter your street address for an exact, point-level match:</div>
      <input id="address-input" type="text" placeholder="e.g. 12 Smith St, ${entry.name}, VIC">
      <button id="address-btn">Find my district</button>
      <div class="attribution">Address search via OpenStreetMap Nominatim.</div>
      <div id="address-result"></div>`;
  }
  el.insertAdjacentHTML("beforeend", `<div id="suburb-result-extra"></div>`);
  document.getElementById("suburb-result-extra").innerHTML = html;

  const btn = document.getElementById("address-btn");
  if (btn) btn.addEventListener("click", () => geocodeAndMatch());
}

let geocodeInFlight = false;
async function geocodeAndMatch() {
  const btn = document.getElementById("address-btn");
  const input = document.getElementById("address-input");
  const resultEl = document.getElementById("address-result");
  if (geocodeInFlight || !input.value.trim()) return;
  geocodeInFlight = true;
  btn.disabled = true;
  btn.textContent = "Searching...";
  resultEl.innerHTML = "";
  try {
    const q = encodeURIComponent(`${input.value}, Victoria, Australia`);
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${q}&countrycodes=au&limit=1`;
    const results = await fetchJSON(url);
    if (!results.length) {
      resultEl.innerHTML = `<div class="hint">Address not found — try adding a suburb or postcode.</div>`;
      return;
    }
    const { lat, lon } = results[0];
    const pt = turf.point([parseFloat(lon), parseFloat(lat)]);
    const match = state.districtsFC.features.find((f) => {
      try {
        return turf.booleanPointInPolygon(pt, f);
      } catch {
        return false;
      }
    });
    if (match) {
      resultEl.innerHTML = `<div class="exact-match">Exact match: <b>${match.properties.district_label}</b><br>${match.properties.member} (${match.properties.party})</div>`;
    } else {
      resultEl.innerHTML = `<div class="hint">That point didn't fall inside any VIC district — check the address.</div>`;
    }
  } catch (err) {
    resultEl.innerHTML = `<div class="hint">Lookup failed: ${err.message}</div>`;
  } finally {
    geocodeInFlight = false;
    btn.disabled = false;
    btn.textContent = "Find my district";
  }
}

document.getElementById("postcode-input").addEventListener("input", (e) => handlePostcodeInput(e.target.value));

// ---------- Farm & slaughterhouse facilities ----------
// Source: Farm Transparency Project's own "Reports / Export Data" CSV export
// (farmtransparency.org/map) - a first-party feature of their site, not
// scraped. See README for the exact source and the processing pipeline.
let farmFacilitiesData = null;
let farmFacilitiesLayer = null;

function farmPopupHTML(p) {
  const statusBadge = p.status === "Open"
    ? `<span class="status-badge status-full">Open</span>`
    : `<span class="status-badge status-split">${p.status || "Status unknown"}</span>`;
  const suburbBit = p.suburb_code
    ? unitLinkHTML("suburbs", p.suburb_code, p.suburb_name || p.suburb_raw)
    : (p.suburb_name || p.suburb_raw || "");
  const postcodeBit = p.postcode_code
    ? unitLinkHTML("postcodes", p.postcode_code, p.postcode_name)
    : (p.postcode_name || "");
  const location = [p.street, suburbBit, postcodeBit].filter(Boolean).join(", ");
  const districtBit = p.district_name ? districtLinkHTML(p.district_name, p.district_label) : "";
  const lgaBit = p.lga_code ? unitLinkHTML("lgas", p.lga_code, p.lga_name) : (p.lga_name || "");
  return `<h3>${p.name}</h3>
    <div style="font-size:11px;color:#888;margin-bottom:4px;">${p.category_label}${p.species ? " — " + p.species : ""}</div>
    ${statusBadge}
    <div style="font-size:12px;margin-top:6px;line-height:1.5;">
      ${location}<br>
      ${districtBit ? `District: <b>${districtBit}</b><br>` : ""}
      ${lgaBit ? `LGA: ${lgaBit}<br>` : ""}
      ${p.owned_by ? `Owned by: ${p.owned_by}<br>` : ""}
    </div>
    <div class="popup-actions"><a href="${p.profile_url}" target="_blank" rel="noopener">Full profile on Farm Transparency Project ↗</a></div>`;
}

let farmCategoryFilter = null; // Set of currently-enabled category labels

function buildFarmCategoryCheckboxes(fc) {
  const seen = new Map();
  fc.features.forEach((f) => {
    if (!seen.has(f.properties.category_label)) seen.set(f.properties.category_label, f.properties.category_colour);
  });
  farmCategoryFilter = new Set(seen.keys());
  const el = document.getElementById("farm-category-list");
  el.innerHTML = "";
  for (const [label, colour] of seen) {
    const row = document.createElement("label");
    row.innerHTML = `<input type="checkbox" checked><span class="swatch" style="background:${colour}"></span>${label}`;
    row.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) farmCategoryFilter.add(label);
      else farmCategoryFilter.delete(label);
      renderFarmLayer();
    });
    el.appendChild(row);
  }
}

function renderFarmLayer() {
  if (farmFacilitiesLayer) map.removeLayer(farmFacilitiesLayer);
  const visible = farmFacilitiesData.features.filter((f) => farmCategoryFilter.has(f.properties.category_label));
  farmFacilitiesLayer = L.geoJSON({ type: "FeatureCollection", features: visible }, {
    pointToLayer: (f, latlng) => L.circleMarker(latlng, {
      radius: 5,
      color: "#fff",
      weight: 1.5,
      fillColor: f.properties.category_colour,
      fillOpacity: 0.9,
    }),
    onEachFeature: (f, l) => l.bindPopup(farmPopupHTML(f.properties), POPUP_OPTIONS),
  });
  farmFacilitiesLayer.addTo(map);
}

async function toggleFarmFacilities(show) {
  const listEl = document.getElementById("farm-category-list");
  if (!show) {
    if (farmFacilitiesLayer) map.removeLayer(farmFacilitiesLayer);
    listEl.hidden = true;
    return;
  }
  if (!farmFacilitiesData) {
    farmFacilitiesData = await fetchJSON(DATA + "vic_farm_facilities.geojson", { versioned: true });
    buildFarmCategoryCheckboxes(farmFacilitiesData);
  }
  renderFarmLayer();
  listEl.hidden = false;
}

document.getElementById("toggle-farms").addEventListener("change", (e) => toggleFarmFacilities(e.target.checked));

// ---------- Global search: district / suburb / postcode / MP ----------
let searchIndex = [];

async function buildSearchIndex() {
  const [postcodes, suburbs] = await Promise.all([getLookup("postcodes"), getLookup("suburbs")]);
  searchIndex = [];
  state.districtsFC.features.forEach((f) => {
    const p = f.properties;
    searchIndex.push({
      type: "District",
      mainText: p.district_label,
      subText: `${p.member} — ${p.party}`,
      searchText: `${p.district_label} ${p.member}`.toLowerCase(),
      districtName: p.district_name,
    });
  });
  for (const code in postcodes) {
    const entry = postcodes[code];
    searchIndex.push({
      type: "Postcode",
      mainText: entry.name,
      subText: entry.districts[0].district_label + (entry.is_split ? " (+more)" : ""),
      searchText: entry.name.toLowerCase(),
      kind: "postcodes",
      id: code,
    });
  }
  for (const code in suburbs) {
    const entry = suburbs[code];
    searchIndex.push({
      type: "Suburb",
      mainText: entry.name,
      subText: entry.districts[0].district_label + (entry.is_split ? " (+more)" : ""),
      searchText: entry.name.toLowerCase(),
      kind: "suburbs",
      id: code,
    });
  }
}

function renderSearchResults(query) {
  const resultsEl = document.getElementById("global-search-results");
  const q = query.trim().toLowerCase();
  if (!q) {
    resultsEl.hidden = true;
    resultsEl.innerHTML = "";
    return;
  }
  const matches = searchIndex.filter((item) => item.searchText.includes(q));
  matches.sort((a, b) => {
    const aStarts = a.searchText.startsWith(q) ? 0 : 1;
    const bStarts = b.searchText.startsWith(q) ? 0 : 1;
    return aStarts - bStarts || a.mainText.localeCompare(b.mainText);
  });
  const top = matches.slice(0, 12);
  resultsEl.innerHTML = top.length
    ? top.map((item, i) => `
      <div class="result" data-idx="${i}">
        <span class="type-tag">${item.type}</span>
        <span><span class="main-text">${item.mainText}</span><br><span class="sub-text">${item.subText}</span></span>
      </div>`).join("")
    : `<div class="no-results">No matches.</div>`;
  top.forEach((item, i) => {
    resultsEl.querySelector(`[data-idx="${i}"]`).addEventListener("click", () => selectSearchResult(item));
  });
  resultsEl.hidden = false;
}

function selectSearchResult(item) {
  document.getElementById("global-search-results").hidden = true;
  document.getElementById("global-search-input").value = item.mainText;
  if (item.type === "District") locateDistrict(item.districtName);
  else locateUnitOnMap(item.kind, item.id);
}

document.getElementById("global-search-input").addEventListener("input", (e) => renderSearchResults(e.target.value));
document.getElementById("global-search-input").addEventListener("focus", (e) => {
  if (e.target.value) renderSearchResults(e.target.value);
});
document.addEventListener("click", (e) => {
  if (!document.getElementById("global-search").contains(e.target)) {
    document.getElementById("global-search-results").hidden = true;
  }
});

// ---------- Init ----------
(async function init() {
  await loadBoundary();
  await loadDistricts();
  await Promise.all([buildSearchIndex(), renderSplitTable(currentSplitKind, "")]);
})();
