"""CLI: python -m mocap --camera 0 --target local --vrm ~/avatar.vrm"""

from __future__ import annotations

import argparse

from mocap.capture import run_app


def build_parser():
    parser = argparse.ArgumentParser(
        prog='python -m mocap',
        description='Mocap capture that drives remote Chatter /view, a local VRM, or both.',
    )
    parser.add_argument('--camera', type=int, default=0, help='OpenCV camera index')
    parser.add_argument('--avatar', default='http://127.0.0.1:8008', help='Remote /view Socket.IO URL')
    parser.add_argument(
        '--target',
        choices=('remote', 'local', 'both'),
        default='remote',
        help='remote=/view only, local=on-device VRM viewer, both=publish to each',
    )
    parser.add_argument('--vrm', default='', help='VRM file for the local viewer')
    parser.add_argument('--local-host', default='127.0.0.1')
    parser.add_argument('--local-port', type=int, default=8765)
    parser.add_argument('--open-viewer', dest='open_viewer', action='store_true', default=None)
    parser.add_argument('--no-open-viewer', dest='open_viewer', action='store_false')
    parser.add_argument('--embed', action='store_true', help='Open the local viewer in a native window')
    parser.add_argument('--no-window', action='store_true', help='Skip the OpenCV debug window')
    parser.add_argument('--mirror', action='store_true', help='Selfie flip (image + X)')
    parser.add_argument('--device', choices=('cuda', 'cpu', 'mps', 'auto'), default='auto')
    parser.add_argument(
        '--source',
        choices=('auto', 'mediapipe', 'rtmlib', 'dummy'),
        default='auto',
        help='auto=RTMW3D on CUDA, MediaPipe when requested. dummy skips the camera.',
    )
    parser.add_argument(
        '--backend',
        choices=('auto', 'mediapipe', 'rtmlib', 'body3d'),
        default=None,
        help='Deprecated alias for --source',
    )
    parser.add_argument('--mode', choices=('balanced', 'performance', 'lightweight'), default='balanced')
    parser.add_argument(
        '--hub-only',
        action='store_true',
        help='Serve the local VRM hub and wait for native Vision /api/ingest frames',
    )
    parser.add_argument('--width', type=int, default=1280)
    parser.add_argument('--height', type=int, default=720)
    parser.add_argument('--no-face', action='store_true', help='Skip MediaPipe face blendshapes')
    parser.add_argument('--no-hands', action='store_true', help='Do not stream finger joints')
    parser.add_argument('--no-publish', action='store_true', help='Do not stream to remote /view')
    parser.add_argument('--dummy', action='store_true', help='Publish a synthetic wave without a camera')
    return parser


def main():
    args = build_parser().parse_args()
    run_app(args)


if __name__ == '__main__':
    main()
