import asyncio
import json
import math
import os
import traceback

import websockets
from django.conf import settings
from django.core.management.base import BaseCommand

AISSTREAM_WS = "wss://stream.aisstream.io/v0/stream"

# Big Chicago / Lake Michigan bbox just for debugging
# Format: [[lat_min, lon_min], [lat_max, lon_max]]
CHI_WIDE_BBOX = [[41.4, -88.0], [42.2, -87.0]]

# Your focused box around Calumet
CALUMET_LAT_MIN = 41.65
CALUMET_LAT_MAX = 41.76
CALUMET_LON_MIN = -87.60
CALUMET_LON_MAX = -87.50

# Approx bridge coords (for logging only)
BRIDGES = {
    "100th": (41.7139, -87.5510),
    "106th": (41.7007, -87.5493),
    "92nd": (41.7307, -87.5399),
    "95th": (41.7229, -87.5519),
}

MAX_MESSAGES = 200  # stop after this many PositionReports so your terminal is usable


def haversine(lat1, lon1, lat2, lon2):
    """Distance in meters between two lat/lon points."""
    R = 6371000
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


class Command(BaseCommand):
    help = "Test AISStream subscription over Chicago bbox and print positions"

    def handle(self, *args, **options):
        api_key = getattr(settings, "AISSTREAM_API_KEY", None) or os.environ.get(
            "AISSTREAM_API_KEY"
        )
        if not api_key:
            self.stderr.write("AISSTREAM_API_KEY not set")
            return

        self.stdout.write(f"Using AISSTREAM_API_KEY: {api_key[:6]}******")
        self.stdout.write(
            f"Subscribing to AIS with bbox={CHI_WIDE_BBOX} (Chicago wide debug)"
        )

        try:
            asyncio.run(self.run_test(api_key))
        except KeyboardInterrupt:
            self.stdout.write("Interrupted by user")
        except Exception as e:
            self.stderr.write(f"Fatal error in test_ais_local: {e}")
            traceback.print_exc()

    async def run_test(self, api_key: str):
        sub_msg = {
            "APIKey": api_key,
            "BoundingBoxes": [CHI_WIDE_BBOX],
            "FilterMessageTypes": ["PositionReport"],
        }
        payload_str = json.dumps(sub_msg, separators=(",", ":"))

        self.stdout.write(f"Connecting to AIS stream at {AISSTREAM_WS} ...")
        async with websockets.connect(AISSTREAM_WS) as ws:
            await ws.send(payload_str)
            self.stdout.write("Subscribed to AIS bbox (Chicago wide)")

            count = 0
            async for message in ws:
                try:
                    if isinstance(message, bytes):
                        text = message.decode("utf-8", errors="replace")
                    else:
                        text = str(message)

                    data = json.loads(text)
                    if data.get("MessageType") != "PositionReport":
                        continue

                    body = data.get("Message", {}).get("PositionReport", {})
                    lat = body.get("Latitude")
                    lon = body.get("Longitude")
                    sog = body.get("Sog")
                    cog = body.get("Cog")
                    mmsi = body.get("UserID")
                    # Sometimes ShipName is in MetaData, sometimes in the message body depending on stream format
                    meta_name = data.get("MetaData", {}).get("ShipName") or ""
                    body_name = body.get("ShipName") or ""
                    name = (meta_name or body_name or "Unknown").strip()

                    if lat is None or lon is None:
                        continue

                    count += 1

                    lat_f = float(lat)
                    lon_f = float(lon)
                    sog_f = float(sog) if sog is not None else None

                    # Flags
                    in_calumet = (
                        CALUMET_LAT_MIN <= lat_f <= CALUMET_LAT_MAX
                        and CALUMET_LON_MIN <= lon_f <= CALUMET_LON_MAX
                    )

                    closest_bridge = None
                    closest_dist_m = None
                    for bname, (b_lat, b_lon) in BRIDGES.items():
                        d = haversine(lat_f, lon_f, b_lat, b_lon)
                        if closest_dist_m is None or d < closest_dist_m:
                            closest_dist_m = d
                            closest_bridge = bname

                    # Build a short line
                    flags = []
                    if in_calumet:
                        flags.append("CALUMET")
                    if closest_bridge is not None and closest_dist_m is not None:
                        if closest_dist_m <= 5000:
                            flags.append(f"NEAR_{closest_bridge}({int(closest_dist_m)}m)")

                    flag_str = " | ".join(flags) if flags else ""

                    self.stdout.write(
                        f"[{count}] {name} MMSI={mmsi} "
                        f"@ ({lat_f:.5f},{lon_f:.5f}) "
                        f"SOG={sog_f if sog_f is not None else 'NA'}kts "
                        f"COG={cog if cog is not None else 'NA'} "
                        f"{'| ' + flag_str if flag_str else ''}"
                    )

                    if count >= MAX_MESSAGES:
                        self.stdout.write(
                            f"Hit MAX_MESSAGES={MAX_MESSAGES}, stopping test."
                        )
                        break

                except json.JSONDecodeError as e:
                    self.stderr.write(f"[AIS JSON error] {e}")
                except Exception as e:
                    self.stderr.write(f"[AIS loop error] {e}")
                    traceback.print_exc()
                    continue
