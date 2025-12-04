import asyncio
import contextlib
import json
import math
import os
import traceback
from datetime import timedelta

import websockets
from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone as dj_tz

from app.models import Bridge, BridgeStatus


AISSTREAM_WS = "wss://stream.aisstream.io/v0/stream"

# Chicago-wide bbox used for intake
# Format: [[lat_min, lon_min], [lat_max, lon_max]]
CHI_WIDE_BBOX = [[41.4, -88.0], [42.2, -87.0]]

# Kept around in case you want to switch to truly global
GLOBAL_BBOX = [[-90.0, -180.0], [90.0, 180.0]]

# Focused Calumet corridor for our own region checks
# Slightly extended north/south from where the river hits the lake,
# through Lake Calumet and down toward the Little Calumet.
CALUMET_LAT_MIN = 41.63
CALUMET_LAT_MAX = 41.78
CALUMET_LON_MIN = -87.62
CALUMET_LON_MAX = -87.50

# Radius around each bridge within which we consider a vessel “approaching”
APPROACH_RADIUS_M = 5000  # 5 km

# Skip very fast movers (likely not river barges)
MAX_SPEED_KNOTS_FOR_PREDICTION = 15.0

# How long we keep a predicted lift before we assume it's stale
PREDICTION_STALE_MINUTES = 30

# How often to log that we are still receiving AIS
MSG_COUNTER_LOG_INTERVAL = 50

