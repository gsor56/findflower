"""Restart through the Pterodactyl-compatible HidenCloud client API."""
import json
import os
import re
import urllib.request
from urllib.parse import urlsplit

base = os.environ['HIDENCLOUD_PANEL_URL'].rstrip('/')
server = os.environ['HIDENCLOUD_SERVER_ID']
if urlsplit(base).scheme != 'https' or urlsplit(base).username or urlsplit(base).query:
    raise SystemExit('HIDENCLOUD_PANEL_URL must be an HTTPS panel URL')
if not re.fullmatch(r'[a-zA-Z0-9-]+', server):
    raise SystemExit('Invalid HIDENCLOUD_SERVER_ID')
request = urllib.request.Request(
    f'{base}/api/client/servers/{server}/power',
    data=json.dumps({'signal': 'restart'}).encode(), method='POST',
    headers={'Authorization': 'Bearer ' + os.environ['HIDENCLOUD_API_KEY'],
             'Content-Type': 'application/json', 'Accept': 'application/json'},
)
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        print('HidenCloud accepted restart:', response.status)
except Exception:
    raise SystemExit('Panel restart failed. Inspect the panel; credentials were not logged.')
