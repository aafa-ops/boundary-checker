"""
Process the Farm Transparency Project's official CSV export (their own
"Reports / Export Data" feature on farmtransparency.org/map, not scraped -
see README) into a VIC-only GeoJSON point layer, with each facility tagged
to the postcode/suburb/LGA/district it falls in via point-in-polygon against
the same boundaries the rest of the site uses.

Source: https://www.farmtransparency.org/map?action=export&report=all
"""
import json
from pathlib import Path

import geopandas as gpd
import pandas as pd

RAW = Path("data/raw/farm-transparency/facilities_australia.csv")
OUT = Path("data/processed/vic_farm_facilities.geojson")
AREA_CRS = "EPSG:7899"
WEB_CRS = "EPSG:4326"

# Order matters: a facility can carry several category tags (e.g.
# "Farm (meat), Slaughterhouse") - first matching bucket wins, priority
# roughly follows campaign relevance (slaughter/processing first).
CATEGORY_BUCKETS = [
    ("Slaughterhouse", "Slaughterhouse", "#8b0000"),
    ("Knackery", "Knackery", "#8b0000"),
    ("Rendering plant", "Rendering plant", "#8b0000"),
    ("Meat processing", "Meat/dairy/egg processing", "#6d4c41"),
    ("processing", "Meat/dairy/egg processing", "#6d4c41"),
    ("Farm (dairy)", "Dairy farm", "#1f6fb2"),
    ("Farm (eggs)", "Egg farm/hatchery", "#e6ac00"),
    ("Hatchery", "Egg farm/hatchery", "#e6ac00"),
    ("Farm (meat)", "Meat farm", "#a0522d"),
    ("Farm (wool)", "Wool farm", "#8d6e63"),
    ("Farm (honey)", "Apiary", "#c98a1f"),
    ("Saleyard", "Saleyard", "#7b2d8b"),
    ("Race", "Racing (track/breeding)", "#00796b"),
    ("Rodeo", "Racing (track/breeding)", "#00796b"),
]
OTHER_BUCKET = ("Other (zoo, pet breeder, experimentation, etc.)", "#757575")


def bucket_for(categories: str):
    cats = categories or ""
    for needle, label, colour in CATEGORY_BUCKETS:
        if needle.lower() in cats.lower():
            return label, colour
    return OTHER_BUCKET


def load_polygon_layer(path: str, id_prop: str, name_prop: str):
    gdf = gpd.read_file(path)
    return gdf[[id_prop, name_prop, "geometry"]].rename(
        columns={id_prop: "_id", name_prop: "_name"}
    )


def main():
    df = pd.read_csv(RAW)
    vic = df[df["State"] == "VIC"].copy()
    vic = vic.dropna(subset=["Lat", "Lng"])
    print(f"VIC facilities: {len(vic)}")

    gdf = gpd.GeoDataFrame(
        vic,
        geometry=gpd.points_from_xy(vic["Lng"], vic["Lat"]),
        crs=WEB_CRS,
    ).to_crs(AREA_CRS)

    layers = {
        "postcode": load_polygon_layer(
            "data/raw/abs/unzipped/poa/POA_2021_AUST_GDA2020.shp", "POA_CODE21", "POA_NAME21"
        ),
        "suburb": load_polygon_layer(
            "data/raw/abs/unzipped/sal/SAL_2021_AUST_GDA2020.shp", "SAL_CODE21", "SAL_NAME21"
        ),
        "lga": load_polygon_layer(
            "data/raw/abs/unzipped/lga/LGA_2025_AUST_GDA2020.shp", "LGA_CODE25", "LGA_NAME25"
        ),
    }
    for key, poly in layers.items():
        poly.geometry = poly.geometry.buffer(0)
        joined = gpd.sjoin(gdf, poly[["_name", "geometry"]], how="left", predicate="within")
        gdf[f"{key}_name"] = joined["_name"].values
        gdf = gdf[~gdf.index.duplicated(keep="first")]

    districts = gpd.read_file("data/raw/vec/VEC_STATE_ASSEMBLY_2022_districts.geojson").to_crs(AREA_CRS)
    districts.geometry = districts.geometry.buffer(0)
    joined = gpd.sjoin(gdf, districts[["district_label", "geometry"]], how="left", predicate="within")
    gdf["district_label"] = joined["district_label"].values
    gdf = gdf[~gdf.index.duplicated(keep="first")]

    buckets = gdf["Categories"].apply(bucket_for)
    gdf["category_label"] = buckets.apply(lambda x: x[0])
    gdf["category_colour"] = buckets.apply(lambda x: x[1])

    gdf = gdf.to_crs(WEB_CRS)
    out_cols = [
        "Id", "Name", "Categories", "Species", "category_label", "category_colour",
        "Last Known Status", "Street", "Suburb", "State", "Postcode",
        "postcode_name", "suburb_name", "lga_name", "district_label",
        "Owned By", "Contracted To", "Profile URL", "geometry",
    ]
    gdf = gdf[out_cols].rename(columns={
        "Id": "id", "Name": "name", "Categories": "categories", "Species": "species",
        "Last Known Status": "status", "Street": "street", "Suburb": "suburb_raw",
        "State": "state", "Postcode": "postcode_raw", "Owned By": "owned_by",
        "Contracted To": "contracted_to", "Profile URL": "profile_url",
    })
    attr_cols = [c for c in gdf.columns if c != "geometry"]
    gdf[attr_cols] = gdf[attr_cols].astype(object).where(gdf[attr_cols].notna(), None)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(gdf.to_json())
    print(f"Wrote {OUT} ({len(gdf)} facilities)")
    print(gdf["category_label"].value_counts())


if __name__ == "__main__":
    main()
