"""Camera loop that publishes MocapFrame v1."""

from __future__ import annotations

import sys
import threading
import time

from mocap.protocol import normalize_frame
from mocap.sources.dummy import dummy_frame
from mocap.sources.face import build_face_landmarker, infer_face
from mocap.sources.mediapipe_pose import build_mp_pose, infer_mp_pose, mp_solutions_pose_available
from mocap.sources.rtmw3d import build_body_tracker, infer_body, pick_device


def wants_local(args):
    return getattr(args, 'target', 'remote') in ('local', 'both')


def wants_remote(args):
    if getattr(args, 'no_publish', False):
        return False
    return getattr(args, 'target', 'remote') in ('remote', 'both')


def broadcast(frame, status, publisher, hub):
    if publisher is not None and publisher.enabled:
        publisher.emit_frame(frame)
        if status is not None:
            publisher.emit_status(status)
    if hub is not None:
        hub.ingest_local(frame, status)


def open_camera(index, width, height):
    import cv2
    backends = []
    if sys.platform == 'darwin':
        backends.append(cv2.CAP_AVFOUNDATION)
    backends.append(cv2.CAP_ANY)
    indices = [int(index)]
    if int(index) == 0:
        indices.append(1)
    for backend in backends:
        for cam in indices:
            cap = cv2.VideoCapture(cam, backend)
            if width:
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, int(width))
            if height:
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, int(height))
            if not cap.isOpened():
                cap.release()
                continue
            ok, frame = cap.read()
            if ok and frame is not None:
                print(f'[mocap] camera {cam} backend={backend} frame={tuple(frame.shape)}')
                return cap
            cap.release()
    return None


def run_capture_loop(args, device, publisher, hub, runtime):
    if args.dummy or getattr(args, 'source', '') == 'dummy':
        # this [2026-10-06] | FIX | capture.run_capture_loop | Dummy mode never touches a camera, so cv2 must not gate it
        print('[mocap] dummy mode')
        try:
            while not runtime['stop'].is_set():
                frame = dummy_frame(time.time())
                broadcast(frame, {'state': 'dummy', 'device': device, 'fps': 20}, publisher, hub)
                time.sleep(1.0 / 20.0)
        except KeyboardInterrupt:
            runtime['stop'].set()
        return

    import cv2

    cap = None
    for attempt in range(8):
        if runtime['stop'].is_set():
            return
        cap = open_camera(args.camera, args.width, args.height)
        if cap is not None:
            break
        print(f'[mocap] camera {args.camera} not ready (attempt {attempt + 1})')
        if hub is not None:
            hub.emit_status({'state': 'need-camera', 'device': device, 'source': 'python'}, force=True)
        time.sleep(2)
    if cap is None:
        print(f'[mocap] camera {args.camera} unavailable')
        if hub is not None:
            hub.emit_status({'state': 'no-camera', 'device': device, 'source': 'python'}, force=True)
        while not runtime['stop'].is_set():
            time.sleep(0.5)
        return

    mode = args.mode
    if device == 'cpu' and mode == 'balanced':
        mode = 'lightweight'
    backend = getattr(args, 'source', None) or getattr(args, 'backend', None) or 'auto'
    use_mp = backend == 'mediapipe' and mp_solutions_pose_available()
    tracker = None
    mp_kind = None
    mp_pose = None
    mp_mod = None
    device_label = device
    if use_mp:
        try:
            mp_pose, mp_mod, mp_kind = build_mp_pose(mode=mode)
            device_label = 'mediapipe-3d'
        except Exception as error:
            print(f'[mocap] MediaPipe Pose failed ({error}); falling back to RTMPose')
            use_mp = False
    if not use_mp:
        tracker, _kind = build_body_tracker(device, mode=mode)
    include_hands = not bool(getattr(args, 'no_hands', False))
    face = None
    mp = None
    if not args.no_face and sys.platform != 'darwin':
        try:
            face, mp = build_face_landmarker(prefer_gpu=device != 'cpu')
        except Exception as error:
            print(f'[mocap] face disabled: {error}')
    elif not args.no_face and sys.platform == 'darwin':
        print('[mocap] face disabled on macOS (MediaPipe abort). Use the browser source for face.')

    mirror = bool(args.mirror)
    show_window = not bool(getattr(args, 'no_window', False) or getattr(args, 'embed', False))
    fps = 0.0
    frames = 0
    fps_at = time.time()
    t0 = time.time()
    last_ts = 0
    print('[mocap] camera open. q=quit  m=mirror  p=publish')
    try:
        while not runtime['stop'].is_set():
            ok, image = cap.read()
            if not ok:
                print('[mocap] camera frame failed')
                break
            if mirror and not use_mp:
                image = cv2.flip(image, 1)
            now = time.time()
            hands = {}
            metric = True
            if use_mp:
                ts = int((now - t0) * 1000)
                if ts <= last_ts:
                    ts = last_ts + 1
                last_ts = ts
                joints, quality = infer_mp_pose(mp_pose, mp_mod, mp_kind, image, ts, mirror=mirror)
            else:
                joints, quality, metric, hands = infer_body(
                    tracker, image, mirror=mirror, include_hands=include_hands,
                )
            face_block = None
            if face is not None:
                try:
                    face_block = infer_face(face, mp, image, (now - t0) * 1000.0, mirror=False)
                    if face_block:
                        quality['face'] = 0.9
                except Exception as error:
                    quality['face'] = 0.0
                    if frames % 60 == 0:
                        print(f'[mocap] face infer error: {error}')
            payload = normalize_frame({
                't': int(now * 1000),
                'source': 'python',
                'body': {'metric': metric, 'joints': joints},
                'hands': hands,
                'face': face_block,
                'quality': quality,
            })
            status = None
            frames += 1
            if now - fps_at >= 1.0:
                fps = frames / (now - fps_at)
                frames = 0
                fps_at = now
                status = {
                    'state': 'live',
                    'device': device_label,
                    'source': 'python',
                    'fps': round(fps, 1),
                    'mirror': mirror,
                    'connected': publisher.connected if publisher else False,
                }
                print(f'[mocap] {fps:.1f} fps {device_label}')
            broadcast(payload, status, publisher, hub)
            if show_window:
                cv2.imshow('Chatter mocap', image)
                key = cv2.waitKey(1) & 0xFF
                if key in (ord('q'), 27):
                    break
                if key == ord('m'):
                    mirror = not mirror
                if key == ord('p') and publisher is not None:
                    publisher.set_enabled(not publisher.enabled)
            else:
                time.sleep(0.001)
    except KeyboardInterrupt:
        pass
    finally:
        runtime['stop'].set()
        cap.release()
        if show_window:
            cv2.destroyAllWindows()


