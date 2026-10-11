"""Socket.IO client that publishes mocap-frame events to the avatar server."""

from __future__ import annotations

import time

import socketio


def normalize_avatar_url(url):
    # this [2026-09-11] | INFO | publisher.normalize_avatar_url | python-socketio wants http(s) for the handshake
    text = (url or 'http://127.0.0.1:8008').strip()
    if text.startswith('ws://'):
        return 'http://' + text[5:]
    if text.startswith('wss://'):
        return 'https://' + text[6:]
    return text


class MocapPublisher:
    def __init__(self, url, enabled=True):
        self.url = normalize_avatar_url(url)
        self.enabled = enabled
        self.connected = False
        self.last_error = ''
        self.last_status_at = 0.0
        self.sio = socketio.Client(logger=False, engineio_logger=False, reconnection=True)

        @self.sio.event
        def connect():
            self.connected = True
            self.last_error = ''
            print(f'[mocap] connected to {self.url}')

        @self.sio.event
        def disconnect():
            self.connected = False
            print('[mocap] disconnected from avatar server')

        @self.sio.event
        def connect_error(data):
            self.connected = False
            self.last_error = str(data)
            print(f'[mocap] connect error: {data}')

    def set_enabled(self, enabled):
        # this [2026-09-15] | INFO | MocapPublisher.set_enabled | Local viewer can turn the remote /view sink on later
        self.enabled = bool(enabled)
        if not self.enabled:
            self.close()
            return False
        return self.connect()

    def set_url(self, url):
        next_url = normalize_avatar_url(url)
        if next_url == self.url:
            return True
        was_enabled = self.enabled
        self.close()
        self.url = next_url
        self.enabled = was_enabled
        if self.enabled:
            return self.connect()
        return True

    def connect(self):
        if not self.enabled:
            return False
        if self.sio.connected:
            self.connected = True
            return True
        try:
            self.sio.connect(
                self.url,
                transports=['websocket', 'polling'],
                wait_timeout=8,
                socketio_path='socket.io',
            )
            return True
        except Exception as error:
            self.last_error = str(error)
            print(f'[mocap] could not reach {self.url}: {error}')
            return False

    def emit_frame(self, payload):
        if not self.enabled:
            return
        if not self.sio.connected:
            now = time.time()
            if now - self.last_status_at > 3.0:
                self.last_status_at = now
                self.connect()
            return
        try:
            self.sio.emit('mocap-frame', payload)
        except Exception as error:
            self.last_error = str(error)

    def emit_status(self, payload, force=False):
        if not self.enabled:
            return
        now = time.time()
        if not force and now - self.last_status_at < 1.0:
            return
        self.last_status_at = now
        if not self.sio.connected:
            self.connect()
            return
        try:
            self.sio.emit('mocap-status', payload)
        except Exception as error:
            self.last_error = str(error)

    def close(self):
        try:
            if self.sio.connected:
                self.sio.disconnect()
        except Exception:
            pass
