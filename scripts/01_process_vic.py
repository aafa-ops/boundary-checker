"""
Build VIC postcode/suburb/LGA vs state-electoral-district overlap data.

Inputs (data/raw/): ABS ASGS shapefiles (POA/SAL/LGA/STE), VEC district
boundaries + 2022 election results CSV.

Outputs (data/processed/):
  - vic_boundary.geojson, vic_districts.geojson (with member/party/margin)
  - vic_postcodes.geojson, vic_suburbs.geojson, vic_lgas.geojson
    (each carrying is_split / primary_district / district_count properties)
  - lookup_postcodes.json, lookup_suburbs.json, lookup_lgas.json
    (name -> list of {district, district_label, member, party, pct_area})
  - splits_postcodes.csv, splits_suburbs.csv, splits_lgas.csv
    (flat list of only the split ones, for a scan-able table)
"""
import json
from pathlib import Path

import geopandas as gpd
import pandas as pd
import topojson

RAW = Path("data/raw")
OUT = Path("data/processed")
OUT.mkdir(parents=True, exist_ok=True)

AREA_CRS = "EPSG:7899"  # GDA2020 / Vicgrid - for accurate area calcs
WEB_CRS = "EPSG:4326"   # WGS84 - for Leaflet output
FULLY_WITHIN_THRESHOLD = 99.5  # % of a unit's area in one district counts as "fully within"

PARTY_COLOURS = {
    "Australian Labor Party - Victorian Branch": "#E4002B",
    "Liberal": "#0047AB",
    "The Nationals": "#006A4E",
    "Australian Greens": "#1C8A43",
    "Independent": "#888888",
}


def party_colour(party: str) -> str:
    return PARTY_COLOURS.get(party, "#888888")


def load_districts() -> gpd.GeoDataFrame:
    districts = gpd.read_file(RAW / "vec/VEC_STATE_ASSEMBLY_2022_districts.geojson")
    results = pd.read_csv(RAW / "vec/VEC_2022_state_election_results_by_district.csv")
    districts["district_join"] = districts["district_label"].str.replace(
        " District", "", regex=False
    )
    districts = districts.merge(
        results, left_on="district_join", right_on="district", suffixes=("", "_result")
    )
    districts["runner_up_party"] = districts["runner_up_party"].fillna("Independent")
    districts["party_colour"] = districts["party"].map(party_colour)
    districts = districts.rename(columns={"district": "district_name"})
    districts = districts.set_geometry("geometry")
    districts.geometry = districts.geometry.buffer(0)
    return districts.to_crs(AREA_CRS)


def load_vic_boundary() -> gpd.GeoDataFrame:
    ste = gpd.read_file(RAW / "abs/unzipped/ste/STE_2021_AUST_GDA2020.shp")
    vic = ste[ste["STE_CODE21"] == "2"].copy()
    vic.geometry = vic.geometry.buffer(0)
    return vic.to_crs(AREA_CRS)


def load_poa() -> gpd.GeoDataFrame:
    # POA has no state field; VIC postcodes are conventionally the 3xxx/8xxx
    # Australia Post prefixes (8xxx = PO-box-only, no real area, harmless to include).
    poa = gpd.read_file(RAW / "abs/unzipped/poa/POA_2021_AUST_GDA2020.shp")
    poa = poa[poa["POA_CODE21"].str.startswith(("3", "8"))].copy()
    poa.geometry = poa.geometry.buffer(0)
    return poa.to_crs(AREA_CRS)


def load_sal() -> gpd.GeoDataFrame:
    sal = gpd.read_file(RAW / "abs/unzipped/sal/SAL_2021_AUST_GDA2020.shp")
    sal = sal[sal["STE_CODE21"] == "2"].copy()
    sal.geometry = sal.geometry.buffer(0)
    return sal.to_crs(AREA_CRS)


def load_lga() -> gpd.GeoDataFrame:
    lga = gpd.read_file(RAW / "abs/unzipped/lga/LGA_2025_AUST_GDA2020.shp")
    lga = lga[lga["STE_CODE21"] == "2"].copy()
    lga.geometry = lga.geometry.buffer(0)
    return lga.to_crs(AREA_CRS)


