# Chatter Mocap

Browser-based motion capture for VRM avatars. Point your webcam at yourself, load a VRM model, and puppet it in real time — no depth camera, no suit, no install beyond a Python one-liner.

![status](https://img.shields.io/badge/status-beta-green) ![license](https://img.shields.io/badge/license-MIT-blue)

## What it does

- **Live full-body tracking** from a plain webcam (MediaPipe pose + face + hands, all in the browser)
- **VRM avatar rendering** with three.js and @pixiv/three-vrm
- **Guided arm calibration** — three poses (arms down, out, forward) teach the solver your proportions so the avatar's arms follow yours accurately from any angle
- **Face blendshapes** — blink, jaw, smile, brow, and gaze mapped onto the model's expressions
- **Finger tracking** — 21-point hand skeletons per hand
- **Stage backgrounds** — studio gradient, chroma key (green/blue/magenta) for streaming, or true transparency for OBS browser sources
- **Big Avatar mode** — one click to fill the window with the avatar
- **Model library** — upload any `.vrm` and switch between models instantly
- **Recording & replay** of capture sessions

## Quick start

```bash
git clone https://github.com/alecKarfonta/chatter-mocap.git
cd chatter-mocap
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python -m mocap --hub-only --target local
```

Open **http://127.0.0.1:8765**, allow the camera, and you're tracking. First run downloads a sample VRM model automatically — or use the Model panel to upload your own.

## How to use it

1. **Allow the camera** and step back so your torso is fully visible
2. **Pick or upload a model** in the Model panel
3. **Calibrate** — open the Calibrate panel and copy the three arm poses; each counts down from 3 and records 2 seconds
4. Optional: capture a **neutral stance** so the avatar eases back to your relaxed pose when tracking drops

### Tips

- Stand 2–3 m from the camera with even front lighting
- If arms drift, re-run calibration and exaggerate each pose slightly
- Seated? Enable **Seated (lock legs)** in the Body panel
- The **Fit overlay** button draws cyan lines where the camera thinks your arms should be — handy while trimming

## Sources

| Source | How it runs | Needs |
|---|---|---|
| Browser camera | MediaPipe in the browser | nothing extra |
| Mac Vision | Apple Vision via a native host posting to `/api/ingest` | macOS |
| Python GPU | RTMW3D / MediaPipe from this process | `opencv-python`, `mediapipe`, `rtmlib` |

The default browser source works everywhere with zero extra installs.

## Layout

```
mocap/
  local_hub.py       HTTP + Socket.IO hub (aiohttp)
  protocol.py        MocapFrame v1: normalize, merge, calibration math
  capture.py         Camera loop (optional ML sources)
  viewer/            The web UI (Material 3)
  viewer_lib/        Retargeter: pose → VRM bone solver
  schema/            mocap-frame.v1.json, mapping-profile.v1.json
test/                Protocol + hub flow tests
```

## Protocol

Frames flow over Socket.IO (`mocap-frame`) as `MocapFrame v1` JSON — see [`mocap/schema/mocap-frame.v1.json`](mocap/schema/mocap-frame.v1.json). Any client can `POST /api/ingest` a frame to drive the viewer, which is how the Mac Vision source works.

## Development

```bash
pip install -r requirements.txt pytest
pytest test/ -q
```

## License

[MIT](LICENSE)