def start_sinks(args, device):
    from mocap.local_hub import LocalHub, discover_vrm
    from mocap.publisher import MocapPublisher

    runtime = {
        'stop': threading.Event(),
        'remote': wants_remote(args),
        'avatar': args.avatar,
    }
    publisher = MocapPublisher(args.avatar, enabled=wants_remote(args))
    if publisher.enabled:
        publisher.connect()
        publisher.emit_status({'state': 'starting', 'device': device, 'source': 'python'}, force=True)
    hub = None
    if wants_local(args) or getattr(args, 'hub_only', False):
        vrm_path = discover_vrm(getattr(args, 'vrm', '') or '', avatar_url=args.avatar)
        if vrm_path:
            print(f'[mocap] VRM {vrm_path}')
        hub = LocalHub(
            host=getattr(args, 'local_host', '127.0.0.1'),
            port=int(getattr(args, 'local_port', 8765)),
            vrm_path=vrm_path,
            avatar_url=args.avatar,
            remote_enabled=publisher.enabled,
            device=device,
            mirror=bool(args.mirror),
            publisher=publisher,
            runtime=runtime,
        )
        hub.start()
        if wants_local(args) and not getattr(args, 'embed', False):
            import webbrowser
            webbrowser.open(hub.url)
    return publisher, hub, runtime


def run_app(args):
    if not getattr(args, 'source', None) or args.source == 'auto':
        backend = getattr(args, 'backend', None)
        if backend in ('mediapipe', 'rtmlib'):
            args.source = backend
    device = 'vision-3d' if getattr(args, 'hub_only', False) else pick_device(args.device)
    if getattr(args, 'source', '') == 'dummy':
        args.dummy = True
    publisher, hub, runtime = start_sinks(args, device)
    try:
        if getattr(args, 'hub_only', False):
            print('[mocap] hub-only; waiting for /api/ingest or browser frames')
            while not runtime['stop'].is_set():
                time.sleep(0.25)
        else:
            run_capture_loop(args, device, publisher, hub, runtime)
    except KeyboardInterrupt:
        runtime['stop'].set()
    finally:
        runtime['stop'].set()
        if publisher is not None:
            publisher.close()
        if hub is not None:
            hub.close()
        print('[mocap] stopped')