def compute_overlap(units: gpd.GeoDataFrame, unit_id: str, unit_name: str,
                     districts: gpd.GeoDataFrame) -> pd.DataFrame:
    """Return long-form df: unit_id, unit_name, district_name, district_label,
    member, party, party_colour, margin_pct_points, pct_area (of the unit)."""
    units = units.copy()
    units["_full_area"] = units.geometry.area

    pieces = gpd.overlay(
        units[[unit_id, unit_name, "_full_area", "geometry"]],
        districts[["district_name", "district_label", "member", "party",
                   "party_colour", "margin_pct_points", "geometry"]],
        how="intersection",
        keep_geom_type=True,
    )
    pieces["_piece_area"] = pieces.geometry.area
    grouped = (
        pieces.groupby([unit_id, unit_name, "district_name", "district_label",
                        "member", "party", "party_colour", "margin_pct_points"],
                       dropna=False)["_piece_area"]
        .sum()
        .reset_index()
    )
    full_area = units[[unit_id, "_full_area"]].drop_duplicates()
    grouped = grouped.merge(full_area, on=unit_id, how="left")
    grouped["pct_area"] = (grouped["_piece_area"] / grouped["_full_area"] * 100).round(2)
    # drop slivers from topology noise
    grouped = grouped[grouped["pct_area"] >= 0.1]
    return grouped.drop(columns=["_piece_area", "_full_area"])


def compute_postcode_suburb_crosswalk(poa: gpd.GeoDataFrame, sal: gpd.GeoDataFrame) -> dict:
    """postcode -> list of suburbs meaningfully within it, each tagged with what
    % of THAT SUBURB's area falls inside the postcode (so the UI can tell a
    suburb that's wholly inside the postcode from one that's mostly elsewhere)."""
    poa = poa[["POA_CODE21", "POA_NAME21", "geometry"]].copy()
    sal = sal[["SAL_CODE21", "SAL_NAME21", "geometry"]].copy()
    sal["_sal_area"] = sal.geometry.area

    pieces = gpd.overlay(poa, sal, how="intersection", keep_geom_type=True)
    pieces["_piece_area"] = pieces.geometry.area
    pieces["pct_of_suburb_in_postcode"] = (
        pieces["_piece_area"] / pieces["_sal_area"] * 100
    ).round(2)
    pieces = pieces[pieces["pct_of_suburb_in_postcode"] >= 1]  # drop negligible slivers

    crosswalk = {}
    for poa_code, group in pieces.groupby("POA_CODE21"):
        group_sorted = group.sort_values("pct_of_suburb_in_postcode", ascending=False)
        crosswalk[str(poa_code)] = [
            {
                "suburb": row.SAL_NAME21,
                "sal_code": row.SAL_CODE21,
                "pct_of_suburb_in_postcode": row.pct_of_suburb_in_postcode,
            }
            for row in group_sorted.itertuples()
        ]
    return crosswalk


def build_lookup_and_flags(overlap_df: pd.DataFrame, unit_id: str, unit_name: str):
    """Returns (lookup dict keyed by unit_id, flags df keyed by unit_id)."""
    lookup = {}
    flag_rows = []
    for uid, group in overlap_df.groupby(unit_id):
        group_sorted = group.sort_values("pct_area", ascending=False)
        name = group_sorted[unit_name].iloc[0]
        entries = [
            {
                "district": row.district_name,
                "district_label": row.district_label,
                "member": row.member,
                "party": row.party,
                "party_colour": row.party_colour,
                "margin_pct_points": None if pd.isna(row.margin_pct_points) else row.margin_pct_points,
                "pct_area": row.pct_area,
            }
            for row in group_sorted.itertuples()
        ]
        top_pct = entries[0]["pct_area"]
        is_split = top_pct < FULLY_WITHIN_THRESHOLD
        lookup[str(uid)] = {
            "name": name,
            "is_split": is_split,
            "district_count": len(entries),
            "districts": entries,
        }
        flag_rows.append({
            unit_id: uid, unit_name: name, "is_split": is_split,
            "primary_district": entries[0]["district_label"],
            "primary_pct": top_pct, "district_count": len(entries),
        })
    return lookup, pd.DataFrame(flag_rows)


def write_splits_csv(overlap_df: pd.DataFrame, flags_df: pd.DataFrame, unit_id: str,
                      unit_name: str, out_path: Path):
    split_ids = flags_df[flags_df["is_split"]][unit_id]
    split_overlap = overlap_df[overlap_df[unit_id].isin(split_ids)].sort_values(
        [unit_name, "pct_area"], ascending=[True, False]
    )
    split_overlap[[unit_name, "district_label", "member", "party", "pct_area"]].to_csv(
        out_path, index=False
    )


def simplify_and_attach(units: gpd.GeoDataFrame, unit_id: str, unit_name: str,
                         flags_df: pd.DataFrame, tolerance_m: float) -> gpd.GeoDataFrame:
    flags_df = flags_df.drop(columns=[unit_name])
    units = units.merge(flags_df, on=unit_id, how="left")
    units.geometry = units.geometry.simplify(tolerance_m, preserve_topology=True)
    return units.to_crs(WEB_CRS)


