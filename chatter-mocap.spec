# this [2026-10-11] | INFO | spec | PyInstaller one-file build; datas ship the viewer + retargeter libs inside the binary
# Build: pyinstaller chatter-mocap.spec  (icons: python scripts/make_icon.py first)

import sys
from pathlib import Path

ROOT = Path(SPECPATH)

block_cipher = None

datas = [
    ('mocap/viewer', 'mocap/viewer'),
    ('mocap/viewer_lib', 'mocap/viewer_lib'),
    ('mocap/schema', 'mocap/schema'),
]

a = Analysis(
    ['launcher.py'],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=[
        # this [2026-10-11] | INFO | spec.hidden | Modules imported lazily inside functions that PyInstaller misses
        'aiohttp',
        'engineio.async_drivers.aiohttp',
        'socketio',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # this [2026-10-11] | INFO | spec.excludes | Camera-loop deps the browser-source binary never touches
        'cv2',
        'mediapipe',
        'rtmlib',
        'tkinter',
        'matplotlib',
        'pandas',
    ],
    win_no_prefer_redirects=False,
    win_private_asl=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='chatter-mocap',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # this [2026-10-11] | INFO | spec.icon | Platform icon from scripts/make_icon.py
    icon='build/icon.ico' if sys.platform == 'win32' else 'build/icon.icns',
)
