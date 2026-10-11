"""Shared landmark conversion for capture sources."""

from __future__ import annotations

import math

from mocap.protocol import mirror_joints, mp_world_to_canonical

MP_INDEX = {
    0: 'nose', 2: 'leftEye', 5: 'rightEye', 7: 'leftEar', 8: 'rightEar',
    11: 'leftShoulder', 12: 'rightShoulder', 13: 'leftElbow', 14: 'rightElbow',
    15: 'leftWrist', 16: 'rightWrist', 23: 'leftHip', 24: 'rightHip',
    25: 'leftKnee', 26: 'rightKnee', 27: 'leftAnkle', 28: 'rightAnkle',
}

BODY_TO_NAME = {
    0: 'nose', 1: 'leftEye', 2: 'rightEye', 3: 'leftEar', 4: 'rightEar',
    5: 'leftShoulder', 6: 'rightShoulder', 7: 'leftElbow', 8: 'rightElbow',
    9: 'leftWrist', 10: 'rightWrist', 11: 'leftHip', 12: 'rightHip',
    13: 'leftKnee', 14: 'rightKnee', 15: 'leftAnkle', 16: 'rightAnkle',
}

LEFT_HAND = 91
RIGHT_HAND = 112


def _xyz(point):
    try:
        x = float(point[0])
        y = float(point[1])
        z = float(point[2]) if len(point) > 2 else 0.0
    except (TypeError, ValueError, IndexError):
        return None
    if not all(math.isfinite(v) for v in (x, y, z)):
        return None
    return (x, y, z)


def joints_from_mp_world(world, image=None, mirror=False):
    # this [2026-09-25] | INFO | convert.joints_from_mp_world | MediaPipe world landmarks are meters
    if not world or len(world) < 25:
        return {}, {'body': 0.0, 'leftArm': 0.0, 'rightArm': 0.0}
    raw = []
    for landmark in world:
        x = float(getattr(landmark, 'x', landmark[0] if isinstance(landmark, (list, tuple)) else 0))
        y = float(getattr(landmark, 'y', landmark[1] if isinstance(landmark, (list, tuple)) else 0))
        z = float(getattr(landmark, 'z', landmark[2] if isinstance(landmark, (list, tuple)) else 0))
        raw.append(mp_world_to_canonical(x, y, z))
    hips = [0.0, 0.0, 0.0]
    if len(raw) > 24:
        hips = [(raw[23][i] + raw[24][i]) * 0.5 for i in range(3)]
    joints = {}
    for index, name in MP_INDEX.items():
        if index >= len(raw):
            continue
        point = raw[index]
        conf = 1.0
        if image is not None and index < len(image):
            src = image[index]
            conf = float(getattr(src, 'visibility', 1.0) or 1.0)
        joints[name] = [point[0] - hips[0], point[1] - hips[1], point[2] - hips[2], conf]
    if 'nose' in joints:
        joints['head'] = list(joints['nose'])
    quality = {
        'body': float(sum(joints[name][3] for name in ('leftShoulder', 'rightShoulder', 'leftHip', 'rightHip') if name in joints) / 4),
        'leftArm': min(joints.get('leftElbow', [0, 0, 0, 0])[3], joints.get('leftWrist', [0, 0, 0, 0])[3]),
        'rightArm': min(joints.get('rightElbow', [0, 0, 0, 0])[3], joints.get('rightWrist', [0, 0, 0, 0])[3]),
    }
    if mirror:
        joints = mirror_joints(joints)
        quality['leftArm'], quality['rightArm'] = quality['rightArm'], quality['leftArm']
    return joints, quality


def _hand_block(keypoints, start, wrist, span):
    if keypoints is None or start + 21 > len(keypoints) or wrist is None:
        return None
    landmarks = []
    for offset in range(21):
        src = _xyz(keypoints[start + offset])
        if src is None:
            return None
        canon = mp_world_to_canonical((src[0] - wrist[0]) / span, (src[1] - wrist[1]) / span, (src[2] - wrist[2]) / span)
        landmarks.append(canon)
    return landmarks


