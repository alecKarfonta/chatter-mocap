"""RTMPose / RTMW3D whole-body tracking."""

from __future__ import annotations

import sys

from mocap.sources.convert import joints_from_wholebody


def pick_device(requested):
    # this [2026-09-25] | INFO | rtmw3d.pick_device | CUDA on Linux. CoreML pose is skipped on macOS.
    if requested == 'cpu':
        return 'cpu'
    try:
        import onnxruntime as ort
        providers = ort.get_available_providers()
    except Exception:
        return 'cpu'
    if requested in ('cuda', 'auto') and 'CUDAExecutionProvider' in providers:
        return 'cuda'
    coreml = 'CoreMLExecutionProvider' in providers or 'MPSExecutionProvider' in providers
    if requested in ('mps', 'auto', 'cuda') and coreml:
        if sys.platform == 'darwin':
            print('[mocap] CoreML pose is broken on this Mac; using CPU')
            return 'cpu'
        return 'mps'
    if requested in ('cuda', 'mps'):
        print(f'[mocap] {requested} requested but not available; using CPU')
    return 'cpu'


def build_body_tracker(device, mode='balanced'):
    from rtmlib import PoseTracker
    use_3d = device == 'cuda' and mode != 'lightweight'
    if use_3d:
        try:
            from rtmlib import Wholebody3d
            print(f'[mocap] RTMW3D Wholebody3d on {device}')
            try:
                return PoseTracker(
                    Wholebody3d, det_frequency=7, tracking=False, mode=mode,
                    backend='onnxruntime', device=device,
                ), 'wholebody3d'
            except KeyError:
                return PoseTracker(
                    Wholebody3d, det_frequency=7, tracking=False, mode='balanced',
                    backend='onnxruntime', device=device,
                ), 'wholebody3d'
        except Exception as error:
            print(f'[mocap] Wholebody3d unavailable ({error}); falling back to 2D')
    from rtmlib import Wholebody
    print(f'[mocap] Wholebody 2D on {device} mode={mode}')
    try:
        return PoseTracker(
            Wholebody, det_frequency=12, tracking=False, mode=mode,
            backend='onnxruntime', device=device,
        ), 'wholebody'
    except KeyError:
        return PoseTracker(
            Wholebody, det_frequency=12, tracking=False, mode='balanced',
            backend='onnxruntime', device=device,
        ), 'wholebody'


def infer_body(tracker, frame_bgr, mirror=False, include_hands=True):
    out = tracker(frame_bgr)
    keypoints_3d = None
    if isinstance(out, tuple) and len(out) >= 4:
        keypoints_3d, scores, _simcc, keypoints_2d = out[:4]
    elif isinstance(out, tuple) and len(out) >= 2:
        keypoints_2d, scores = out[0], out[1]
    else:
        return {}, {'body': 0.0, 'leftArm': 0.0, 'rightArm': 0.0, 'leftHand': 0.0, 'rightHand': 0.0}, False, {}
    joints, quality, metric, hands = joints_from_wholebody(
        keypoints_2d, scores, keypoints_3d=keypoints_3d, mirror=mirror, include_hands=include_hands,
    )
    return joints, quality, metric, hands
