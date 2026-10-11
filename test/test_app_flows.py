"""End-to-end checks of the native-app-facing hub API: ingest -> app state -> guided calibration.

this [2026-10-06] | INFO | test_app_flows | Mirrors what ChatterMocap.m does at runtime.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request

import pytest

PORT = 8987
BASE = f'http://127.0.0.1:{PORT}'


def post(path: str, payload: dict, expect_ok: bool = True) -> tuple[int, dict]:
    request = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode())


def get(path: str) -> dict:
    with urllib.request.urlopen(BASE + path, timeout=5) as response:
        return json.loads(response.read().decode())


def frame(joints: dict) -> dict:
    body = {name: [p['x'], p['y'], p['z'], 1] for name, p in joints.items()}
    return {
        'v': 1,
        't': int(time.time() * 1000),
        'source': 'vision',
        'body': {'metric': True, 'joints': body},
        'quality': {'body': 0.9, 'face': 0, 'leftHand': 0, 'rightHand': 0, 'leftArm': 0.9, 'rightArm': 0.9},
    }


def pose_joints(pose: str) -> dict:
    """Metric-space joints (meters, hips origin) for the three guide poses."""
    joints = {
        'leftShoulder': {'x': 0.18, 'y': 0.50, 'z': 0.0},
        'rightShoulder': {'x': -0.18, 'y': 0.50, 'z': 0.0},
        'leftElbow': {'x': 0.22, 'y': 0.25, 'z': 0.0},
        'rightElbow': {'x': -0.22, 'y': 0.25, 'z': 0.0},
        'leftWrist': {'x': 0.24, 'y': 0.02, 'z': 0.0},
        'rightWrist': {'x': -0.24, 'y': 0.02, 'z': 0.0},
        'leftHip': {'x': 0.10, 'y': 0.0, 'z': 0.0},
        'rightHip': {'x': -0.10, 'y': 0.0, 'z': 0.0},
        'hips': {'x': 0.0, 'y': 0.0, 'z': 0.0},
        'chest': {'x': 0.0, 'y': 0.50, 'z': 0.0},
        'head': {'x': 0.0, 'y': 0.65, 'z': 0.0},
    }
    if pose == 'out':
        joints['leftElbow'] = {'x': 0.45, 'y': 0.50, 'z': 0.0}
        joints['rightElbow'] = {'x': -0.45, 'y': 0.50, 'z': 0.0}
        joints['leftWrist'] = {'x': 0.68, 'y': 0.50, 'z': 0.0}
        joints['rightWrist'] = {'x': -0.68, 'y': 0.50, 'z': 0.0}
    elif pose == 'forward':
        joints['leftElbow'] = {'x': 0.22, 'y': 0.45, 'z': 0.30}
        joints['rightElbow'] = {'x': -0.22, 'y': 0.45, 'z': 0.30}
        joints['leftWrist'] = {'x': 0.24, 'y': 0.42, 'z': 0.58}
        joints['rightWrist'] = {'x': -0.24, 'y': 0.42, 'z': 0.58}
    return joints


def stream_pose(joints: dict, seconds: float = 1.3, rate: float = 30.0) -> int:
    """Push frames like the app's captureOutput does; returns count sent."""
    sent = 0
    deadline = time.time() + seconds
    while time.time() < deadline:
        code, _ = post('/api/ingest', frame(joints))
        assert code == 200, f'ingest failed: {code}'
        sent += 1
        time.sleep(1.0 / rate)
    return sent


@pytest.fixture(scope='module')
def hub():
    """Boot the hub the same way run.command does (hub-only mode)."""
    import subprocess
    import sys

    proc = subprocess.Popen(
        [sys.executable, '-m', 'mocap', '--hub-only', '--no-window', '--no-open-viewer',
         '--target', 'local', '--local-port', str(PORT)],
        cwd=str(__import__('pathlib').Path(__file__).resolve().parents[1]),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    for _ in range(80):
        try:
            get('/health')
            break
        except Exception:
            time.sleep(0.25)
    else:
        proc.terminate()
        raise RuntimeError('hub did not start')
    yield proc
    proc.terminate()
    proc.wait(timeout=5)


def test_health_has_loop_flag(hub):
    health = get('/health')
    assert health['hub'] == 'chatter-mocap'
    assert health['loop']  # the app's pollHub waits for this


def test_app_state_shape(hub):
    state = get('/api/app/state')
    for key in ('sources', 'calibrated', 'neutral', 'poses', 'remote', 'vrm', 'recording'):
        assert key in state, key


def test_neutral_then_three_poses_fits_arm_map(hub):
    post('/api/calibration/pose', {'pose': 'clear'})
    post('/api/calibration/neutral', {'action': 'clear'})

    # Neutral capture: hub averages ~1.1s of live frames server-side
    def pump_neutral():
        stream_pose(pose_joints('down'), seconds=2.0)

    neutral_thread = threading.Thread(target=pump_neutral)
    neutral_thread.start()
    code, data = post('/api/calibration/neutral', {'action': 'capture'})
    neutral_thread.join()
    assert code == 200, data
    assert data.get('neutral') is True
    assert data.get('rest', {}).get('leftShoulder')

    state = get('/api/app/state')
    assert state['neutral'] is True
    assert state['calibrated'] is False

    # Guided flow: post averaged joints directly (the same path the browser
    # viewer uses), so slow CI runners cannot starve the sampling window
    for pose in ('down', 'out', 'forward'):
        code, data = post('/api/calibration/pose', {
            'pose': pose,
            'joints': pose_joints(pose),
            'spreadCm': 0.2,
            'frames': 30,
        })
        assert code == 200, f'{pose}: {data}'
        assert data.get('ok') is True, f'{pose}: {data}'

    state = get('/api/app/state')
    assert state['calibrated'] is True, state
    assert set(state['poses']) == {'down', 'out', 'forward'}

    # Cleanup so other tests/sessions start clean
    post('/api/calibration/pose', {'pose': 'clear'})


def test_ingest_accepts_vision_frame(hub):
    code, data = post('/api/ingest', frame(pose_joints('down')))
    assert code == 200
    state = get('/api/app/state')
    assert 'vision' in state['sources']
