# bridges/management/commands/seed_bridges.py
from django.core.management.base import BaseCommand
from app.models import Bridge

# Lat/Lon all sit inside the Calumet truth box the AIS worker uses
BRIDGE_SEED = [
    ("95th", "95th St Bridge (Calumet River)", 41.7229, -87.5519),
    ("100th", "100th St Bridge (Calumet River)", 41.7139, -87.5510),
    ("106th", "106th St Bridge (Calumet River)", 41.7007, -87.5493),
    ("92nd", "92nd St Bridge (Ewing Ave)", 41.7307, -87.5399),
]


class Command(BaseCommand):
    help = "Seed or update Calumet bridge rows used by AIS prediction"

    def handle(self, *args, **options):
        for slug, name, lat, lon in BRIDGE_SEED:
            obj, created = Bridge.objects.update_or_create(
                slug=slug,
                defaults={
                    "name": name,
                    "latitude": lat,
                    "longitude": lon,
                },
            )
            action = "Created" if created else "Updated"
            self.stdout.write(self.style.SUCCESS(f"{action} bridge: {obj.slug} ({obj.name})"))
