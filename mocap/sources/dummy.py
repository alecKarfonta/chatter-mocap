"""Synthetic wave used to exercise the socket path without a camera."""

from __future__ import annotations

import math

from mocap.protocol import normalize_frame


def dummy_frame(timestamp):
    # this [2026-09-25] | INFO | dummy.dummy_frame | Upper body wave in canonical meters
    phase = math.sin(timestamp * 2.2)
    lift = 0.35 + 0.25 * max(0.0, phase)
    joints = {
        'leftShoulder': [0.18, 0.42, 0.0, 1],
        'rightShoulder': [-0.18, 0.42, 0.0, 1],
        'leftElbow': [0.28, 0.18, 0.02, 1],
        'rightElbow': [-0.22, 0.18 + lift * 0.35, 0.04, 1],
        'leftWrist': [0.30, -0.05, 0.04, 1],
        'rightWrist': [-0.12, 0.55 + lift, 0.08, 1],
        'leftHip': [0.1, -0.05, 0.0, 1],
        'rightHip': [-0.1, -0.05, 0.0, 1],
        'head': [0.0, 0.62, 0.06, 1],
        'nose': [0.0, 0.62, 0.08, 1],
        'leftEar': [0.09, 0.64, 0.02, 1],
        'rightEar': [-0.09, 0.64, 0.02, 1],
    }
    return normalize_frame({
        't': int(timestamp * 1000),
        'source': 'dummy',
        'body': {'metric': True, 'joints': joints},
        'face': {
            'blendshapes': {
                'jawOpen': 0.15 + 0.1 * max(0.0, phase),
                'mouthSmileLeft': 0.25,
                'mouthSmileRight': 0.25,
                'eyeBlinkLeft': 0.85 if int(timestamp * 2) % 7 == 0 else 0.0,
                'eyeBlinkRight': 0.85 if int(timestamp * 2) % 7 == 0 else 0.0,
            },
            'gaze': {'x': 0.15 * math.sin(timestamp * 0.8), 'y': -0.05},
        },
        'quality': {
            'body': 1, 'face': 1, 'leftHand': 0.2, 'rightHand': 0.2, 'leftArm': 1, 'rightArm': 1,
        },
    })