def main():
    print("Loading VIC boundary and districts...")
    vic_boundary = load_vic_boundary()
    districts = load_districts()

    print("Loading and filtering postcodes/suburbs/LGAs to VIC...")
    poa = load_poa()
    sal = load_sal()
    lga = load_lga()
    print(f"  postcodes: {len(poa)}, suburbs: {len(sal)}, LGAs: {len(lga)}")

    print("Computing postcode <-> suburb crosswalk...")
    crosswalk = compute_postcode_suburb_crosswalk(poa, sal)
    (OUT / "crosswalk_postcode_suburbs.json").write_text(json.dumps(crosswalk))

    print("Computing overlap: postcodes vs districts...")
    poa_overlap = compute_overlap(poa, "POA_CODE21", "POA_NAME21", districts)
    poa_lookup, poa_flags = build_lookup_and_flags(poa_overlap, "POA_CODE21", "POA_NAME21")

    print("Computing overlap: suburbs vs districts...")
    sal_overlap = compute_overlap(sal, "SAL_CODE21", "SAL_NAME21", districts)
    sal_lookup, sal_flags = build_lookup_and_flags(sal_overlap, "SAL_CODE21", "SAL_NAME21")

    print("Computing overlap: LGAs vs districts...")
    lga_overlap = compute_overlap(lga, "LGA_CODE25", "LGA_NAME25", districts)
    lga_lookup, lga_flags = build_lookup_and_flags(lga_overlap, "LGA_CODE25", "LGA_NAME25")

    print("Writing lookups + split CSVs...")
    (OUT / "lookup_postcodes.json").write_text(json.dumps(poa_lookup, indent=None))
    (OUT / "lookup_suburbs.json").write_text(json.dumps(sal_lookup, indent=None))
    (OUT / "lookup_lgas.json").write_text(json.dumps(lga_lookup, indent=None))

    write_splits_csv(poa_overlap, poa_flags, "POA_CODE21", "POA_NAME21", OUT / "splits_postcodes.csv")
    write_splits_csv(sal_overlap, sal_flags, "SAL_CODE21", "SAL_NAME21", OUT / "splits_suburbs.csv")
    write_splits_csv(lga_overlap, lga_flags, "LGA_CODE25", "LGA_NAME25", OUT / "splits_lgas.csv")

    print("Simplifying + writing TopoJSON for the web map...")

    def write_topojson(gdf: gpd.GeoDataFrame, cols: list[str], out_name: str,
                        toposimplify: float = 2):
        gdf = gdf[cols].copy()
        gdf = gdf[~(gdf.geometry.isna() | gdf.geometry.is_empty)]
        # NaN isn't valid JSON (Python's json module emits a bare `NaN` token,
        # which browsers' JSON.parse rejects) - convert to null on non-geometry cols.
        attr_cols = [c for c in gdf.columns if c != "geometry"]
        gdf[attr_cols] = gdf[attr_cols].astype(object).where(gdf[attr_cols].notna(), None)
        topo = topojson.Topology(gdf, prequantize=1e6, toposimplify=toposimplify)
        (OUT / out_name).write_text(topo.to_json())

    write_topojson(vic_boundary.to_crs(WEB_CRS), ["geometry"], "vic_boundary.topojson")

    districts_web = districts.to_crs(WEB_CRS)
    write_topojson(districts_web, [
        "district_name", "district_label", "region_label", "member", "party",
        "party_colour", "winner_pct", "runner_up", "runner_up_party",
        "runner_up_pct", "margin_pct_points", "margin_basis", "geometry"
    ], "vic_districts.topojson")

    poa_web = simplify_and_attach(poa, "POA_CODE21", "POA_NAME21", poa_flags, 5)
    write_topojson(poa_web, ["POA_CODE21", "POA_NAME21", "is_split", "primary_district",
                              "primary_pct", "district_count", "geometry"],
                   "vic_postcodes.topojson")

    sal_web = simplify_and_attach(sal, "SAL_CODE21", "SAL_NAME21", sal_flags, 5)
    write_topojson(sal_web, ["SAL_CODE21", "SAL_NAME21", "is_split", "primary_district",
                             "primary_pct", "district_count", "geometry"],
                   "vic_suburbs.topojson")

    lga_web = simplify_and_attach(lga, "LGA_CODE25", "LGA_NAME25", lga_flags, 5)
    write_topojson(lga_web, ["LGA_CODE25", "LGA_NAME25", "is_split", "primary_district",
                             "primary_pct", "district_count", "geometry"],
                   "vic_lgas.topojson")

    print("Done.")
    print(f"  split postcodes: {poa_flags['is_split'].sum()} / {len(poa_flags)}")
    print(f"  split suburbs:   {sal_flags['is_split'].sum()} / {len(sal_flags)}")
    print(f"  split LGAs:      {lga_flags['is_split'].sum()} / {len(lga_flags)}")


if __name__ == "__main__":
    main()
