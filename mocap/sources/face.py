"""MediaPipe face blendshapes plus head rotation."""

from __future__ import annotations

import sys
import urllib.request

from mocap.config import support_dir
from mocap.protocol import gaze_from_categories

FACE_MODEL_URL = (
    'https://storage.googleapis.com/mediapipe-models/'
    'face_landmarker/face_landmarker/float16/1/face_landmarker.task'
)


def face_model_path():
    return support_dir() / 'models' / 'face_landmarker.task'


def ensure_face_model():
    path = face_model_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size > 1000:
        return path
    print(f'[mocap] downloading Face Landmarker → {path}')
    urllib.request.urlretrieve(FACE_MODEL_URL, path)
    return path


def build_face_landmarker(prefer_gpu=True):
    import mediapipe as mp
    base_options_cls = mp.tasks.BaseOptions
    face_cls = mp.tasks.vision.FaceLandmarker
    options_cls = mp.tasks.vision.FaceLandmarkerOptions
    running_mode = mp.tasks.vision.RunningMode
    delegates = []
    # this [2026-09-25] | WARN | face.build_face_landmarker | MediaPipe GPU aborts on Darwin
    if prefer_gpu and sys.platform != 'darwin':
        delegates.append(getattr(base_options_cls.Delegate, 'GPU', None))
    delegates.append(getattr(base_options_cls.Delegate, 'CPU', None))
    last_error = None
    for delegate in delegates:
        if delegate is None:
            continue
        try:
            options = options_cls(
                base_options=base_options_cls(model_asset_path=str(ensure_face_model()), delegate=delegate),
                running_mode=running_mode.VIDEO,
                output_face_blendshapes=True,
                output_facial_transformation_matrixes=True,
                num_faces=1,
            )
            print(f'[mocap] Face Landmarker on {delegate}')
            return face_cls.create_from_options(options), mp
        except Exception as error:
            last_error = error
            print(f'[mocap] Face Landmarker {delegate} failed: {error}')
    raise RuntimeError(f'Face Landmarker failed: {last_error}')


def _quat_from_matrix(matrix):
    if matrix is None:
        return None
    try:
        data = list(matrix.data) if hasattr(matrix, 'data') else list(matrix)
    except Exception:
        return None
    if len(data) < 16:
        return None
    m = data
    trace = m[0] + m[5] + m[10]
    if trace > 0:
        s = (trace + 1.0) ** 0.5 * 2
        w = 0.25 * s
        x = (m[6] - m[9]) / s
        y = (m[8] - m[2]) / s
        z = (m[1] - m[4]) / s
    elif m[0] > m[5] and m[0] > m[10]:
        s = (1.0 + m[0] - m[5] - m[10]) ** 0.5 * 2
        w = (m[6] - m[9]) / s
        x = 0.25 * s
        y = (m[1] + m[4]) / s
        z = (m[8] + m[2]) / s
    elif m[5] > m[10]:
        s = (1.0 + m[5] - m[0] - m[10]) ** 0.5 * 2
        w = (m[8] - m[2]) / s
        x = (m[1] + m[4]) / s
        y = 0.25 * s
        z = (m[6] + m[9]) / s
    else:
        s = (1.0 + m[10] - m[0] - m[5]) ** 0.5 * 2
        w = (m[1] - m[4]) / s
        x = (m[8] + m[2]) / s
        y = (m[6] + m[9]) / s
        z = 0.25 * s
    return [float(x), float(y), float(z), float(w)]


def infer_face(landmarker, mp, frame_bgr, timestamp_ms, mirror=False):
    import cv2
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    result = landmarker.detect_for_video(image, int(timestamp_ms))
    if not result.face_blendshapes:
        return None
    blendshapes = {
        cat.category_name: float(cat.score)
        for cat in result.face_blendshapes[0]
    }
    matrix = None
    matrices = getattr(result, 'facial_transformation_matrixes', None)
    if matrices:
        matrix = matrices[0]
    face = {
        'blendshapes': blendshapes,
        'gaze': gaze_from_categories(blendshapes),
    }
    quat = _quat_from_matrix(matrix)
    if quat:
        if mirror:
            quat[1] = -quat[1]
        face['headRotation'] = quat
    return face
