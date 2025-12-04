release: python3 manage.py migrate
web: daphne -b 0.0.0.0 -p $PORT backend.asgi:application
worker: python3 manage.py run_ais_bridge_watch
