"""Desktop launcher: run the mocap hub and open the default browser.

this [2026-10-11] | INFO | launcher | PyInstaller entry point. The browser is the UI;
this process only hosts the aiohttp + Socket.IO hub and waits for Ctrl-C.
"""

from __future__ import annotations

import argparse
import socket
import sys
import threading
import time
import webbrowser

from mocap.config import support_dir
from mocap.local_hub import LocalHub, discover_vrm


def free_port(preferred: int) -> int:
    # this [2026-10-11] | INFO | launcher.free_port | Fall forward one port if something else holds the default
    for port in range(preferred, preferred + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            if probe.connect_ex(('127.0.0.1', port)) != 0:
                return port
    return preferred


def open_when_ready(url: str) -> None:
    # this [2026-10-11] | INFO | launcher.open_when_ready | Poll /health so the tab never hits a dead port
    import urllib.request
    for _ in range(120):
        try:
            with urllib.request.urlopen(f'{url}health', timeout=1) as response:
                if response.status == 200:
                    break
        except Exception:
            time.sleep(0.5)
    webbrowser.open(url)


def main() -> None:
    parser = argparse.ArgumentParser(
        prog='Chatter Mocap',
        description='Webcam motion capture for VRM avatars. The viewer opens in your browser.',
    )
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true', help='Do not open a browser tab')
    parser.add_argument('--vrm', default='', help='VRM model to load at startup')
    args = parser.parse_args()

    print(f'[mocap] support dir: {support_dir()}')
    vrm_path = discover_vrm(args.vrm)
    if vrm_path:
        print(f'[mocap] model: {vrm_path.name}')

    hub = LocalHub(
        host='127.0.0.1',
        port=free_port(args.port),
        vrm_path=vrm_path,
        avatar_url='http://127.0.0.1:8008',
    )
    hub.start()
    print(f'[mocap] viewer: {hub.url}  (Ctrl-C to quit)')
    if not args.no_browser:
        threading.Thread(target=open_when_ready, args=(hub.url,), daemon=True).start()
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        hub.close()
        print('[mocap] stopped')


if __name__ == '__main__':
    main()
