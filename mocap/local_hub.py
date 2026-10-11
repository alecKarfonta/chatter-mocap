"""Local HTTP + Socket.IO hub for the standalone VRM viewer."""

from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import threading
import time
import urllib.request
from pathlib import Path

from aiohttp import web
import socketio

from mocap.config import (
    calibration_path,
    load_calibration,
    profile_path,
    read_json,
    recording_dir,
    save_calibration,
    support_dir,
    vrm_dir,
    vrm_search_dirs,
    write_json,
)
from mocap.protocol import (
    ChannelMerger,
    _xyz,
    comparison_table,
    fit_arm_map,
    measure_pose,
    normalize_frame,
    validate_frame,
)

SAMPLE_VRM_URL = (
    'https://pixiv.github.io/three-vrm/packages/three-vrm/'
    'examples/models/VRM1_Constraint_Twist_Sample.vrm'
)
# this [2026-10-11] | INFO | local_hub.defaultVrm | Standalone repo: no bundled personal model; first run downloads the pixiv sample
DEFAULT_VIEW_VRM = ''
VIEWER_DIR = Path(__file__).resolve().parent / 'viewer'
REPO_PUBLIC = Path(__file__).resolve().parents[1] / 'avatar' / 'public'
BUNDLED_LIB = Path(__file__).resolve().parent / 'viewer_lib'
VENDOR_DIR = VIEWER_DIR / 'vendor'

# this [2026-10-06] | INFO | local_hub.CDN_MAP | When the app bundles vendor libs the viewer runs with no internet
IMPORT_MAP = {
    'https://cdn.socket.io/4.7.5/socket.io.min.js': '/vendor/socket.io.min.js',
    'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js': '/vendor/three/build/three.module.js',
    'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/': '/vendor/three/examples/jsm/',
    'https://cdn.jsdelivr.net/npm/@pixiv/three-vrm@3.4.4/lib/three-vrm.module.min.js': '/vendor/three-vrm/three-vrm.module.min.js',
}


def resolve_public():
    # this [2026-09-25] | INFO | local_hub.resolve_public | Mac app bundles a copy; the repo serves avatar/public
    if (BUNDLED_LIB / 'mocap' / 'retargeter.js').exists():
        return BUNDLED_LIB
    if (REPO_PUBLIC / 'mocap' / 'retargeter.js').exists():
        return REPO_PUBLIC
    return REPO_PUBLIC


def rewrite_viewer_html(html: str) -> str:
    # this [2026-10-06] | INFO | local_hub.rewrite_viewer_html | Point CDN URLs at bundled vendor files when present
    if not (VENDOR_DIR / 'socket.io.min.js').is_file():
        return html
    for cdn, local in IMPORT_MAP.items():
        html = html.replace(cdn, local)
    return html


def discover_vrm(explicit='', avatar_url=''):
    candidates = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    env_path = os.environ.get('CHATTER_VRM') or os.environ.get('MOCAP_VRM')
    if env_path:
        candidates.append(Path(env_path).expanduser())
    for folder in vrm_search_dirs():
        if not folder.is_dir():
            continue
        if DEFAULT_VIEW_VRM:
            preferred = folder / DEFAULT_VIEW_VRM
            if preferred.is_file():
                candidates.append(preferred)
        candidates.extend(sorted(folder.glob('*.vrm')))
    for path in candidates:
        if path.is_file() and path.suffix.lower() == '.vrm':
            return path
    return None


