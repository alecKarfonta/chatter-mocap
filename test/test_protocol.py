"""Protocol and conversion checks for MocapFrame v1."""

from __future__ import annotations

import unittest

from mocap.protocol import (
    ChannelMerger,
    fit_arm_map,
    mirror_joints,
    mp_world_to_canonical,
    normalize_frame,
    pose_rows,
    validate_frame,
)
from mocap.sources.convert import joints_from_mp_world, joints_from_wholebody


class ProtocolTests(unittest.TestCase):
    def test_legacy_joints_become_v1(self):
        frame = normalize_frame({
            't': 10,
            'joints': {'leftWrist': {'x': 0.2, 'y': 0.1, 'z': -0.3}},
            'blendshapes': {'jawOpen': 0.4},
            'gaze': {'x': 0.2, 'y': -0.1},
        }, source='vision')
        self.assertEqual(frame['v'], 1)
        self.assertEqual(frame['body']['joints']['leftWrist'][:3], [0.2, 0.1, -0.3])
        self.assertIn('jawOpen', frame['face']['blendshapes'])
        self.assertEqual(validate_frame(frame), [])

    def test_hands_reject_short_landmarks(self):
        frame = normalize_frame({
            't': 1,
            'source': 'browser',
            'hands': {'left': {'landmarks': [[0, 0, 0]], 'score': 1}},
        })
        self.assertNotIn('hands', frame)

    def test_channel_merge_keeps_newest_section(self):
        merger = ChannelMerger(stale_ms=1000)
        merger.push({
            't': 1000,
            'source': 'vision',
            'body': {'metric': True, 'joints': {'head': [0, 0.5, 0, 1]}},
        })
        merged = merger.push({
            't': 1100,
            'source': 'browser',
            'face': {'blendshapes': {'jawOpen': 0.2}, 'gaze': {'x': 0, 'y': 0}},
        })
        self.assertIn('body', merged)
        self.assertIn('face', merged)
        self.assertEqual(merged['channels']['body'], 'vision')
        self.assertEqual(merged['channels']['face'], 'browser')

    def test_mp_world_axes(self):
        self.assertEqual(mp_world_to_canonical(1, 2, 3), [1, -2, -3])

    def test_mirror_swaps_sides(self):
        flipped = mirror_joints({'leftWrist': [0.2, 0.1, 0, 1]})
        self.assertIn('rightWrist', flipped)
        self.assertAlmostEqual(flipped['rightWrist'][0], -0.2)

    def test_mp_world_landmarks(self):
        class Lm:
            def __init__(self, x, y, z, visibility=1):
                self.x = x
                self.y = y
                self.z = z
                self.visibility = visibility

        world = [Lm(0, 0, 0) for _ in range(33)]
        world[23] = Lm(-0.1, 0, 0)
        world[24] = Lm(0.1, 0, 0)
        world[15] = Lm(-0.4, 0.2, 0.1)
        joints, quality = joints_from_mp_world(world, world, mirror=False)
        self.assertIn('leftWrist', joints)
        self.assertGreater(quality['body'], 0)

    def test_arm_map_corrects_swapped_down_and_forward(self):
        def joints(left, right):
            return {
                'leftShoulder': {'x': 0.2, 'y': 0.4, 'z': 0},
                'rightShoulder': {'x': -0.2, 'y': 0.4, 'z': 0},
                'leftElbow': {'x': 0.2 + left[0] * 0.5, 'y': 0.4 + left[1] * 0.5, 'z': left[2] * 0.5},
                'rightElbow': {'x': -0.2 + right[0] * 0.5, 'y': 0.4 + right[1] * 0.5, 'z': right[2] * 0.5},
                'leftWrist': {'x': 0.2 + left[0], 'y': 0.4 + left[1], 'z': left[2]},
                'rightWrist': {'x': -0.2 + right[0], 'y': 0.4 + right[1], 'z': right[2]},
            }
        poses = {
            'down': joints((0, 0, -0.5), (0, 0, -0.5)),
            'out': joints((0.5, 0, 0), (-0.5, 0, 0)),
            'forward': joints((0, 0.5, 0), (0, 0.5, 0)),
        }
        fitted = fit_arm_map(poses)
        self.assertTrue(fitted['ok'], fitted)
        for side in ('left', 'right'):
            self.assertLess(fitted['arms'][side]['errorDeg']['down'], 2)
            self.assertLess(fitted['arms'][side]['errorDeg']['forward'], 2)

    def test_wholebody_picks_best_scored_person_3d(self):
        # this [2026-10-06] | INFO | test_wholebody_picks_best_scored_person_3d | 3D keypoints must follow the best-scored person, not person 0
        import numpy as np

        def person(wrist_x, score):
            # this [2026-10-06] | INFO | test.person | COCO-WholeBody: 5/6 shoulders, 7 elbow, 9 wrist, 11/12 hips
            pts = np.zeros((133, 3), dtype=np.float32)
            pts[5] = [-0.2, -0.4, 0]
            pts[6] = [0.2, -0.4, 0]
            pts[7] = [-0.2, -0.6, 0]
            pts[9] = [wrist_x, -0.8, 0]  # left wrist marks the person
            pts[11] = [-0.1, 0, 0]
            pts[12] = [0.1, 0, 0]
            scr = np.full((133,), score, dtype=np.float32)
            return pts, scr

        weak, weak_scr = person(wrist_x=0.9, score=0.2)
        strong, strong_scr = person(wrist_x=-0.7, score=0.95)
        keypoints_2d = np.stack([weak, strong])
        scores = np.stack([weak_scr, strong_scr])
        # 3D stream only contains the strong person in this test's intent, but if it holds both,
        # the shared pick must select index 1 (the strong one).
        keypoints_3d = keypoints_2d.copy()
        joints, _quality, _metric, _hands = joints_from_wholebody(
            keypoints_2d, scores, keypoints_3d=keypoints_3d, mirror=False, include_hands=False,
        )
        self.assertIn('leftWrist', joints)
        # canonical space flips Y: raw -0.8 up becomes +0.8, hips-relative keeps x at wrist_x / scale * ... — assert on the marker value
        marker = joints['leftWrist'][0]
        self.assertLess(marker, 0, 'wholebody conversion must use the best-scored person (wrist_x=-0.7), got %s' % marker)
        self.assertAlmostEqual(joints['leftWrist'][3], 0.95, places=2)

    def test_pose_row_reports_the_angle_off_the_named_pose(self):
        straight_down = {
            'leftShoulder': {'x': 0, 'y': 0, 'z': 0},
            'leftWrist': {'x': 0, 'y': -0.4, 'z': 0},
            'rightShoulder': {'x': 0, 'y': 0, 'z': 0},
            'rightWrist': {'x': 0, 'y': -0.4, 'z': 0},
        }
        turned = {
            'leftShoulder': {'x': 0, 'y': 0, 'z': 0},
            'leftWrist': {'x': 0, 'y': 0, 'z': -0.4},
            'rightShoulder': {'x': 0, 'y': 0, 'z': 0},
            'rightWrist': {'x': 0, 'y': 0, 'z': -0.4},
        }
        self.assertLess(pose_rows('down', straight_down)[0]['angle'], 2)
        self.assertGreater(pose_rows('down', turned)[0]['angle'], 80)


if __name__ == '__main__':
    unittest.main()
