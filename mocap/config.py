"""Paths and persisted mocap settings.

this [2026-09-25] | INFO | config | Support files live next to the repo on Linux and in Application Support on macOS.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent


def support_dir():
    # this [2026-09-25] | INFO | config.support_dir | Same folder on macOS, Windows, and Linux unless overridden
    env = os.environ.get('CHATTER_MOCAP_SUPPORT') or os.environ.get('CHATTER_MOCAP_MODELS')
    if env:
        return Path(env)
    if sys.platform == 'darwin':
        return Path.home() / 'Library/Application Support/ChatterMocap'
    if sys.platform == 'win32':
        base = os.environ.get('APPDATA') or str(Path.home() / 'AppData' / 'Roaming')
        return Path(base) / 'ChatterMocap'
    xdg = os.environ.get('XDG_DATA_HOME')
    base = Path(xdg) if xdg else Path.home() / '.local' / 'share'
    return base / 'ChatterMocap'


def vrm_dir():
    path = support_dir() / 'vrms'
    path.mkdir(parents=True, exist_ok=True)
    return path


def profile_dir():
    path = support_dir() / 'profiles'
    path.mkdir(parents=True, exist_ok=True)
    return path


def recording_dir():
    path = support_dir() / 'recordings'
    path.mkdir(parents=True, exist_ok=True)
    return path


def calibration_path():
    return support_dir() / 'calibration.json'


def read_json(path, default):
    file = Path(path)
    if not file.is_file():
        return default
    try:
        data = json.loads(file.read_text())
    except Exception:
        return default
    return data if isinstance(data, dict) else default


def write_json(path, data):
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(data, indent=2))
    return data


def load_calibration():
    data = read_json(calibration_path(), None)
    if not data:
        return None
    if not isinstance(data.get('rest'), dict) and not isinstance(data.get('armMap'), dict):
        return None
    return data


def save_calibration(data):
    # this [2026-09-28] | INFO | config.save_calibration | Keep the measured arm map alongside the neutral rest
    cleaned = {
        'rest': data.get('rest') if isinstance(data.get('rest'), dict) else {},
        'bodyScale': float(data.get('bodyScale') or 1),
        'neutral': bool(data.get('neutral')),
    }
    poses = data.get('poses')
    if isinstance(poses, dict):
        cleaned['poses'] = poses
    arm_map = data.get('armMap')
    if isinstance(arm_map, dict):
        cleaned['armMap'] = arm_map
    return write_json(calibration_path(), cleaned)


def profile_path(vrm_name):
    stem = Path(vrm_name or 'default').stem
    return profile_dir() / f'{stem}.json'


def vrm_search_dirs():
    here = ROOT
    return [vrm_dir(), here / 'vrms']