# Turn this on if you want very verbose logging
DEBUG_AIS = False


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
    help = "Subscribe to AIS stream (Chicago-wide) and update bridge lift predictions for Calumet region"

    def handle(self, *args, **options):
        self.stdout.write("Ensuring BridgeStatus rows exist for all bridges...")
        with transaction.atomic():
            for b in Bridge.objects.all():
                BridgeStatus.objects.get_or_create(
                    bridge=b,
                    defaults={
                        "status": "unknown",
                        "reason": "initial_seed",
                        "eta_minutes": None,
                        "last_vessel_name": "",
                        "last_vessel_mmsi": "",
                        "last_vessel_direction": "",
                        "updated_at": dj_tz.now(),
                    },
                )
        self.stdout.write("BridgeStatus baseline ensured.")

        asyncio.run(self.run_loop())

    async def run_loop(self):
        api_key = getattr(settings, "AISSTREAM_API_KEY", None) or os.environ.get(
            "AISSTREAM_API_KEY"
        )
        if not api_key:
            self.stderr.write("AISSTREAM_API_KEY not set")
            return

        self.stdout.write(f"Using AISSTREAM_API_KEY: {api_key[:6]}******")

        while True:
            try:
                await self._connect_and_stream(api_key)
            except Exception as e:
                self.stderr.write(f"AIS worker error (outer loop): {e}")
                traceback.print_exc()
                await asyncio.sleep(5)

    async def _connect_and_stream(self, api_key: str):
        self.stdout.write(f"Connecting to AIS stream at {AISSTREAM_WS} ...")

        # Intake Chicago-wide, then filter down to Calumet in our own logic
        sub_msg = {
            "APIKey": api_key,
            "BoundingBoxes": [CHI_WIDE_BBOX],
            "FilterMessageTypes": ["PositionReport"],
        }

        payload_str = json.dumps(sub_msg, separators=(",", ":"))
        self.stdout.write(
            f"Subscribing to AIS with bbox={CHI_WIDE_BBOX} (Chicago wide intake; Calumet-only processing)"
        )

        async with websockets.connect(AISSTREAM_WS) as ws:
            await ws.send(payload_str)
            self.stdout.write("Subscribed to AIS stream")

            # Static bridge list for this connection
            bridges = await asyncio.to_thread(lambda: list(Bridge.objects.all()))
            if bridges:
                self.stdout.write(
                    "Watching bridges: "
                    + ", ".join(
                        f"{b.slug}({b.latitude},{b.longitude})" for b in bridges
                    )
                )
            else:
                self.stdout.write("⚠️ No Bridge rows found in DB.")

            # background task to clear stale predictions
            staleness_task = asyncio.create_task(self._staleness_watcher())

            msg_count = 0

            try:
                async for message in ws:
                    try:
                        # Normalize to text
                        if isinstance(message, bytes):
                            text = message.decode("utf-8", errors="replace")
                        else:
                            text = str(message)

                        if DEBUG_AIS:
                            snippet = text
                            if len(snippet) > 300:
                                snippet = snippet[:300] + "...[truncated]"
                            self.stdout.write(f"[AIS WS RAW] {snippet}")

                        try:
                            payload = json.loads(text)
                        except json.JSONDecodeError as e:
                            self.stderr.write(f"[AIS JSON error] {e}: {text[:200]}")
                            continue

                        msg_type = payload.get("MessageType")
                        if msg_type != "PositionReport":
                            continue

                        msg = payload.get("Message") or {}
                        body = msg.get("PositionReport") or msg

                        lat = body.get("Latitude")
                        lon = body.get("Longitude")
                        sog = body.get("Sog")
                        heading = body.get("Cog")
                        mmsi = body.get("UserID")

                        # ShipName can show up either in MetaData or body depending on stream format
                        meta_name = payload.get("MetaData", {}).get("ShipName") or ""
                        body_name = body.get("ShipName") or ""
                        vessel_name = (meta_name or body_name or "Unknown vessel").strip()

                        if lat is None or lon is None:
                            continue

                        lat_f = float(lat)
                        lon_f = float(lon)
                        sog_f = float(sog) if sog is not None else None

                        msg_count += 1
                        if msg_count % MSG_COUNTER_LOG_INTERVAL == 0:
                            self.stdout.write(
                                f"[AIS] Received {msg_count} PositionReports this session"
                            )

                        # Only process ships in the Calumet corridor
                        in_calumet = (
                            CALUMET_LAT_MIN <= lat_f <= CALUMET_LAT_MAX
                            and CALUMET_LON_MIN <= lon_f <= CALUMET_LON_MAX
                        )
                        if not in_calumet:
                            # Ignore all non-Calumet traffic
                            continue

                        self.stdout.write(
                            f"[AIS] CALUMET-CANDIDATE: {vessel_name} @ "
                            f"({lat_f},{lon_f}) sog={sog_f}"
                        )

                        if DEBUG_AIS:
                            self.stdout.write(
                                f"[AIS] PositionReport lat={lat_f} lon={lon_f} "
                                f"sog={sog_f} heading={heading} mmsi={mmsi} name='{vessel_name}'"
                            )

                        # Optional skip for very fast movers (ocean / lake traffic) – keep this
                        # but only when we have SOG
                        if sog_f is not None and sog_f > MAX_SPEED_KNOTS_FOR_PREDICTION:
                            continue

                        # Now compute distance to each bridge and mark any close approaches
                        for b in bridges:
                            if b.latitude is None or b.longitude is None:
                                continue

                            dist_m = haversine(lat_f, lon_f, b.latitude, b.longitude)

                            if DEBUG_AIS:
                                self.stdout.write(
                                    f"[AIS] Dist to {b.slug}: {int(dist_m)}m "
                                    f"(radius {APPROACH_RADIUS_M}m)"
                                )

                            if dist_m > APPROACH_RADIUS_M:
                                continue

                            # SOG in knots; convert to m/s
                            eta_minutes = None
                            if sog_f is not None:
                                speed_ms = sog_f * 0.514444
                                if speed_ms > 0.5:
                                    eta_minutes = int(dist_m / speed_ms / 60)
                                    eta_minutes = max(1, min(60, eta_minutes))

                            direction = "unknown"
                            if heading is not None:
                                try:
                                    # you can tweak this split later if needed
                                    hdg = float(heading)
                                    if 0 <= hdg <= 180:
                                        direction = "upbound"
                                    else:
                                        direction = "downbound"
                                except (TypeError, ValueError):
                                    pass

                            self.stdout.write(
                                f"[AIS] Vessel near {b.name} — {vessel_name} "
                                f"dist≈{int(dist_m)}m sog={sog_f if sog_f is not None else 'NA'}kts "
                                f"eta≈{eta_minutes if eta_minutes is not None else 'NA'}min "
                                f"dir={direction}"
                            )

                            # Update DB in a thread pool so we don't block the event loop
                            await asyncio.to_thread(
                                self._update_bridge_status,
                                b,
                                eta_minutes,
                                vessel_name,
                                str(mmsi),
                                direction,
                            )

                    except websockets.ConnectionClosed as e:
                        self.stderr.write(f"[AIS] WebSocket closed: {e}")
                        break
                    except Exception as e:
                        self.stderr.write(f"[AIS] Loop error: {e}")
                        traceback.print_exc()
                        continue
            finally:
                staleness_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await staleness_task

        self.stderr.write("[AIS] WebSocket disconnected, will reconnect...")

    async def _staleness_watcher(self):
        """
        Periodically clear out stale 'predicted_lift' statuses so the UI
        doesn't show old predictions forever.
        """
        while True:
            try:
                await asyncio.sleep(60)  # run roughly once a minute
                cutoff = dj_tz.now() - timedelta(minutes=PREDICTION_STALE_MINUTES)

                def expire():
                    stale_qs = BridgeStatus.objects.filter(
                        status="predicted_lift", updated_at__lt=cutoff
                    )
                    count = stale_qs.count()
                    if count:
                        stale_qs.update(
                            status="open",
                            eta_minutes=None,
                            reason="prediction_stale",
                            updated_at=dj_tz.now(),
                        )
                    return count

                count = await asyncio.to_thread(expire)
                if count:
                    self.stdout.write(
                        f"[AIS] Cleared {count} stale predicted_lift statuses "
                        f"(>{PREDICTION_STALE_MINUTES} minutes old)."
                    )
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.stderr.write(f"[AIS] Staleness watcher error: {e}")
                traceback.print_exc()
                continue

    @staticmethod
    @transaction.atomic
    def _update_bridge_status(bridge, eta_minutes, vessel_name, mmsi, direction):
        status, _ = BridgeStatus.objects.select_for_update().get_or_create(
            bridge=bridge,
            defaults={"status": "unknown"},
        )
        status.status = "predicted_lift"
        status.eta_minutes = eta_minutes
        status.last_vessel_name = vessel_name
        status.last_vessel_mmsi = mmsi
        status.last_vessel_direction = direction
        status.reason = "ais_vessel_approach"
        status.updated_at = dj_tz.now()
        status.save()