def joints_from_wholebody(keypoints_2d, scores, keypoints_3d=None, mirror=False, include_hands=True):
    # this [2026-09-25] | INFO | convert.joints_from_wholebody | RTMW3D stays unitless until the shoulder span looks metric
    import numpy as np
    if keypoints_2d is None:
        return {}, {'body': 0.0, 'leftArm': 0.0, 'rightArm': 0.0, 'leftHand': 0.0, 'rightHand': 0.0}, False, {}
    pts = np.asarray(keypoints_2d)
    scr = np.asarray(scores) if scores is not None else np.ones(pts.shape[:-1], dtype=np.float32)
    # this [2026-10-06] | FIX | convert.joints_from_wholebody | One best-scored person index shared by the 2D and 3D paths
    pick = 0
    if pts.ndim == 3:
        means = scr.reshape(scr.shape[0], -1).mean(axis=1)
        pick = int(np.argmax(means))
        pts = pts[pick]
        scr = scr[pick]
    k3d = None
    if keypoints_3d is not None:
        k3 = np.asarray(keypoints_3d)
        if k3.ndim == 3 and k3.shape[0]:
            k3d = k3[min(pick, k3.shape[0] - 1)]
        elif k3.ndim == 2:
            k3d = k3
    source = k3d if k3d is not None and len(k3d) > 16 else pts
    left_hip = _xyz(source[11]) if len(source) > 12 else None
    right_hip = _xyz(source[12]) if len(source) > 12 else None
    left_sh = _xyz(source[5]) if len(source) > 6 else None
    right_sh = _xyz(source[6]) if len(source) > 6 else None
    if not left_hip or not right_hip or not left_sh or not right_sh:
        return {}, {'body': 0.0, 'leftArm': 0.0, 'rightArm': 0.0, 'leftHand': 0.0, 'rightHand': 0.0}, False, {}
    hips = [(left_hip[i] + right_hip[i]) * 0.5 for i in range(3)]
    span = math.dist(left_sh, right_sh) or 1.0
    metric = 0.2 < span < 0.8 and k3d is not None
    scale = 1.0 if metric else span
    joints = {}
    for index, name in BODY_TO_NAME.items():
        src = _xyz(source[index]) if index < len(source) else None
        if src is None:
            continue
        canon = mp_world_to_canonical((src[0] - hips[0]) / scale, (src[1] - hips[1]) / scale, (src[2] - hips[2]) / scale)
        conf = float(scr[index]) if index < len(scr) else 1.0
        joints[name] = [canon[0], canon[1], canon[2], max(0.0, min(1.0, conf))]
    if 'nose' in joints:
        joints['head'] = list(joints['nose'])
    hands = {}
    if include_hands and len(source) > RIGHT_HAND + 20:
        for side, start, wrist_name in (('left', LEFT_HAND, 'leftWrist'), ('right', RIGHT_HAND, 'rightWrist')):
            block = _hand_block(source, start, _xyz(source[9 if side == 'left' else 10]), scale)
            if not block:
                continue
            wrist = joints.get(wrist_name) or [0, 0, 0, 1]
            placed = [[wrist[0] + p[0], wrist[1] + p[1], wrist[2] + p[2]] for p in block]
            score = float(np.mean(scr[start:start + 21])) if len(scr) > start + 20 else 0.5
            hands[side] = {'landmarks': placed, 'score': score}
    quality = {
        'body': float(np.mean(scr[:17])) if len(scr) >= 17 else 0.0,
        'leftArm': float(min(scr[7], scr[9])) if len(scr) > 9 else 0.0,
        'rightArm': float(min(scr[8], scr[10])) if len(scr) > 10 else 0.0,
        'leftHand': hands.get('left', {}).get('score', 0.0),
        'rightHand': hands.get('right', {}).get('score', 0.0),
        'face': 0.0,
    }
    if mirror:
        joints = mirror_joints(joints)
        quality['leftArm'], quality['rightArm'] = quality['rightArm'], quality['leftArm']
        quality['leftHand'], quality['rightHand'] = quality['rightHand'], quality['leftHand']
        if 'left' in hands or 'right' in hands:
            hands = {
                'left': hands.get('right'),
                'right': hands.get('left'),
            }
            hands = {key: value for key, value in hands.items() if value}
    return joints, quality, metric, hands
