import json
import math
import random
from functools import lru_cache
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

HERE = Path(__file__).parent
PHOTON_URL = "https://photon.komoot.io/api/"
SYRIA_BBOX = "35.7,32.3,42.4,37.4"  
TEST_CENTER = (33.513, 36.277) #Syria data services 

app = FastAPI(title="Map PoC")
photon = httpx.Client(timeout=5.0, headers={"User-Agent": "map-poc/0.1"})


#Services' data that could be pulled from services.json, otherwise generate
def fake_services(count: int = 400) -> list[dict]:
    center_lat, center_lng = TEST_CENTER
    rng = random.Random(42)  # fixed centre
    services = []
    for i in range(1, count + 1):
        km = 15 * math.sqrt(rng.random())  # within 15 km of the test center
        angle = rng.uniform(0, 2 * math.pi)
        services.append({
            "id": i,
            "name": f"Service {i}",  # the field the endpoint reads
            "lat": round(center_lat + km * math.cos(angle) / 111.32, 5),
            "lng": round(center_lng + km * math.sin(angle)
                         / (111.32 * math.cos(math.radians(center_lat))), 5),
        })
    return services


services_file = HERE / "services.json"
SERVICES = json.loads(services_file.read_text("utf-8")) if services_file.exists() else fake_services()


def distance_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Straight-line distance over the Earth's surface (haversine formula)."""
    dlat, dlng = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(a))


@app.get("/api/services/nearby")
def services_nearby(
    lat: Annotated[float, Query(ge=-90, le=90)],
    lng: Annotated[float, Query(ge=-180, le=180)],
    km: Annotated[float, Query(gt=0, le=50)] = 5,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
):
    nearby = [(distance_km(lat, lng, s["lat"], s["lng"]), s) for s in SERVICES]
    nearby = sorted((pair for pair in nearby if pair[0] <= km), key=lambda pair: pair[0])
    return {
        "type": "FeatureCollection",
        "total_in_radius": len(nearby),
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [s["lng"], s["lat"]]},
                "properties": {"rank": rank, "name": s["name"],
                               "distance_km": round(d, 2)},
            }
            for rank, (d, s) in enumerate(nearby[:limit], start=1)
        ],
    }


#Place search labeling
def label_for(p: dict) -> str:
    street = " ".join(x for x in (p.get("housenumber"), p.get("street")) if x)
    return ", ".join(dict.fromkeys(x for x in (p.get("name"), street, p.get("city")) if x))


@lru_cache(maxsize=1000)  #skipping photon for repeated searches 
def photon_search(q: str, lat: float, lng: float) -> list[dict]:
    resp = photon.get(PHOTON_URL, params={"q": q, "lat": lat, "lon": lng, "limit": 5, "bbox": SYRIA_BBOX})
    resp.raise_for_status()
    return [
        {"label": label_for(f["properties"]),
         "lat": f["geometry"]["coordinates"][1],
         "lng": f["geometry"]["coordinates"][0]}
        for f in resp.json()["features"]
    ]


@app.get("/api/suggest")
def suggest(
    q: Annotated[str, Query(min_length=3, max_length=100)],
    lat: Annotated[float, Query(ge=-90, le=90)] = TEST_CENTER[0],
    lng: Annotated[float, Query(ge=-180, le=180)] = TEST_CENTER[1],
):
    try:
        #similar (within 1 km) searches share cache entries
        return photon_search(q.strip().lower(), round(lat, 2), round(lng, 2))
    except httpx.HTTPError as err:
        print("Photon request failed:", repr(err))
        raise HTTPException(status_code=502, detail=f"Place search is unavailable: {err}")


#Serve the page finally
app.mount("/", StaticFiles(directory=HERE / "static", html=True), name="static")