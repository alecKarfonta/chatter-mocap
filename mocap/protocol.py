"""MocapFrame v1: canonical subject space and channel merge.

this [2026-09-25] | INFO | protocol | Right-handed meters, hips origin, +Y up, +X subject-left, +Z toward camera.
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parent / 'schema' / 'mocap-frame.v1.json'

BODY_JOINTS = (
    'hips', 'spine', 'chest', 'neck', 'head', 'headTop', 'nose',
    'leftEye', 'rightEye', 'leftEar', 'rightEar',
    'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
    'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle',
)

# this [2026-09-25] | INFO | protocol.HAND_ORDER | MediaPipe 21: wrist, thumb 1-4, index 5-8, middle 9-12, ring 13-16, pinky 17-20
HAND_COUNT = 21

ARKIT_BLENDSHAPES = (
    'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
    'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
    'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight',
    'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight',
    'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight',
    'eyeWideLeft', 'eyeWideRight',
    'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
    'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight',
    'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight',
    'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight',
    'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
    'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight',
    'mouthUpperUpLeft', 'mouthUpperUpRight',
    'noseSneerLeft', 'noseSneerRight', 'tongueOut',
)

SECTION_STALE_MS = 400


def now_ms():
    return int(time.time() * 1000)


def _finite(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float('inf'), float('-inf')):
        return None
    return number


def joint_tuple(value):
    # this [2026-09-25] | INFO | protocol.joint_tuple | Accept [x,y,z,conf] or {x,y,z,conf}
    if isinstance(value, dict):
        x = _finite(value.get('x'))
        y = _finite(value.get('y'))
        z = _finite(value.get('z'))
        conf = _finite(value.get('conf', value.get('visibility', 1.0)))
    elif isinstance(value, (list, tuple)) and len(value) >= 3:
        x = _finite(value[0])
        y = _finite(value[1])
        z = _finite(value[2])
        conf = _finite(value[3]) if len(value) > 3 else 1.0
    else:
        return None
    if x is None or y is None or z is None:
        return None
    return [x, y, z, 1.0 if conf is None else max(0.0, min(1.0, conf))]


def landmark_tuple(value):
    point = joint_tuple(value)
    if point is None:
        return None
    return point[:3]


def _joints_from_legacy(raw):
    out = {}
    if not isinstance(raw, dict):
        return out
    for name, value in raw.items():
        point = joint_tuple(value)
        if point is not None:
            out[str(name)] = point
    return out


def _hand_from_legacy(raw):
    if not isinstance(raw, dict):
        return None
    landmarks = raw.get('landmarks')
    if not isinstance(landmarks, list) or len(landmarks) != HAND_COUNT:
        return None
    points = []
    for item in landmarks:
        point = landmark_tuple(item)
        if point is None:
            return None
        points.append(point)
    score = _finite(raw.get('score'))
    return {'landmarks': points, 'score': 0.0 if score is None else max(0.0, min(1.0, score))}


def normalize_frame(raw, source=None):
    """Coerce a v1 frame or the pre-v1 {joints, blendshapes, gaze} payload into v1."""
    if not isinstance(raw, dict):
        raise ValueError('frame must be an object')
    frame = {
        'v': 1,
        't': int(_finite(raw.get('t')) or now_ms()),
        'source': str(source or raw.get('source') or 'unknown'),
    }
    body = raw.get('body') if isinstance(raw.get('body'), dict) else None
    joints = _joints_from_legacy((body or {}).get('joints'))
    if not joints:
        joints = _joints_from_legacy(raw.get('joints'))
    if joints:
        metric = bool((body or {}).get('metric', raw.get('metric', True)))
        # this [2026-10-06] | FIX | protocol.normalize_frame | Canonical space means hips at origin; Vision metric frames arrive camera-absolute
        if metric:
            joints = subtract_hips(joints)
        frame['body'] = {'metric': metric, 'joints': joints}
    hands_in = raw.get('hands') if isinstance(raw.get('hands'), dict) else {}
    hands = {}
    for side in ('left', 'right'):
        hand = _hand_from_legacy(hands_in.get(side))
        if hand:
            hands[side] = hand
    if hands:
        frame['hands'] = hands
    face_in = raw.get('face') if isinstance(raw.get('face'), dict) else {}
    blend = face_in.get('blendshapes') if isinstance(face_in.get('blendshapes'), dict) else raw.get('blendshapes')
    gaze = face_in.get('gaze') if isinstance(face_in.get('gaze'), dict) else raw.get('gaze')
    rotation = face_in.get('headRotation')
    face = {}
    if isinstance(blend, dict) and blend:
        cleaned = {}
        for name, value in blend.items():
            number = _finite(value)
            if number is not None:
                cleaned[str(name)] = max(0.0, min(1.0, number))
        if cleaned:
            face['blendshapes'] = cleaned
    if isinstance(rotation, (list, tuple)) and len(rotation) == 4:
        quat = [_finite(item) for item in rotation]
        if all(item is not None for item in quat):
            face['headRotation'] = quat
    if isinstance(gaze, dict):
        gx = _finite(gaze.get('x'))
        gy = _finite(gaze.get('y'))
        if gx is not None and gy is not None:
            face['gaze'] = {'x': max(-1.0, min(1.0, gx)), 'y': max(-1.0, min(1.0, gy))}
    if face:
        frame['face'] = face
    quality = raw.get('quality') if isinstance(raw.get('quality'), dict) else {}
    cleaned_q = {}
    for name, value in quality.items():
        number = _finite(value)
        if number is not None:
            cleaned_q[str(name)] = number
    frame['quality'] = cleaned_q
    preview = raw.get('preview')
    if isinstance(preview, dict):
        frame['preview'] = preview
    debug = raw.get('debug')
    if isinstance(debug, dict):
        frame['debug'] = debug
    return frame


def validate_frame(frame):
    # this [2026-09-25] | INFO | protocol.validate_frame | Structural checks shared with the JSON schema
    if not isinstance(frame, dict):
        return ['frame must be an object']
    errors = []
    if frame.get('v') != 1:
        errors.append('v must be 1')
    if not isinstance(frame.get('t'), (int, float)):
        errors.append('t must be a number')
    if not isinstance(frame.get('source'), str) or not frame.get('source'):
        errors.append('source must be a string')
    body = frame.get('body')
    if body is not None:
        if not isinstance(body, dict) or not isinstance(body.get('joints'), dict):
            errors.append('body.joints must be an object')
        else:
            for name, value in body['joints'].items():
                if joint_tuple(value) is None:
                    errors.append(f'body.joints.{name} is not xyz')
    hands = frame.get('hands')
    if hands is not None:
        if not isinstance(hands, dict):
            errors.append('hands must be an object')
        else:
            for side in ('left', 'right'):
                if side in hands and _hand_from_legacy(hands[side]) is None:
                    errors.append(f'hands.{side} needs 21 landmarks')
    face = frame.get('face')
    if face is not None and not isinstance(face, dict):
        errors.append('face must be an object')
    return errors


def load_schema():
    return json.loads(SCHEMA_PATH.read_text())


def gaze_from_categories(blendshapes):
    look_x = (
        blendshapes.get('eyeLookOutLeft', 0.0)
        + blendshapes.get('eyeLookInRight', 0.0)
        - blendshapes.get('eyeLookInLeft', 0.0)
        - blendshapes.get('eyeLookOutRight', 0.0)
    ) * 0.5
    look_y = (
        blendshapes.get('eyeLookUpLeft', 0.0)
        + blendshapes.get('eyeLookUpRight', 0.0)
        - blendshapes.get('eyeLookDownLeft', 0.0)
        - blendshapes.get('eyeLookDownRight', 0.0)
    ) * 0.5
    return {
        'x': max(-1.0, min(1.0, look_x)),
        'y': max(-1.0, min(1.0, look_y)),
    }


def mp_world_to_canonical(x, y, z):
    # this [2026-09-25] | INFO | protocol.mp_world_to_canonical | Camera-right is the subject's left, so X stays; Y flips up; Z flips toward the camera
    return [float(x), -float(y), -float(z)]


def mirror_name(name):
    if name.startswith('left'):
        return 'right' + name[4:]
    if name.startswith('right'):
        return 'left' + name[5:]
    return name


def mirror_joints(joints):
    # this [2026-09-25] | INFO | protocol.mirror_joints | Selfie: swap sides and negate X
    out = {}
    for name, point in joints.items():
        flipped = [-point[0], point[1], point[2], point[3] if len(point) > 3 else 1.0]
        out[mirror_name(name)] = flipped
    return out


POSE_NAMES = ('down', 'out', 'forward')
POSE_DIRECTION = {
    'down': (0.0, -1.0, 0.0),
    'out': (1.0, 0.0, 0.0),
    'forward': (0.0, 0.0, 1.0),
}


def _xyz(point):
    if isinstance(point, dict):
        return [float(point.get('x') or 0), float(point.get('y') or 0), float(point.get('z') or 0)]
    if isinstance(point, (list, tuple)) and len(point) >= 3:
        return [float(point[0]), float(point[1]), float(point[2])]
    return None


def shoulder_delta(joints, side, tip):
    # this [2026-09-28] | INFO | protocol.shoulder_delta | Wrist or elbow relative to that side's shoulder
    if not isinstance(joints, dict):
        return None
    tip_point = _xyz(joints.get(f'{side}{tip}'))
    shoulder = _xyz(joints.get(f'{side}Shoulder'))
    if not tip_point or not shoulder:
        return None
    return [tip_point[i] - shoulder[i] for i in range(3)]


def _unit(vector):
    length = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / length for value in vector]


def _angle_deg(left, right):
    a = _unit(left)
    b = _unit(right)
    cosine = max(-1.0, min(1.0, sum(x * y for x, y in zip(a, b))))
    return math.degrees(math.acos(cosine))


def ideal_direction(pose, side):
    direction = list(POSE_DIRECTION[pose])
    if pose == 'out' and side == 'right':
        direction[0] *= -1.0
    return direction


def pose_rows(pose, joints, arm_map=None):
    # this [2026-09-28] | INFO | protocol.pose_rows | Measured wrist beside the known direction, in degrees
    rows = []
    arms = (arm_map or {}).get('arms') or {}
    for side in ('left', 'right'):
        delta = shoulder_delta(joints, side, 'Wrist')
        if not delta:
            rows.append({'side': side, 'pose': pose, 'missing': True})
            continue
        ideal = ideal_direction(pose, side)
        row = {
            'side': side,
            'pose': pose,
            'across': round(delta[0] * 100),
            'up': round(delta[1] * 100),
            'forward': round(delta[2] * 100),
            'angle': round(_angle_deg(delta, ideal), 1),
        }
        matrix = (arms.get(side) or {}).get('m')
        if matrix and len(matrix) == 9:
            got = [
                matrix[0] * delta[0] + matrix[1] * delta[1] + matrix[2] * delta[2],
                matrix[3] * delta[0] + matrix[4] * delta[1] + matrix[5] * delta[2],
                matrix[6] * delta[0] + matrix[7] * delta[1] + matrix[8] * delta[2],
            ]
            row['corrected'] = round(_angle_deg(got, ideal), 1)
        rows.append(row)
    return rows


def comparison_table(poses, arm_map=None):
    rows = []
    for pose in POSE_NAMES:
        joints = (poses or {}).get(pose)
        if joints:
            rows.extend(pose_rows(pose, joints, arm_map))
    return rows


def measure_pose(pose, joints, arm_map=None):
    # this [2026-09-28] | INFO | protocol.measure_pose | Centimeters from the shoulder, which is the offset the arm map removes
    lines = [pose]
    samples = {}
    for side in ('left', 'right'):
        delta = shoulder_delta(joints, side, 'Wrist')
        if not delta:
            lines.append(f'  {side}: shoulder or wrist missing')
            continue
        samples[side] = [round(value, 4) for value in delta]
        across, up, forward = (round(value * 100) for value in delta)
        lines.append(f'  {side} wrist from shoulder: {across:+d}cm across, {up:+d}cm up, {forward:+d}cm forward')
    return {'pose': pose, 'lines': lines, 'samples': samples, 'rows': pose_rows(pose, joints, arm_map)}


def fit_arm_map(poses):
    # this [2026-09-28] | INFO | protocol.fit_arm_map | Map the three captured arm directions onto down, out, and forward
    import numpy as np

    arms = {}
    notes = []
    for side, out_sign in (('left', 1.0), ('right', -1.0)):
        columns = []
        desired = []
        refs_wrist = []
        refs_elbow = []
        for pose in POSE_NAMES:
            joints = poses.get(pose) or {}
            delta = shoulder_delta(joints, side, 'Wrist')
            elbow = shoulder_delta(joints, side, 'Elbow')
            if not delta:
                return {'ok': False, 'error': f'{side} {pose} is missing a wrist'}
            columns.append(delta)
            direction = list(POSE_DIRECTION[pose])
            if pose == 'out':
                direction[0] *= out_sign
            desired.append(direction)
            refs_wrist.append(float(np.linalg.norm(delta)))
            if elbow:
                refs_elbow.append(float(np.linalg.norm(elbow)))
        camera = np.array(columns, dtype=float).T
        target = np.array(desired, dtype=float).T
        if abs(float(np.linalg.det(camera))) < 1e-5:
            return {
                'ok': False,
                'error': f'{side} poses were too alike. Move the arm farther for each one.',
            }
        matrix = target @ np.linalg.inv(camera)
        errors = {}
        for index, pose in enumerate(POSE_NAMES):
            got = matrix @ camera[:, index]
            length = float(np.linalg.norm(got)) or 1.0
            cosine = float(np.clip(np.dot(got / length, target[:, index]), -1.0, 1.0))
            errors[pose] = round(math.degrees(math.acos(cosine)), 1)
        arms[side] = {
            'm': [round(float(value), 5) for value in matrix.reshape(-1)],
            'refWrist': round(sum(refs_wrist) / len(refs_wrist), 4),
            'refElbow': round(sum(refs_elbow) / len(refs_elbow), 4) if refs_elbow else round(sum(refs_wrist) / len(refs_wrist) * 0.5, 4),
            'errorDeg': errors,
        }
        notes.append(
            f'{side} fit error: down {errors["down"]}°, out {errors["out"]}°, forward {errors["forward"]}°'
        )
    return {'ok': True, 'arms': arms, 'lines': notes}


def hip_center(joints):
    left = joints.get('leftHip')
    right = joints.get('rightHip')
    if left and right:
        return [(left[i] + right[i]) * 0.5 for i in range(3)]
    hips = joints.get('hips')
    if hips:
        return list(hips[:3])
    return [0.0, 0.0, 0.0]


def subtract_hips(joints):
    origin = hip_center(joints)
    out = {}
    for name, point in joints.items():
        conf = point[3] if len(point) > 3 else 1.0
        out[name] = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2], conf]
    return out


class ChannelMerger:
    """Newest non-stale body, hands, and face sections win, even from different sources."""

    def __init__(self, stale_ms=SECTION_STALE_MS):
        self.stale_ms = int(stale_ms)
        self.sections = {}

    def push(self, frame):
        normalized = normalize_frame(frame)
        arrived = normalized['t']
        for key in ('body', 'hands', 'face'):
            if key in normalized:
                self.sections[key] = {
                    'at': arrived,
                    'source': normalized['source'],
                    'value': normalized[key],
                }
        if normalized.get('quality'):
            self.sections['quality'] = {
                'at': arrived,
                'source': normalized['source'],
                'value': normalized['quality'],
            }
        for key in ('preview', 'debug'):
            if isinstance(normalized.get(key), dict):
                self.sections[key] = {'at': arrived, 'value': normalized[key]}
        return self.snapshot(arrived)

    def snapshot(self, now=None):
        now = now_ms() if now is None else int(now)
        frame = {'v': 1, 't': now, 'source': 'merged', 'quality': {}}
        sources = []
        for key in ('body', 'hands', 'face'):
            held = self.sections.get(key)
            if not held:
                continue
            if now - held['at'] > self.stale_ms:
                continue
            frame[key] = held['value']
            sources.append(held['source'])
        quality = self.sections.get('quality')
        if quality and now - quality['at'] <= self.stale_ms:
            frame['quality'] = dict(quality['value'])
        for key in ('preview', 'debug'):
            held = self.sections.get(key)
            if held and now - held['at'] <= self.stale_ms:
                frame[key] = held['value']
        if sources:
            frame['source'] = sources[0] if len(set(sources)) == 1 else 'merged'
        frame['channels'] = {
            key: self.sections[key]['source']
            for key in ('body', 'hands', 'face')
            if key in frame
        }
        return frame
