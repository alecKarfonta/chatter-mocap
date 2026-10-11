"""Compatibility shim. The capture loop lives in mocap.capture.

this [2026-09-25] | INFO | pipeline | Older imports of run_app keep working.
"""

from mocap.capture import run_app
from mocap.config import support_dir

__all__ = ['run_app', 'support_dir']