class LocalHub:
    def __init__(
        self,
        host='127.0.0.1',
        port=8765,
        vrm_path=None,
        avatar_url='http://127.0.0.1:8008',
        remote_enabled=False,
        device='cpu',
        mirror=False,
        publisher=None,
        runtime=None,
    ):
        self.host = host
        self.port = int(port)
        self.vrm_path = Path(vrm_path).expanduser() if vrm_path else None
        self.avatar_url = avatar_url
        self.remote_enabled = bool(remote_enabled)
        self.device = device
        self.mirror = bool(mirror)
        self.publisher = publisher
        self.runtime = runtime
        self.loop = None
        self.thread = None
        self.ready = threading.Event()
        self.last_error = ''
        self.merger = ChannelMerger()
        self.sources = {}
        self.calibration = load_calibration()
        self.neutral = {'counting': False, 'samples': [], 'started': 0.0}
        self.recording = None
        self.replay_stop = None
        self.sio = socketio.AsyncServer(async_mode='aiohttp', cors_allowed_origins='*')
        self.app = web.Application(client_max_size=80 * 1024 * 1024)
        self.sio.attach(self.app)
        self._bind_routes()
        self.sio.on('connect', self._on_connect)
        self.sio.on('mocap-frame', self._on_client_frame)

    @property
    def url(self):
        return f'http://{self.host}:{self.port}/'

    def _bind_routes(self):
        self.app.router.add_get('/', self.handle_index)
        self.app.router.add_get('/health', self.handle_health)
        self.app.router.add_get('/api/config', self.handle_config)
        self.app.router.add_get('/api/app/state', self.handle_app_state)
        self.app.router.add_post('/api/ingest', self.handle_ingest)
        self.app.router.add_get('/api/vrms', self.handle_vrms_get)
        self.app.router.add_post('/api/vrms', self.handle_vrms_post)
        self.app.router.add_delete('/api/vrms/{name}', self.handle_vrms_delete)
        self.app.router.add_post('/api/vrms/select', self.handle_vrms_select)
        self.app.router.add_get('/api/profiles/{name}', self.handle_profile_get)
        self.app.router.add_put('/api/profiles/{name}', self.handle_profile_put)
        self.app.router.add_get('/api/calibration', self.handle_calibration_get)
        self.app.router.add_put('/api/calibration', self.handle_calibration_put)
        self.app.router.add_post('/api/calibration/neutral', self.handle_neutral)
        self.app.router.add_post('/api/calibration/pose', self.handle_pose)
        self.app.router.add_get('/api/sources', self.handle_sources)
        self.app.router.add_post('/api/target', self.handle_target)
        self.app.router.add_post('/api/record/start', self.handle_record_start)
        self.app.router.add_post('/api/record/stop', self.handle_record_stop)
        self.app.router.add_get('/api/recordings', self.handle_recordings)
        self.app.router.add_post('/api/recordings/play', self.handle_replay)
        self.app.router.add_get('/api/tune', self.handle_tune_get)
        self.app.router.add_post('/api/tune', self.handle_tune_post)
        self.app.router.add_get('/api/calibrate', self.handle_calibration_get)
        self.app.router.add_post('/api/calibrate', self.handle_neutral)
        self.app.router.add_get('/model.vrm', self.handle_model)
        self.app.router.add_get('/mocap/{name}', self.handle_mocap_js)
        self.app.router.add_get('/lib/{name}', self.handle_lib)
        # this [2026-10-06] | INFO | LocalHub._bind_routes | Vendor libs let the packaged app render offline
        if (VENDOR_DIR / 'socket.io.min.js').is_file():
            self.app.router.add_static('/vendor/', VENDOR_DIR, show_index=False)
        self.app.router.add_static('/static/', VIEWER_DIR, show_index=False)

    async def _on_connect(self, sid, environ=None, auth=None):
        await self.sio.emit('mocap-config', self._config(), to=sid)

    async def _on_client_frame(self, sid, data):
        # this [2026-09-25] | INFO | LocalHub._on_client_frame | Browser source streams v1 frames into the merger
        frame = self._accept(data, source=(data or {}).get('source') or 'browser')
        if frame is None:
            return
        await self.sio.emit('mocap-frame', frame)

    def _config(self):
        vrm = self.vrm_path
        return {
            'remote': self.remote_enabled,
            'avatar': self.avatar_url,
            'device': self.device,
            'mirror': self.mirror,
            'vrm': '/model.vrm',
            'vrmName': vrm.name if vrm else '',
            'url': self.url,
            'calibration': self.calibration,
            'sources': self._source_snapshot(),
        }

    def _source_snapshot(self):
        now = time.time() * 1000
        out = {}
        for name, info in self.sources.items():
            out[name] = {
                'fps': info.get('fps') or 0,
                'lastAt': info.get('lastAt') or 0,
                'latencyMs': max(0, now - (info.get('lastAt') or now)),
                'state': info.get('state') or 'idle',
            }
        return out

    def _note_source(self, frame, status=None):
        name = frame.get('source') or 'unknown'
        info = self.sources.setdefault(name, {'count': 0, 'window': time.time(), 'fps': 0})
        info['lastAt'] = frame.get('t') or int(time.time() * 1000)
        info['count'] = info.get('count', 0) + 1
        elapsed = time.time() - info['window']
        if elapsed >= 1:
            info['fps'] = round(info['count'] / elapsed, 1)
            info['count'] = 0
            info['window'] = time.time()
        if isinstance(status, dict):
            info['state'] = status.get('state') or info.get('state')
            if status.get('fps'):
                info['fps'] = status['fps']
        else:
            info['state'] = 'live'

    def _accept(self, raw, source=None):
        try:
            frame = normalize_frame(raw, source=source)
        except ValueError:
            return None
        errors = validate_frame(frame)
        if errors:
            return None
        if self.neutral.get('counting') and frame.get('body'):
            self.neutral['samples'].append(frame['body']['joints'])
        merged = self.merger.push(frame)
        merged['calibration'] = self.calibration
        self._note_source(frame)
        self._record(merged)
        if self.publisher is not None and getattr(self.publisher, 'enabled', False):
            self.publisher.emit_frame(merged)
        return merged

    def ingest_local(self, frame, status=None):
        merged = self._accept(frame, source=frame.get('source') if isinstance(frame, dict) else 'python')
        if merged is None:
            return
        self._emit('mocap-frame', merged)
        if status is not None:
            self.emit_status(status)

    def _record(self, frame):
        handle = self.recording
        if handle is None:
            return
        try:
            handle.write(json.dumps(frame) + '\n')
        except Exception:
            self.recording = None

    async def handle_index(self, request):
        html = (VIEWER_DIR / 'index.html').read_text()
        # this [2026-10-06] | INFO | LocalHub.handle_index | Serve vendored CDN deps when the app bundles them
        return web.Response(text=rewrite_viewer_html(html), content_type='text/html')

    async def handle_health(self, request):
        return web.json_response({
            'ok': True,
            'url': self.url,
            'hub': 'chatter-mocap',
            'version': '1.0.0',
            'protocol': 1,
            'calibrated': bool(self.calibration),
            # this [2026-10-06] | INFO | LocalHub.handle_health | Native app waits for this flag before loading the viewer
            'loop': 'ready',
        })

    async def handle_app_state(self, request):
        # this [2026-10-06] | INFO | LocalHub.handle_app_state | One poll for the native app's status bar: sources, calibration, remote
        calib = self.calibration or {}
        # this [2026-10-11] | INFO | handle_app_state.vrms | Model list for the native File → Switch Model menu
        vrms = [{'name': entry['name']} for entry in self._list_vrms()]
        return web.json_response({
            'sources': self._source_snapshot(),
            'calibrated': bool(calib.get('armMap')),
            'neutral': bool(calib.get('neutral')),
            'poses': sorted((calib.get('poses') or {}).keys()),
            'remote': self.remote_enabled,
            'avatar': self.avatar_url,
            'vrm': self.vrm_path.name if self.vrm_path else '',
            'vrms': vrms,
            'recording': self.recording is not None,
        })

    async def handle_config(self, request):
        return web.json_response(self._config())

    async def handle_ingest(self, request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({'ok': False, 'error': 'invalid json'}, status=400)
        frame = self._accept(body, source=(body or {}).get('source') or 'vision')
        if frame is None:
            return web.json_response({'ok': False, 'error': 'invalid frame'}, status=400)
        self._emit('mocap-frame', frame)
        status = body.get('status') if isinstance(body, dict) else None
        if isinstance(status, dict):
            self.emit_status(status)
        return web.json_response({'ok': True})

    def _list_vrms(self):
        found = {}
        for folder in vrm_search_dirs():
            if not folder.is_dir():
                continue
            for path in sorted(folder.glob('*.vrm')):
                found[path.name] = {
                    'name': path.name,
                    'path': str(path),
                    'bytes': path.stat().st_size,
                    'selected': bool(self.vrm_path and self.vrm_path.name == path.name),
                }
        return list(found.values())

    async def handle_vrms_get(self, request):
        return web.json_response({'files': self._list_vrms(), 'selected': self.vrm_path.name if self.vrm_path else ''})

    async def handle_vrms_post(self, request):
        reader = await request.multipart()
        field = await reader.next()
        if field is None:
            raise web.HTTPBadRequest(text='Choose a .vrm file')
        filename = Path(field.filename or 'upload.vrm').name
        if not filename.lower().endswith('.vrm'):
            raise web.HTTPBadRequest(text='File must be a .vrm')
        dest = vrm_dir() / filename
        with dest.open('wb') as handle:
            while True:
                chunk = await field.read_chunk()
                if not chunk:
                    break
                handle.write(chunk)
        self.vrm_path = dest
        self._emit('mocap-vrm-changed', {'vrm': '/model.vrm', 'vrmName': dest.name})
        return web.json_response({'files': self._list_vrms(), 'selected': dest.name})

    async def handle_vrms_delete(self, request):
        name = Path(request.match_info['name']).name
        dest = vrm_dir() / name
        if dest.is_file():
            dest.unlink()
        if self.vrm_path and self.vrm_path.name == name:
            self.vrm_path = discover_vrm()
        return web.json_response({'files': self._list_vrms()})

    async def handle_vrms_select(self, request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = Path((body.get('name') or '')).name
        chosen = None
        for item in self._list_vrms():
            if item['name'] == name:
                chosen = Path(item['path'])
                break
        if chosen is None or not chosen.is_file():
            raise web.HTTPNotFound(text='VRM not found')
        self.vrm_path = chosen
        self._emit('mocap-vrm-changed', {'vrm': '/model.vrm', 'vrmName': chosen.name})
        return web.json_response(self._config())

    async def handle_profile_get(self, request):
        name = Path(request.match_info['name']).name
        return web.json_response(read_json(profile_path(name), {'v': 1, 'vrm': Path(name).stem}))

    async def handle_profile_put(self, request):
        name = Path(request.match_info['name']).name
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            raise web.HTTPBadRequest(text='profile must be an object')
        body['v'] = 1
        body['vrm'] = Path(name).stem
        write_json(profile_path(name), body)
        self._emit('mocap-profile', body)
        return web.json_response(body)

    async def handle_calibration_get(self, request):
        data = dict(self.calibration or {'rest': None})
        data['compare'] = comparison_table(data.get('poses') or {}, data.get('armMap'))
        return web.json_response(data)

    async def handle_calibration_put(self, request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict) or not isinstance(body.get('rest'), dict):
            raise web.HTTPBadRequest(text='rest joints required')
        self.calibration = save_calibration(body)
        self._emit('mocap-calibration', self.calibration)
        return web.json_response(self.calibration)

    async def handle_neutral(self, request):
        # this [2026-09-25] | INFO | LocalHub.handle_neutral | Average the live body for about a second
        try:
            body = await request.json()
        except Exception:
            body = {}
        action = (body.get('action') or 'capture').strip()
        if action in ('start', 'capture', 'reset'):
            self.neutral = {'counting': True, 'samples': [], 'started': time.time()}
            await asyncio.sleep(1.1)
            samples = self.neutral['samples']
            self.neutral['counting'] = False
            if len(samples) < 5:
                return web.json_response({'ok': False, 'error': 'not enough frames'}, status=409)
            keys = set()
            for joints in samples:
                keys.update(joints)
            rest = {}
            for name in keys:
                pts = [joints[name] for joints in samples if name in joints]
                if not pts:
                    continue
                rest[name] = {
                    'x': sum(p[0] for p in pts) / len(pts),
                    'y': sum(p[1] for p in pts) / len(pts),
                    'z': sum(p[2] for p in pts) / len(pts),
                }
            left = rest.get('leftShoulder')
            right = rest.get('rightShoulder')
            span = 1.0
            if left and right:
                span = ((left['x'] - right['x']) ** 2 + (left['y'] - right['y']) ** 2 + (left['z'] - right['z']) ** 2) ** 0.5
            existing = self.calibration or {}
            self.calibration = save_calibration({
                'rest': rest,
                'bodyScale': span,
                'neutral': True,
                'poses': existing.get('poses'),
                'armMap': existing.get('armMap'),
            })
            self._emit('mocap-calibration', self.calibration)
            return web.json_response(self.calibration)
        if action == 'clear':
            calibration_path().unlink(missing_ok=True)
            self.calibration = None
            self._emit('mocap-calibration', {'rest': None})
            return web.json_response({'ok': True})
        raise web.HTTPBadRequest(text='action must be capture or clear')

    async def _average_body(self):
        self.neutral = {'counting': True, 'samples': [], 'started': time.time()}
        await asyncio.sleep(1.1)
        samples = self.neutral['samples']
        self.neutral['counting'] = False
        if len(samples) < 5:
            return None
        keys = set()
        for joints in samples:
            keys.update(joints)
        averaged = {}
        for name in keys:
            pts = [joints[name] for joints in samples if isinstance(joints.get(name), (list, tuple))]
            if not pts:
                continue
            averaged[name] = {
                'x': sum(p[0] for p in pts) / len(pts),
                'y': sum(p[1] for p in pts) / len(pts),
                'z': sum(p[2] for p in pts) / len(pts),
            }
        return averaged

    async def handle_pose(self, request):
        # this [2026-09-28] | INFO | LocalHub.handle_pose | Average one known arm pose, then fit when all three exist
        try:
            body = await request.json()
        except Exception:
            body = {}
        pose = (body.get('pose') or '').strip()
        if pose == 'clear':
            existing = dict(self.calibration or {})
            existing.pop('poses', None)
            existing.pop('armMap', None)
            if existing.get('rest'):
                self.calibration = save_calibration(existing)
            else:
                self.calibration = None
                calibration_path().unlink(missing_ok=True)
            self._emit('mocap-calibration', self.calibration or {'rest': None})
            return web.json_response(self.calibration or {'ok': True, 'cleared': True})
        if pose not in ('down', 'out', 'forward'):
            raise web.HTTPBadRequest(text='pose must be down, out, forward, or clear')
        averaged = self._joints_from_body(body.get('joints'))
        if averaged is None:
            averaged = await self._average_body()
        if not averaged:
            return web.json_response({'ok': False, 'error': 'not enough frames — stand in view and hold still'}, status=409)
        spread = body.get('spreadCm')
        frames = body.get('frames')
        if isinstance(spread, (int, float)) and spread > 6:
            preview = measure_pose(pose, averaged)
            preview['ok'] = False
            preview['error'] = f'You moved {float(spread):.1f} cm during the hold. Stay still and try that pose again.'
            preview['compare'] = comparison_table((self.calibration or {}).get('poses') or {}, (self.calibration or {}).get('armMap'))
            return web.json_response(preview, status=409)
        if isinstance(frames, int) and frames < 15:
            return web.json_response({'ok': False, 'error': f'Only {frames} frames arrived. Keep the viewer in front and try again.'}, status=409)
        existing = dict(self.calibration or {})
        poses = dict(existing.get('poses') or {})
        poses[pose] = averaged
        arm_map = None
        if all(name in poses for name in ('down', 'out', 'forward')):
            fitted = fit_arm_map(poses)
            if fitted.get('ok'):
                arm_map = fitted
            else:
                saved_error = fitted.get('error')
                measured = measure_pose(pose, averaged)
                measured['ok'] = False
                measured['error'] = saved_error
                measured['compare'] = comparison_table(poses, None)
                return web.json_response(measured, status=409)
        saved = save_calibration({
            'rest': existing.get('rest') or {},
            'bodyScale': existing.get('bodyScale') or 1,
            'neutral': bool(existing.get('neutral')),
            'poses': poses,
            'armMap': arm_map,
        })
        self.calibration = saved
        self._emit('mocap-calibration', self.calibration)
        measured = measure_pose(pose, averaged, arm_map)
        measured['calibration'] = saved
        measured['compare'] = comparison_table(poses, arm_map)
        measured['ready'] = bool(arm_map and arm_map.get('ok'))
        measured['ok'] = True
        return web.json_response(measured)

    def _joints_from_body(self, raw):
        if not isinstance(raw, dict):
            return None
        averaged = {}
        for name, point in raw.items():
            xyz = _xyz(point)
            if xyz:
                averaged[name] = {'x': xyz[0], 'y': xyz[1], 'z': xyz[2]}
        if 'leftWrist' not in averaged or 'rightWrist' not in averaged:
            return None
        return averaged

    async def handle_sources(self, request):
        return web.json_response(self._source_snapshot())

    async def handle_target(self, request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        if 'remote' in body:
            self.remote_enabled = bool(body.get('remote'))
        avatar = (body.get('avatar') or '').strip()
        if avatar:
            self.avatar_url = avatar
        if self.publisher is not None:
            if avatar:
                self.publisher.set_url(avatar)
            self.publisher.set_enabled(self.remote_enabled)
        if self.runtime is not None:
            self.runtime['remote'] = self.remote_enabled
            self.runtime['avatar'] = self.avatar_url
        return web.json_response(self._config())

    async def handle_record_start(self, request):
        if self.recording is not None:
            return web.json_response({'ok': True, 'recording': True})
        path = recording_dir() / f'mocap-{int(time.time())}.jsonl'
        self.recording = path.open('a')
        self.recording_path = path
        return web.json_response({'ok': True, 'file': path.name})

    async def handle_record_stop(self, request):
        handle = self.recording
        self.recording = None
        if handle is not None:
            handle.close()
        name = getattr(self, 'recording_path', None)
        return web.json_response({'ok': True, 'file': name.name if name else ''})

    async def handle_recordings(self, request):
        files = []
        for path in sorted(recording_dir().glob('*.jsonl')):
            files.append({'name': path.name, 'bytes': path.stat().st_size})
        return web.json_response({'files': files})

    async def handle_replay(self, request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = Path(body.get('name') or '').name
        path = recording_dir() / name
        if not path.is_file():
            raise web.HTTPNotFound(text='recording not found')
        if self.replay_stop is not None:
            self.replay_stop.set()
        stop = threading.Event()
        self.replay_stop = stop

        def play():
            # this [2026-09-25] | INFO | LocalHub.handle_replay | JSONL frames go back through the merger
            prev = None
            for line in path.read_text().splitlines():
                if stop.is_set():
                    break
                try:
                    frame = json.loads(line)
                except Exception:
                    continue
                t = frame.get('t') or 0
                if prev:
                    time.sleep(max(0.0, min(0.1, (t - prev) / 1000)))
                prev = t
                frame['source'] = 'replay'
                merged = self._accept(frame, source='replay')
                if merged:
                    self._emit('mocap-frame', merged)

        threading.Thread(target=play, name='mocap-replay', daemon=True).start()
        return web.json_response({'ok': True, 'name': name})

    async def handle_tune_get(self, request):
        # this [2026-09-25] | INFO | LocalHub.handle_tune_get | Kept so older Mac builds do not 404
        return web.json_response({'width': 1, 'height': 1, 'depth': 1, 'offsetX': 0, 'offsetY': 0})

    async def handle_tune_post(self, request):
        return await self.handle_tune_get(request)

    async def handle_model(self, request):
        path = self.vrm_path
        if path and Path(path).is_file():
            return web.FileResponse(path, headers={'Content-Type': 'application/octet-stream'})
        cache = support_dir() / 'models' / 'VRM1_Constraint_Twist_Sample.vrm'
        cache.parent.mkdir(parents=True, exist_ok=True)
        if not cache.is_file() or cache.stat().st_size < 1000:
            try:
                urllib.request.urlretrieve(SAMPLE_VRM_URL, cache)
            except Exception as error:
                raise web.HTTPBadGateway(text=f'Could not download sample VRM: {error}')
        self.vrm_path = cache
        return web.FileResponse(cache, headers={'Content-Type': 'application/octet-stream'})

    async def handle_mocap_js(self, request):
        name = Path(request.match_info['name']).name
        if not name.endswith('.js'):
            raise web.HTTPNotFound()
        path = resolve_public() / 'mocap' / name
        if not path.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers={'Content-Type': 'text/javascript'})

    async def handle_lib(self, request):
        name = Path(request.match_info['name']).name
        allowed = {'pose-estimator.js', 'full-body-animator.js'}
        if name not in allowed:
            raise web.HTTPNotFound()
        root = resolve_public()
        bundled = BUNDLED_LIB / name
        path = bundled if bundled.is_file() else root / name
        if not path.is_file():
            raise web.HTTPNotFound()
        content_type = mimetypes.guess_type(name)[0] or 'text/javascript'
        return web.FileResponse(path, headers={'Content-Type': content_type})

    def start(self):
        if self.thread and self.thread.is_alive():
            return self.url
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run, name='mocap-local-hub', daemon=True)
        self.thread.start()
        if not self.ready.wait(timeout=8):
            raise RuntimeError(self.last_error or 'Local mocap viewer failed to start')
        if self.last_error:
            raise RuntimeError(self.last_error)
        print(f'[mocap] local viewer {self.url}')
        return self.url

    def _run(self):
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self._serve())
        except Exception as error:
            self.last_error = str(error)
            self.ready.set()

    async def _serve(self):
        runner = web.AppRunner(self.app, access_log=None)
        await runner.setup()
        last_error = None
        for _attempt in range(20):
            try:
                site = web.TCPSite(runner, self.host, self.port)
                await site.start()
                last_error = None
                self.ready.set()
                print(f'[mocap] hub bound {self.host}:{self.port}')
                break
            except OSError as error:
                last_error = error
                await asyncio.sleep(0.25)
        if last_error is not None:
            self.last_error = f'Port {self.port} is busy: {last_error}'
            print(f'[mocap] {self.last_error}')
            self.ready.set()
            await runner.cleanup()
            return
        stop = self.runtime.get('stop') if self.runtime else None
        try:
            while True:
                if stop is not None and stop.is_set():
                    break
                await asyncio.sleep(0.25)
        finally:
            await runner.cleanup()

    def emit_frame(self, payload):
        self.ingest_local(payload)

    def emit_status(self, payload, force=False):
        data = dict(payload or {})
        data.update({'remote': self.remote_enabled, 'avatar': self.avatar_url})
        self._emit('mocap-status', data)

    def _emit(self, event, payload):
        if self.loop is None or not self.ready.is_set() or self.last_error:
            return
        try:
            asyncio.run_coroutine_threadsafe(self.sio.emit(event, payload), self.loop)
        except Exception as error:
            self.last_error = str(error)

    def close(self):
        if self.runtime is not None:
            stop = self.runtime.get('stop')
            if stop is not None:
                stop.set()
        if self.recording is not None:
            self.recording.close()
            self.recording = None
        if self.replay_stop is not None:
            self.replay_stop.set()
        if self.thread is not None:
            self.thread.join(timeout=2)
