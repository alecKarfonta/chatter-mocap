"""MediaPipe Pose world landmarks."""

from __future__ import annotations

import urllib.request

from mocap.config import support_dir
from mocap.sources.convert import joints_from_mp_world

POSE_MODEL_URL = (
    'https://storage.googleapis.com/mediapipe-models/'
    'pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'
)


def pose_model_path():
    return support_dir() / 'models' / 'pose_landmarker_lite.task'


def ensure_pose_model():
    path = pose_model_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size > 1000:
        return path
    print(f'[mocap] downloading Pose Landmarker → {path}')
    urllib.request.urlretrieve(POSE_MODEL_URL, path)
    return path


def mp_solutions_pose_available():
    try:
        import mediapipe as mp
        return hasattr(mp, 'solutions') and hasattr(mp.solutions, 'pose')
    except Exception:
        return False


def build_mp_pose(mode='lightweight'):
    # this [2026-09-25] | INFO | mediapipe_pose.build_mp_pose | Tasks API is CPU-only; Metal aborts the process
    import mediapipe as mp
    complexity = 0 if mode == 'lightweight' else 1
    if hasattr(mp, 'solutions') and hasattr(mp.solutions, 'pose'):
        pose = mp.solutions.pose.Pose(
            static_image_mode=False,
            model_complexity=complexity,
            smooth_landmarks=True,
            enable_segmentation=False,
            min_detection_confidence=0.45,
            min_tracking_confidence=0.45,
        )
        print(f'[mocap] MediaPipe Pose solutions complexity={complexity}')
        return pose, mp, 'solutions'
    options = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(
            model_asset_path=str(ensure_pose_model()),
            delegate=mp.tasks.BaseOptions.Delegate.CPU,
        ),
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.4,
        min_pose_presence_confidence=0.4,
        min_tracking_confidence=0.4,
    )
    print('[mocap] MediaPipe Pose landmarker on CPU')
    return mp.tasks.vision.PoseLandmarker.create_from_options(options), mp, 'tasks'


def infer_mp_pose(tracker, mp_mod, kind, frame_bgr, timestamp_ms, mirror=False):
    import cv2
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    if kind == 'solutions':
        rgb.flags.writeable = False
        result = tracker.process(rgb)
        if not result.pose_world_landmarks:
            return {}, {'body': 0.0, 'leftArm': 0.0, 'rightArm': 0.0}
        image = result.pose_landmarks.landmark if result.pose_landmarks else None
        return joints_from_mp_world(result.pose_world_landmarks.landmark, image, mirror=mirror)
    image = mp_mod.Image(image_format=mp_mod.ImageFormat.SRGB, data=rgb)
    result = tracker.detect_for_video(image, int(timestamp_ms))
    if not result.pose_world_landmarks:
        return {}, {'body': 0.0, 'leftArm': 0.0, 'rightArm': 0.0}
    return joints_from_mp_world(result.pose_world_landmarks[0], result.pose_landmarks[0], mirror=mirror)
