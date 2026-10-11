import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { MocapRetargeter } from '/mocap/retargeter.js?v=fit1';
import { mergeProfile } from '/mocap/mapping-profile.js';
import { BrowserMocapSource, listCameras } from '/mocap/source-browser.js?v=fit3';
import { normalizeFrame } from '/mocap/protocol.js?v=fit1';

// this [2026-10-11] | FIX | viewer-client.embed | ?embed=1: the native app hosts the camera; the in-page camera pane is never rendered (this was the "duplicated camera view")
const embedded = new URLSearchParams(location.search).get('embed') === '1';
if (embedded) document.body.classList.add('embed');
// this [2026-10-11] | INFO | viewer-client.nativeBridge | WKWebView message handler; lets the in-page HUD drive the native split view
const nativeBridge = window.webkit?.messageHandlers?.chatterNative || null;

// this [2026-10-06] | INFO | viewer-client.theater | Native app drives a stage-fills-everything mode via URL or JS bridge
const theater = {
    on: false,
    panels: false,
    apply() {
        document.body.classList.toggle('theater', this.on);
        document.body.classList.toggle('theater-panels', this.panels && this.on);
        // this [2026-10-11] | INFO | theater.apply | Panel visibility is pure CSS (body.theater.theater-panels .side); no inline styles to fight
        const hud = document.getElementById('theater-hud');
        if (hud) {
            const controlsButton = document.getElementById('theater-controls');
            if (controlsButton) controlsButton.textContent = this.panels ? '✕ Tune' : '☰ Tune';
        }
        const theaterBtn = document.getElementById('theater-btn');
        if (theaterBtn) theaterBtn.classList.toggle('on', this.on);
        ui.resize?.();
        setTimeout(() => ui.resize?.(), 60);
    },
        set(on, fromNative = false) {
            this.on = Boolean(on);
            this.panels = false;
            this.apply();
            // this [2026-10-06] | INFO | theater.set | Pull back a touch so the whole avatar frames nicely when huge
            if (ui.camera && ui.controls) {
                ui.camera.position.set(0, 1.15, this.on ? 3.1 : 2.4);
                ui.controls.target.set(0, 1.0, 0);
            }
            // this [2026-10-11] | FIX | theater.set | Tell the native split view when the user exits big-avatar mode from the page
            if (!fromNative && nativeBridge) nativeBridge.postMessage({ theater: this.on });
            // this [2026-10-11] | FIX | theater.set | Return true so the native bridge sees success and skips the full-page reload (reload duplicated the canvas)
            return true;
        },
};
window.__chatterTheater = theater;
// this [2026-10-06] | INFO | theater.boot | CSS class only at module-eval time; ui is in its temporal dead zone here
if (new URLSearchParams(location.search).get('theater') === '1') {
    theater.on = true;
    document.body.classList.add('theater');
    document.getElementById('theater-btn')?.classList.add('on');
}
// this [2026-10-11] | INFO | theater.hud | Exit button tells the native app (bridge) before falling back to in-page mode
document.getElementById('theater-exit')?.addEventListener('click', () => theater.set(false));
document.getElementById('theater-controls')?.addEventListener('click', () => {
    theater.panels = !theater.panels;
    theater.apply();
});

const GHOST_LINKS = [
    ['leftShoulder', 'rightShoulder'],
    ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'],
    ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'],
    ['leftShoulder', 'leftHip'], ['rightShoulder', 'rightHip'],
    ['leftHip', 'rightHip'],
    ['leftHip', 'leftKnee'], ['leftKnee', 'leftAnkle'],
    ['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle'],
    ['nose', 'leftShoulder'], ['nose', 'rightShoulder'],
];

function createGhost(scene) {
    // this [2026-09-28] | INFO | createGhost | Yellow stick is the converted pose, standing beside the VRM
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(GHOST_LINKS.length * 6), 3));
    // this [2026-10-06] | FIX | createGhost | No depth test: the stick is scaled to the VRM so it sits inside the mesh and would be fully occluded
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
        color: 0xffe27a, depthTest: false, transparent: true,
    }));
    lines.renderOrder = 999;
    lines.frustumCulled = false;
    lines.visible = false;
    scene.add(lines);
    return lines;
}

const _ghostOrigin = new THREE.Vector3();
const _ghostHead = new THREE.Vector3();

function updateGhost(lines, frame, vrm) {
    if (!lines) return;
    const joints = frame?.body?.joints;
    const positions = lines.geometry.getAttribute('position').array;
    let visible = false;
    // this [2026-10-06] | INFO | updateGhost | Anchor to VRM hips AND scale to VRM proportions; human legs on a chibi rig look broken
    let originX = 0;
    let originY = 0.95;
    let originZ = 0;
    let scale = 1;
    if (vrm?.humanoid?.getRawBoneNode) {
        const hips = vrm.humanoid.getRawBoneNode('hips');
        const head = vrm.humanoid.getRawBoneNode('head');
        if (hips) {
            hips.getWorldPosition(_ghostOrigin);
            originX = _ghostOrigin.x;
            originY = _ghostOrigin.y;
            originZ = _ghostOrigin.z;
        }
        if (hips && head) {
            head.getWorldPosition(_ghostHead);
            const vrmSpine = _ghostHead.y - _ghostOrigin.y;
            const hipL = joints?.leftHip;
            const hipR = joints?.rightHip;
            const skHead = joints?.head || joints?.nose;
            if (vrmSpine > 0.2 && hipL && hipR && skHead) {
                const skSpine = skHead[1] - (hipL[1] + hipR[1]) / 2;
                if (skSpine > 0.2) scale = vrmSpine / skSpine;
            }
        }
    }
    for (let index = 0; index < GHOST_LINKS.length; index += 1) {
        const [aName, bName] = GHOST_LINKS[index];
        const a = joints?.[aName];
        const b = joints?.[bName];
        const offset = index * 6;
        if (!a || !b) {
            positions.fill(0, offset, offset + 6);
            continue;
        }
        visible = true;
        positions[offset] = originX + a[0] * scale;
        positions[offset + 1] = originY + a[1] * scale;
        positions[offset + 2] = originZ + a[2] * scale;
        positions[offset + 3] = originX + b[0] * scale;
        positions[offset + 4] = originY + b[1] * scale;
        positions[offset + 5] = originZ + b[2] * scale;
    }
    lines.geometry.getAttribute('position').needsUpdate = true;
    // this [2026-10-06] | FIX | updateGhost | Respect the toggle; joints present AND user wants it on
    lines.visible = visible && lines.userData.userOn !== false;
}

function createFitOverlay() {
    // this [2026-09-30] | INFO | createFitOverlay | Cyan is where the camera says each arm should be. Drawn on top of the VRM.
    const scene = new THREE.Scene();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 6), 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x4fd2ff, depthTest: false, transparent: true }));
    lines.frustumCulled = false;
    scene.add(lines);
    const dotGeo = new THREE.SphereGeometry(0.022, 10, 8);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xffe27a, depthTest: false, transparent: true });
    const dots = Array.from({ length: 6 }, () => {
        const dot = new THREE.Mesh(dotGeo, dotMat);
        dot.frustumCulled = false;
        scene.add(dot);
        return dot;
    });
    return { scene, lines, dots, on: true };
}

function updateFitOverlay(fit, retargeter, vrm) {
    // this [2026-09-30] | INFO | updateFitOverlay | Cyan lines: where the camera says each arm should be. Text HUD removed — solver states confused users.
    const arms = retargeter?.body?.trace?.arms || {};
    const positions = fit.lines.geometry.getAttribute('position').array;
    positions.fill(0);
    fit.dots.forEach((dot) => { dot.visible = false; });
    vrm?.scene?.updateMatrixWorld(true);
    ['left', 'right'].forEach((side, index) => {
        const info = arms[side];
        if (!info?.shoulder || !info?.elbow || !info?.target) return;
        const pts = [info.shoulder, info.elbow, info.target];
        const base = index * 12;
        positions.set([...pts[0], ...pts[1]], base);
        positions.set([...pts[1], ...pts[2]], base + 6);
        pts.forEach((point, dotIndex) => {
            const dot = fit.dots[index * 3 + dotIndex];
            dot.position.set(point[0], point[1], point[2]);
            dot.visible = fit.on;
        });
    });
    fit.lines.geometry.getAttribute('position').needsUpdate = true;
    fit.lines.visible = fit.on;
}

const statusNode = document.getElementById('status');
function setStatus(text) { if (statusNode) statusNode.textContent = text; }

// this [2026-10-11] | INFO | viewer-client.background | Stage background: studio gradient, chroma color, or true alpha for OBS
let bgStage = null; // { scene, renderer }
function applyBackground(kind) {
    localStorage.setItem('mocap-bg', kind);
    const box = document.getElementById('stage-box');
    if (!box || !bgStage) return;
    const chroma = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(kind);
    if (kind === 'studio') {
        bgStage.scene.background = null;
        bgStage.renderer.setClearColor(0x000000, 0);
        box.className = 'bg-studio';
    } else if (kind === 'transparent') {
        bgStage.scene.background = null;
        bgStage.renderer.setClearColor(0x000000, 0);
        box.className = 'bg-transparent';
    } else if (chroma) {
        bgStage.scene.background = new THREE.Color(kind);
        box.className = '';
    }
    document.querySelectorAll('#bg-swatches .swatch').forEach((s) => s.classList.toggle('on', s.dataset.bg === kind));
    const custom = document.getElementById('bg-custom');
    if (custom && chroma) custom.value = kind.length === 4
        ? `#${kind[1]}${kind[1]}${kind[2]}${kind[2]}${kind[3]}${kind[3]}` : kind;
}
window.__chatterApplyBackground = applyBackground;

const ui = {
    profile: null,
    vrmName: '',
    source: null,
    retargeter: null,
    vrm: null,
    debug: false,
    lastFrame: null,
    camera: null,
    controls: null,
};

// this [2026-10-11] | INFO | viewer-client.tabs | Removed: side panel is now collapsible details groups, no tab bar

async function saveProfile() {
    if (!ui.profile || !ui.vrmName) return;
    await fetch(`/api/profiles/${encodeURIComponent(ui.vrmName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ui.profile),
    });
    ui.retargeter?.setProfile(ui.profile);
}

function buildTrimControls() {
    // this [2026-10-01] | INFO | buildTrimControls | Per-arm world-space trim sliders, saved into the profile
    for (const host of document.querySelectorAll('.trim-arm')) {
        const side = host.dataset.side;
        const label = side === 'left' ? 'Left arm' : 'Right arm';
        for (const [seg, name] of [['Upper', 'upper arm'], ['Lower', 'forearm']]) {
            const segWrap = document.createElement('div');
            segWrap.className = 'seg';
            segWrap.textContent = name;
            for (const axis of ['x', 'y', 'z']) {
                const id = `trim-${side}-${seg}-${axis}`;
                const row = document.createElement('label');
                row.textContent = `${axis.toUpperCase()} ${axis === 'x' ? 'swing' : axis === 'y' ? 'twist' : 'lift'}`;
                const input = document.createElement('input');
                input.type = 'range';
                input.min = '-45';
                input.max = '45';
                input.step = '1';
                input.value = '0';
                input.id = id;
                row.append(input);
                segWrap.append(row);
            }
            host.append(segWrap);
        }
        host.querySelector('strong').textContent = label;
    }
}
buildTrimControls();

function readTrimControls() {
    if (!ui.profile) return;
    ui.profile.armOffsets = ui.profile.armOffsets || {};
    for (const side of ['left', 'right']) {
        for (const seg of ['Upper', 'Lower']) {
            const key = `${side}${seg}`;
            ui.profile.armOffsets[key] = ['x', 'y', 'z'].map((axis) => {
                const el = document.getElementById(`trim-${side}-${seg}-${axis}`);
                return Number(el?.value || 0);
            });
        }
    }
}

function loadTrimControls() {
    if (!ui.profile?.armOffsets) return;
    for (const side of ['left', 'right']) {
        for (const seg of ['Upper', 'Lower']) {
            const spec = ui.profile.armOffsets[`${side}${seg}`] || [0, 0, 0];
            ['x', 'y', 'z'].forEach((axis, index) => {
                const el = document.getElementById(`trim-${side}-${seg}-${axis}`);
                if (el) el.value = spec[index];
            });
        }
    }
}

for (const side of ['left', 'right']) {
    for (const seg of ['Upper', 'Lower']) {
        for (const axis of ['x', 'y', 'z']) {
            const id = `trim-${side}-${seg}-${axis}`;
            document.getElementById(id)?.addEventListener('input', () => {
                readTrimControls();
                ui.retargeter?.setProfile(ui.profile);
            });
            document.getElementById(id)?.addEventListener('change', () => {
                readTrimControls();
                ui.retargeter?.setProfile(ui.profile);
                saveProfile();
            });
        }
    }
}

function readProfileControls() {
    if (!ui.profile) return;
    ui.profile.smoothing.body = Number(document.getElementById('smooth-body').value);
    ui.profile.smoothing.arms = Number(document.getElementById('smooth-arms').value);
    ui.profile.smoothing.legs = Number(document.getElementById('smooth-legs').value);
    ui.profile.seated = document.getElementById('seated').checked;
    ui.profile.fingers.enabled = document.getElementById('hands-on').checked;
    ui.profile.fingers.curlGain = Number(document.getElementById('curl').value);
    ui.profile.fingers.splayGain = Number(document.getElementById('splay').value);
    const arms = document.getElementById('bone-arms').checked;
    const torso = document.getElementById('bone-torso').checked;
    const legs = document.getElementById('bone-legs').checked && !ui.profile.seated;
    for (const [name, spec] of Object.entries(ui.profile.bones || {})) {
        if (/Arm|Hand|Shoulder/.test(name)) spec.enabled = arms;
        if (/hips|spine|chest|Chest|neck|head/.test(name)) spec.enabled = torso;
        if (/Leg|Foot/.test(name)) spec.enabled = legs;
    }
    ui.retargeter?.setProfile(ui.profile);
}

['smooth-body', 'smooth-arms', 'smooth-legs', 'seated', 'hands-on', 'curl', 'splay', 'bone-arms', 'bone-torso', 'bone-legs'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => { readProfileControls(); saveProfile(); });
    document.getElementById(id)?.addEventListener('input', readProfileControls);
});

const PREVIEW_BONES = [
    ['leftShoulder', 'rightShoulder'],
    ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'],
    ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'],
    ['leftShoulder', 'leftHip'], ['rightShoulder', 'rightHip'],
    ['leftHip', 'rightHip'],
    ['leftHip', 'leftKnee'], ['leftKnee', 'leftAnkle'],
    ['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle'],
];

function drawOverlay(frame) {
    // this [2026-09-28] | FIX | drawOverlay | Draw camera landmarks, not hip-relative meters
    const canvas = document.getElementById('overlay');
    const video = document.getElementById('video');
    if (!canvas || !video) return;
    const width = video.clientWidth || 320;
    const height = video.clientHeight || 240;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    const joints = frame?.preview?.joints;
    if (!joints) return;
    const at = (name) => {
        const point = joints[name];
        if (!point) return null;
        return { x: point[0] * width, y: point[1] * height };
    };
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (const [a, b] of PREVIEW_BONES) {
        const pa = at(a);
        const pb = at(b);
        if (!pa || !pb) continue;
        const left = a.startsWith('left') || b.startsWith('left');
        ctx.strokeStyle = left ? '#4fd2ff' : '#ff8a4c';
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
    }
    for (const name of Object.keys(joints)) {
        const point = at(name);
        if (!point) continue;
        ctx.fillStyle = name.startsWith('left') ? '#4fd2ff' : name.startsWith('right') ? '#ff8a4c' : '#ffe27a';
        ctx.beginPath();
        ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
        ctx.fill();
    }
    // this [2026-10-11] | INFO | drawOverlay.face | Face-mesh dots: native Vision and browser MediaPipe both send preview.face now
    const face = frame?.preview?.face;
    if (face && Array.isArray(face)) {
        ctx.fillStyle = 'rgba(120, 220, 255, 0.85)';
        for (const point of face) {
            if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
            ctx.beginPath();
            ctx.arc(point[0] * width, point[1] * height, 1.6, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

function faceBars(frame) {
    const host = document.getElementById('face-bars');
    if (!host) return;
    const blend = frame?.face?.blendshapes || {};
    const keys = ['eyeBlinkLeft', 'eyeBlinkRight', 'jawOpen', 'mouthSmileLeft', 'browInnerUp'];
    host.innerHTML = keys.map((key) => {
        const value = Math.max(0, Math.min(1, Number(blend[key]) || 0));
        return `<div>${key} ${value.toFixed(2)}</div><div class="bar"><span style="width:${value * 100}%"></span></div>`;
    }).join('');
    const hand = frame?.hands?.left?.landmarks;
    const readout = document.getElementById('curl-readout');
    if (readout && hand) {
        const a = hand[5]; const b = hand[6]; const c = hand[7];
        const v1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
        const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
        const n1 = Math.hypot(...v1) || 1;
        const n2 = Math.hypot(...v2) || 1;
        const curl = Math.acos(Math.min(1, Math.max(-1, dot / (n1 * n2))));
        readout.textContent = `Index curl ${(curl * 180 / Math.PI).toFixed(0)}°`;
    }
}

async function loadVrm(url, rendererScene) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    VRMUtils.rotateVRM0(vrm);
    if (ui.vrm) rendererScene.remove(ui.vrm.scene);
    rendererScene.add(vrm.scene);
    ui.vrm = vrm;
    return vrm;
}

async function refreshLibrary() {
    const data = await fetch('/api/vrms').then((r) => r.json());
    const host = document.getElementById('vrm-list');
    host.innerHTML = '';
    for (const file of data.files || []) {
        const card = document.createElement('div');
        card.className = 'card' + (file.selected ? ' on' : '');
        card.textContent = file.name;
        card.addEventListener('click', async () => {
            await fetch('/api/vrms/select', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: file.name }),
            });
        });
        host.appendChild(card);
    }
}

const ARM_MAPS = [
    { id: 'A', name: 'X Y Z', m: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    { id: 'B', name: 'X −Y Z', m: [1, 0, 0, 0, -1, 0, 0, 0, 1] },
    { id: 'C', name: 'X Y −Z', m: [1, 0, 0, 0, 1, 0, 0, 0, -1] },
    { id: 'D', name: 'X Z Y', m: [1, 0, 0, 0, 0, 1, 0, 1, 0] },
    { id: 'E', name: 'X −Z Y', m: [1, 0, 0, 0, 0, 1, 0, -1, 0] },
    { id: 'F', name: 'X Z −Y', m: [1, 0, 0, 0, 0, -1, 0, 1, 0] },
];

const ARM_POSES = [
    { id: 'down', name: 'Down', dir: [0, -1, 0] },
    { id: 'out', name: 'Out', dir: [1, 0, 0] },
    { id: 'forward', name: 'Forward', dir: [0, 0, 1] },
    { id: 'up', name: 'Up', dir: [0, 1, 0] },
    { id: 'bent', name: 'Bent', dir: null },
];

const ROUND_TRIP_POSES = [
    { id: 'down', name: 'Arms down', el: [0.05, -0.28, 0], wr: [0.06, -0.52, 0] },
    { id: 'out', name: 'Arms out', el: [0.3, 0.05, 0], wr: [0.6, 0.08, 0] },
    { id: 'up', name: 'Arms up', el: [0.03, 0.32, 0], wr: [0.05, 0.62, 0] },
    { id: 'fwd', name: 'Reach forward', el: [0.1, -0.1, 0.26], wr: [0.12, -0.16, 0.5] },
    { id: 'bent', name: 'Elbows bent', el: [0.26, -0.02, 0.06], wr: [0.3, -0.3, 0.1] },
    { id: 'akimbo', name: 'Hands on hips', el: [0.26, -0.14, 0.02], wr: [0.14, -0.3, 0.06] },
];

async function runRoundTrip(renderer, scene, camera, controls, ghost, fit) {
    // this [2026-10-01] | INFO | runRoundTrip | Exact-math judge: known skeletons through the real retargeter, then read the posed arm back and compare flat-camera views
    const out = document.getElementById('roundtrip-out');
    const button = document.getElementById('roundtrip-run');
    const vrm = ui.vrm;
    const retargeter = ui.retargeter;
    if (!out || !vrm?.humanoid || !retargeter) return;
    if (!button || button.disabled) return;
    button.disabled = true;
    out.textContent = 'Posing the VRM…';
    const prevLabOn = ui.armLab?.on;
    const prevFit = fit?.on;
    if (prevLabOn) stopArmLab();
    if (fit) fit.on = false;
    const humanoid = vrm.humanoid;
    const prevSize = new THREE.Vector2();
    renderer.getSize(prevSize);
    const prevAspect = camera.aspect;
    const camPos = camera.position.clone();
    const camTarget = controls.target.clone();
    renderer.setSize(480, 640, false);
    camera.aspect = 480 / 640;
    camera.fov = 30;
    camera.position.set(0, 1, 3.2);
    controls.target.set(0, 0.95, 0);
    camera.lookAt(controls.target);
    camera.updateProjectionMatrix();
    const worldOf = (name) => humanoid.getRawBoneNode(name)?.getWorldPosition(new THREE.Vector3());
    const restoreRest = () => {
        for (const [name, quat] of Object.entries(retargeter.restQuats)) {
            const node = humanoid.getNormalizedBoneNode(name);
            if (node && quat) node.quaternion.copy(quat);
        }
        humanoid.update?.();
        vrm.scene.updateMatrixWorld(true);
    };
    const rows = [];
    const shotWrap = document.getElementById('roundtrip-shots');
    if (shotWrap) shotWrap.innerHTML = '';
    let worst = 0;
    const deg = (a, b) => {
        const d = Math.abs(a - b) % Math.PI;
        return Math.min(d, Math.PI - d) * 180 / Math.PI;
    };
    for (const pose of ROUND_TRIP_POSES) {
        const joints = {
            hips: [0, 0, 0, 1],
            head: [0, 0.75, 0, 1],
            nose: [0, 0.75, 0, 1],
            leftShoulder: [0.19, 0.55, 0, 1],
            rightShoulder: [-0.19, 0.55, 0, 1],
            leftHip: [0.1, -0.02, 0, 1],
            rightHip: [-0.1, -0.02, 0, 1],
            leftElbow: [0.19 + pose.el[0], 0.55 + pose.el[1], pose.el[2], 1],
            rightElbow: [-0.19 - pose.el[0], 0.55 + pose.el[1], pose.el[2], 1],
            leftWrist: [0.19 + pose.wr[0], 0.55 + pose.wr[1], pose.wr[2], 1],
            rightWrist: [-0.19 - pose.wr[0], 0.55 + pose.wr[1], pose.wr[2], 1],
        };
        const frame = normalizeFrame({
            t: Date.now(),
            source: 'roundtrip',
            body: { metric: true, joints },
            quality: { body: 1, leftArm: 1, rightArm: 1 },
        });
        retargeter.reset();
        retargeter.applyFrame(frame, 1 / 60);
        vrm.scene.updateMatrixWorld(true);
        renderer.render(scene, camera);
        const posePixels = renderer.domElement.toDataURL('image/jpeg', 0.92);
        const line = [pose.name];
        for (const side of ['left', 'right']) {
            const sign = side === 'left' ? 1 : -1;
            const shoulder = worldOf(`${side}UpperArm`);
            const elbow = worldOf(`${side}LowerArm`);
            const hand = worldOf(`${side}Hand`);
            if (!shoulder || !elbow || !hand) {
                line.push(`${side} bones missing`);
                continue;
            }
            const gotUpper = Math.atan2(elbow.x - shoulder.x, elbow.y - shoulder.y);
            const gotFore = Math.atan2(hand.x - elbow.x, hand.y - elbow.y);
            const wantUpper = Math.atan2(sign * pose.el[0], pose.el[1]);
            const wantFore = Math.atan2(sign * (pose.wr[0] - pose.el[0]), pose.wr[1] - pose.el[1]);
            const upperErr = deg(gotUpper, wantUpper);
            const foreErr = deg(gotFore, wantFore);
            worst = Math.max(worst, upperErr, foreErr);
            const scale = Math.hypot(pose.el[0], pose.el[1]) > 1e-4
                ? Math.hypot(elbow.x - shoulder.x, elbow.y - shoulder.y) / Math.hypot(pose.el[0], pose.el[1])
                : null;
            line.push(`${side} upper ${upperErr.toFixed(1)}° fore ${foreErr.toFixed(1)}°${scale == null ? '' : ` len ×${scale.toFixed(2)}`}`);
        }
        rows.push({ pose: pose.name, note: line.join(' · ') });
        if (shotWrap) {
            const thumb = document.createElement('figure');
            thumb.className = 'map-shot';
            const img = document.createElement('img');
            img.alt = pose.name;
            img.src = posePixels;
            const cap = document.createElement('p');
            cap.textContent = line.join(' · ');
            thumb.append(img, cap);
            shotWrap.append(thumb);
        }
        out.textContent = rows.map((row) => row.note).join('\n');
        await new Promise((resolve) => setTimeout(resolve, 16));
    }
    restoreRest();
    renderer.setSize(prevSize.x, prevSize.y, false);
    camera.fov = 30;
    camera.aspect = prevAspect;
    camera.position.copy(camPos);
    controls.target.copy(camTarget);
    camera.updateProjectionMatrix();
    ui.resize?.();
    if (fit) fit.on = prevFit !== false;
    const summary = document.createElement('p');
    const label = worst > 25 ? 'The loop is broken somewhere.' : worst > 12 ? 'The loop drifts.' : 'The loop holds.';
    summary.textContent = `Worst arm angle across every pose: ${worst.toFixed(1)}°. ${label} This runs the real retargeter on known skeletons and reads the posed arm straight back, so no pose model sits in the middle.`;
    out.append(summary);
    button.disabled = false;
}

function mappedVec(m, x, y, z) {
    return new THREE.Vector3(
        m[0] * x + m[1] * y + m[2] * z,
        m[3] * x + m[4] * y + m[5] * z,
        m[6] * x + m[7] * y + m[8] * z,
    );
}

function markArmLab() {
    const lab = ui.armLab;
    if (!lab) return;
    document.querySelectorAll('#map-poses button').forEach((button) => {
        button.classList.toggle('on', button.dataset.pose === lab.poseId);
    });
    document.querySelectorAll('#map-choices button').forEach((button) => {
        button.classList.toggle('on', button.dataset.map === lab.mapId);
    });
    const pose = ARM_POSES.find((item) => item.id === lab.poseId);
    const map = ARM_MAPS.find((item) => item.id === lab.mapId);
    const help = document.getElementById('map-lab-help');
    if (help && pose && map) {
        help.textContent = `${pose.name} through map ${map.id} (${map.name}). Cyan is the skeleton. Drag to rotate, scroll to zoom. Save when the arm stays on that line from every angle.`;
    }
}

function ensureArmLabButtons() {
    const poses = document.getElementById('map-poses');
    const choices = document.getElementById('map-choices');
    if (!poses || !choices || poses.childElementCount) return;
    for (const pose of ARM_POSES) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.pose = pose.id;
        button.textContent = pose.name;
        poses.append(button);
    }
    for (const map of ARM_MAPS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.map = map.id;
        button.textContent = `${map.id} ${map.name}`;
        choices.append(button);
    }
    poses.addEventListener('click', (event) => {
        const id = event.target?.dataset?.pose;
        if (!id || !ui.armLab?.on) return;
        ui.armLab.poseId = id;
        markArmLab();
    });
    choices.addEventListener('click', (event) => {
        const id = event.target?.dataset?.map;
        if (!id || !ui.armLab?.on) return;
        ui.armLab.mapId = id;
        markArmLab();
    });
}

function startArmLab(renderer, scene, camera, controls, ghost) {
    // this [2026-09-28] | INFO | startArmLab | Hold a known left-arm skeleton in view so the mapping can be rotated and saved
    const vrm = ui.vrm;
    const retargeter = ui.retargeter;
    const panel = document.getElementById('map-lab');
    if (!vrm?.humanoid || !retargeter || !panel) return;
    if (ui.armLab?.on) return;
    const humanoid = vrm.humanoid;
    const upper = humanoid.getNormalizedBoneNode('leftUpperArm');
    const lower = humanoid.getNormalizedBoneNode('leftLowerArm');
    const hand = humanoid.getNormalizedBoneNode('leftHand');
    if (!upper || !lower || !hand) return;
    ensureArmLabButtons();
    const worldPos = (node) => node.getWorldPosition(new THREE.Vector3());
    const restoreRest = () => {
        for (const [name, quat] of Object.entries(retargeter.restQuats)) {
            const node = humanoid.getNormalizedBoneNode(name);
            if (node && quat) node.quaternion.copy(quat);
        }
        humanoid.update?.();
        vrm.scene.updateMatrixWorld(true);
    };
    restoreRest();
    const overlay = new THREE.Group();
    const boneMat = new THREE.MeshBasicMaterial({ color: 0x4fd2ff, depthTest: false, depthWrite: false, transparent: true });
    const jointMat = new THREE.MeshBasicMaterial({ color: 0xffe27a, depthTest: false, depthWrite: false, transparent: true });
    const up = new THREE.Vector3(0, 1, 0);
    const boneGeo = new THREE.CylinderGeometry(0.02, 0.02, 1, 8);
    const jointGeo = new THREE.SphereGeometry(0.038, 12, 8);
    const bones = [0, 1].map(() => {
        const mesh = new THREE.Mesh(boneGeo, boneMat);
        mesh.frustumCulled = false;
        overlay.add(mesh);
        return mesh;
    });
    const joints = [0, 1, 2].map(() => {
        const mesh = new THREE.Mesh(jointGeo, jointMat);
        mesh.frustumCulled = false;
        overlay.add(mesh);
        return mesh;
    });
    const overlayScene = new THREE.Scene();
    overlayScene.add(overlay);
    if (ghost) ghost.visible = false;
    ui.armLab = {
        on: true,
        poseId: 'down',
        mapId: 'A',
        renderer,
        scene,
        camera,
        controls,
        ghost,
        humanoid,
        upper,
        lower,
        retargeter,
        worldPos,
        restoreRest,
        overlay,
        overlayScene,
        bones,
        joints,
        boneMat,
        jointMat,
        boneGeo,
        jointGeo,
        up,
        origin: worldPos(upper).clone(),
        L1: worldPos(upper).distanceTo(worldPos(lower)) || 0.25,
        L2: worldPos(lower).distanceTo(worldPos(hand)) || 0.22,
        camPos: camera.position.clone(),
        camTarget: controls.target.clone(),
        prevDamping: controls.enableDamping,
    };
    controls.enableDamping = true;
    camera.position.set(0.72, 1.42, 1.35);
    controls.target.set(0.22, 1.28, 0);
    camera.lookAt(controls.target);
    document.body.classList.add('arm-lab');
    panel.hidden = false;
    const state = document.getElementById('map-save-state');
    if (state) state.textContent = '';
    markArmLab();
    requestAnimationFrame(() => {
        ui.resize?.();
        requestAnimationFrame(() => ui.resize?.());
    });
}

function stopArmLab() {
    const lab = ui.armLab;
    const panel = document.getElementById('map-lab');
    if (panel) panel.hidden = true;
    document.body.classList.remove('arm-lab');
    if (!lab?.on) {
        ui.resize?.();
        return;
    }
    lab.on = false;
    lab.restoreRest();
    lab.overlayScene.remove(lab.overlay);
    lab.boneMat.dispose();
    lab.jointMat.dispose();
    lab.boneGeo.dispose();
    lab.jointGeo.dispose();
    lab.camera.position.copy(lab.camPos);
    lab.controls.target.copy(lab.camTarget);
    lab.controls.enableDamping = lab.prevDamping;
    lab.camera.updateProjectionMatrix();
    ui.resize?.();
}

function renderArmLab() {
    const lab = ui.armLab;
    if (!lab?.on) return;
    const pose = ARM_POSES.find((item) => item.id === lab.poseId) || ARM_POSES[0];
    const map = ARM_MAPS.find((item) => item.id === lab.mapId) || ARM_MAPS[0];
    let skelElbow;
    let skelWrist;
    if (pose.id === 'bent') {
        skelElbow = new THREE.Vector3(lab.L1, 0, 0);
        skelWrist = new THREE.Vector3(lab.L1, -lab.L2, 0);
    } else {
        skelElbow = new THREE.Vector3(pose.dir[0] * lab.L1, pose.dir[1] * lab.L1, pose.dir[2] * lab.L1);
        skelWrist = new THREE.Vector3(pose.dir[0] * (lab.L1 + lab.L2), pose.dir[1] * (lab.L1 + lab.L2), pose.dir[2] * (lab.L1 + lab.L2));
    }
    const elbow = mappedVec(map.m, skelElbow.x, skelElbow.y, skelElbow.z);
    const wrist = mappedVec(map.m, skelWrist.x, skelWrist.y, skelWrist.z);
    lab.restoreRest();
    const root = lab.worldPos(lab.upper);
    lab.origin.copy(root);
    const upperQuat = lab.retargeter.body.aimBone('leftUpperArm', 'leftLowerArm', root.clone().add(elbow));
    if (upperQuat) lab.upper.quaternion.copy(upperQuat);
    lab.upper.updateWorldMatrix(true, true);
    const lowerQuat = lab.retargeter.body.aimBone('leftLowerArm', 'leftHand', root.clone().add(wrist));
    if (lowerQuat) lab.lower.quaternion.copy(lowerQuat);
    lab.humanoid.update?.();
    const shoulder = lab.origin;
    const elbowPoint = shoulder.clone().add(skelElbow);
    const wristPoint = shoulder.clone().add(skelWrist);
    lab.joints[0].position.copy(shoulder);
    lab.joints[1].position.copy(elbowPoint);
    lab.joints[2].position.copy(wristPoint);
    [[shoulder, elbowPoint, lab.bones[0]], [elbowPoint, wristPoint, lab.bones[1]]].forEach(([a, b, mesh]) => {
        const delta = new THREE.Vector3().subVectors(b, a);
        const len = Math.max(delta.length(), 1e-4);
        mesh.position.copy(a).addScaledVector(delta, 0.5 / len);
        mesh.quaternion.setFromUnitVectors(lab.up, delta.clone().multiplyScalar(1 / len));
        mesh.scale.set(1, len, 1);
    });
    lab.renderer.autoClear = true;
    lab.renderer.render(lab.scene, lab.camera);
    lab.renderer.autoClear = false;
    lab.renderer.clearDepth();
    lab.renderer.render(lab.overlayScene, lab.camera);
    lab.renderer.autoClear = true;
}

async function saveArmChoice() {
    // this [2026-09-28] | INFO | saveArmChoice | Persist the left-arm map the user picked while orbiting
    const lab = ui.armLab;
    const map = ARM_MAPS.find((item) => item.id === lab?.mapId) || ARM_MAPS[0];
    const note = document.getElementById('map-note')?.value?.trim() || '';
    const state = document.getElementById('map-save-state');
    const loaded = await fetch('/api/calibration');
    if (!loaded.ok) throw new Error('Could not read the current calibration');
    const current = await loaded.json();
    const armMap = current.armMap && typeof current.armMap === 'object' ? current.armMap : {};
    const arms = armMap.arms && typeof armMap.arms === 'object' ? armMap.arms : {};
    arms.left = {
        m: map.m,
        id: map.id,
        name: map.name,
        note,
        refWrist: (lab?.L1 || 0.25) + (lab?.L2 || 0.22),
        refElbow: lab?.L1 || 0.25,
        source: 'viewer',
    };
    armMap.arms = arms;
    armMap.chosen = Object.assign({}, armMap.chosen, { left: map.id });
    const saved = await fetch('/api/calibration', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            rest: current.rest && typeof current.rest === 'object' ? current.rest : {},
            bodyScale: current.bodyScale || 1,
            neutral: Boolean(current.neutral),
            poses: current.poses,
            armMap,
        }),
    });
    const data = await saved.json().catch(() => ({}));
    if (!saved.ok) {
        if (state) state.textContent = data.error || 'Save failed';
        return;
    }
    if (ui.profile) {
        ui.profile.armChoice = { side: 'left', id: map.id, name: map.name, note, m: map.m };
        await saveProfile();
    }
    ui.retargeter?.setCalibration(data.armMap ? data : { armMap });
    if (state) state.textContent = note ? `Saved ${map.id} · ${map.name}. ${note}` : `Saved ${map.id} · ${map.name} for the left arm.`;
}

async function main() {
    const config = await fetch('/api/config').then((r) => r.json());
    ui.vrmName = config.vrmName || 'model';
    setStatus(`Loading ${ui.vrmName || 'sample'}…`);
    const canvas = document.getElementById('stage');
    // this [2026-10-11] | INFO | init.alpha | Alpha canvas so chroma/transparency backgrounds composite correctly
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x14141c);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 40);
    ui.camera = camera;
    camera.position.set(0, 1.15, 2.4);
    const controls = new OrbitControls(camera, canvas);
    ui.controls = controls;
    // this [2026-10-11] | INFO | init.background | Restore the user's saved stage background (studio / chroma / transparent)
    bgStage = { scene, renderer };
    const savedBg = localStorage.getItem('mocap-bg') || 'studio';
    if (savedBg !== 'studio') applyBackground(savedBg);
    // this [2026-10-06] | INFO | init.theaterFrame | Boot-with-theater loads straight into the pulled-back framing
    if (theater.on) camera.position.set(0, 1.15, 3.1);
    controls.target.set(0, 1, 0);
    scene.add(new THREE.HemisphereLight(0xdde4ff, 0x222028, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(1, 2, 1.4);
    scene.add(key);
    const ghost = createGhost(scene);

    const vrm = await loadVrm(`${config.vrm || '/model.vrm'}?t=${Date.now()}`, scene);
    const saved = await fetch(`/api/profiles/${encodeURIComponent(ui.vrmName)}`).then((r) => r.json()).catch(() => ({}));
    ui.profile = mergeProfile(undefined, saved.v ? saved : null);
    ui.retargeter = new MocapRetargeter(vrm, ui.profile);
    if (config.calibration?.rest) ui.retargeter.setCalibration(config.calibration);
    document.getElementById('seated').checked = Boolean(ui.profile.seated);
    document.getElementById('smooth-body').value = ui.profile.smoothing?.body ?? 0.35;
    document.getElementById('smooth-arms').value = ui.profile.smoothing?.arms ?? 0.55;
    document.getElementById('smooth-legs').value = ui.profile.smoothing?.legs ?? 0.45;
    loadTrimControls();

    const socket = window.io({ transports: ['websocket', 'polling'] });
    socket.on('mocap-frame', (frame) => {
        if (ui.source && frame?.source === 'browser') return;
        ui.lastFrame = frame;
        ui.retargeter.applyFrame(frame, 1 / 60);
        drawOverlay(frame);
        faceBars(frame);
        // this [2026-10-11] | INFO | socket.frameStatus | Human-readable tracking state instead of raw quality floats
        const q = frame?.quality || {};
        const grade = (value) => (value >= 0.6 ? 'strong' : value >= 0.25 ? 'partial' : value > 0 ? 'weak' : 'none');
        const faceOn = Number(q.face || 0) > 0.1;
        setStatus(`Tracking · body ${grade(Number(q.body || 0))}${faceOn ? ' · face on' : ''}`);
    });
    socket.on('mocap-vrm-changed', async (data) => {
        ui.vrmName = data.vrmName;
        const next = await loadVrm(`/model.vrm?t=${Date.now()}`, scene);
        const profile = await fetch(`/api/profiles/${encodeURIComponent(ui.vrmName)}`).then((r) => r.json());
        ui.profile = mergeProfile(undefined, profile.bones ? profile : null);
        ui.retargeter = new MocapRetargeter(next, ui.profile);
        refreshLibrary();
        setStatus(`Loaded ${ui.vrmName}`);
    });
    socket.on('mocap-calibration', (data) => {
        ui.retargeter?.setCalibration(data);
    });
    socket.on('mocap-status', (data) => {
        if (!ui.lastFrame) setStatus(`${data.state || 'idle'} · ${data.device || ''} ${data.fps || ''} fps`);
    });

    async function useBrowser() {
        // this [2026-10-11] | FIX | useBrowser | Never open the in-page camera when embedded in the native app — that was the "duplicated camera view"
        if (embedded) {
            ui.source?.stop();
            ui.source = null;
            setStatus('Waiting for the app camera…');
            return;
        }
        ui.source?.stop();
        const select = document.getElementById('camera');
        ui.source = new BrowserMocapSource({
            video: document.getElementById('video'),
            mirror: document.getElementById('mirror').checked,
            onFrame: (frame) => {
                ui.lastFrame = frame;
                noteCalibFrame(frame);
                ui.retargeter?.applyFrame(frame, 1 / 60);
                if (ui.retargeter?.body?.trace) frame.debug = ui.retargeter.body.trace;
                drawOverlay(frame);
                faceBars(frame);
                socket.emit('mocap-frame', { ...frame, echo: true });
            },
        });
        await ui.source.open(select.value);
        const cameras = await listCameras();
        select.innerHTML = cameras.map((cam) => `<option value="${cam.id}">${cam.label}</option>`).join('');
        setStatus('Browser camera live');
    }

    document.getElementById('source').addEventListener('change', async (event) => {
        if (event.target.value === 'browser') {
            try { await useBrowser(); } catch (error) { setStatus(error.message || String(error)); }
        } else {
            ui.source?.stop();
            ui.source = null;
            setStatus(`Waiting for ${event.target.value} frames`);
        }
    });
    document.getElementById('mirror').addEventListener('change', (event) => {
        if (ui.source) ui.source.mirror = event.target.checked;
    });
    // this [2026-10-11] | FIX | viewer-client.remote | Removed: confusing "stream/remote" toggle. The hub always targets the local viewer; sending to Chatter is a hub setting, not a viewer button
    document.getElementById('vrm-file').addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const body = new FormData();
        body.append('file', file);
        await fetch('/api/vrms', { method: 'POST', body });
        refreshLibrary();
    });
    const POSE_LABEL = {
        down: 'Arms down at your sides',
        out: 'Arms straight out to the sides',
        forward: 'Both arms straight at the camera',
    };
    function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    function showHold(count, label) {
        const overlay = document.getElementById('hold-overlay');
        const banner = document.getElementById('calib-banner');
        if (overlay) overlay.hidden = false;
        if (banner) banner.hidden = false;
        const countNode = document.getElementById('hold-count');
        const labelNode = document.getElementById('hold-label');
        if (countNode) countNode.textContent = count;
        if (labelNode) labelNode.textContent = label;
        const sideCount = document.getElementById('calib-count');
        const phase = document.getElementById('calib-phase');
        if (sideCount) sideCount.textContent = count;
        if (phase) phase.textContent = label;
    }
    function hideHold() {
        const overlay = document.getElementById('hold-overlay');
        const banner = document.getElementById('calib-banner');
        if (overlay) overlay.hidden = true;
        if (banner) banner.hidden = true;
        const bar = document.getElementById('calib-bar');
        if (bar) bar.style.width = '0%';
    }
    function setPoseButtons(disabled) {
        for (const id of ['pose-down', 'pose-out', 'pose-forward', 'pose-clear']) {
            const button = document.getElementById(id);
            if (button) button.disabled = disabled;
        }
    }
    function signed(value) {
        const number = Math.round(value);
        return `${number > 0 ? '+' : ''}${number}`;
    }
    function tone(angle) {
        if (angle == null || Number.isNaN(angle)) return '';
        if (angle < 8) return 'good';
        if (angle > 25) return 'bad';
        return '';
    }
    function renderCompare(rows) {
        const table = document.getElementById('calib-table');
        if (!table) return;
        if (!rows?.length) {
            table.innerHTML = '';
            return;
        }
        const body = rows.map((row) => {
            if (row.missing) return `<tr><td>${row.pose}</td><td>${row.side}</td><td colspan="5">not seen</td></tr>`;
            const after = row.corrected == null ? '—' : `${row.corrected}°`;
            return `<tr><td>${row.pose}</td><td>${row.side}</td><td>${signed(row.across)}</td><td>${signed(row.up)}</td><td>${signed(row.forward)}</td><td class="${tone(row.angle)}">${row.angle}°</td><td class="${tone(row.corrected)}">${after}</td></tr>`;
        }).join('');
        table.innerHTML = `<tr><th>Pose</th><th>Arm</th><th>Across</th><th>Up</th><th>Forward</th><th>Off</th><th>After</th></tr>${body}`;
    }
    function updateLiveCalib(frame) {
        const now = performance.now();
        if (now - (ui.liveAt || 0) < 100) return;
        ui.liveAt = now;
        const table = document.getElementById('calib-live');
        const joints = frame?.body?.joints;
        if (!table || !joints) return;
        const rows = ['left', 'right'].map((side) => {
            const wrist = joints[`${side}Wrist`];
            const shoulder = joints[`${side}Shoulder`];
            if (!wrist || !shoulder) return `<tr><td>${side}</td><td colspan="3">not seen</td></tr>`;
            return `<tr><td>${side}</td><td>${signed((wrist[0] - shoulder[0]) * 100)}</td><td>${signed((wrist[1] - shoulder[1]) * 100)}</td><td>${signed((wrist[2] - shoulder[2]) * 100)}</td></tr>`;
        }).join('');
        table.innerHTML = `<tr><th>Live</th><th>Across</th><th>Up</th><th>Forward</th></tr>${rows}`;
    }
    function noteCalibFrame(frame) {
        if (ui.capturing && frame?.body?.joints) ui.captureBag.push(frame);
        updateLiveCalib(frame);
    }
    function summarizeCapture(frames) {
        const sums = {};
        const wrists = { left: [], right: [] };
        const quality = [];
        for (const frame of frames) {
            const joints = frame.body.joints;
            for (const [name, point] of Object.entries(joints)) {
                if (!Array.isArray(point)) continue;
                const bucket = sums[name] || [0, 0, 0, 0];
                bucket[0] += point[0];
                bucket[1] += point[1];
                bucket[2] += point[2];
                bucket[3] += 1;
                sums[name] = bucket;
            }
            for (const side of ['left', 'right']) {
                const wrist = joints[`${side}Wrist`];
                const shoulder = joints[`${side}Shoulder`];
                if (wrist && shoulder) wrists[side].push([wrist[0] - shoulder[0], wrist[1] - shoulder[1], wrist[2] - shoulder[2]]);
            }
            quality.push(Math.min(Number(frame.quality?.leftArm ?? 1), Number(frame.quality?.rightArm ?? 1)));
        }
        const averaged = {};
        for (const [name, bucket] of Object.entries(sums)) {
            averaged[name] = { x: bucket[0] / bucket[3], y: bucket[1] / bucket[3], z: bucket[2] / bucket[3] };
        }
        let spread = 0;
        for (const points of Object.values(wrists)) {
            if (points.length < 2) continue;
            const mean = [0, 1, 2].map((axis) => points.reduce((sum, point) => sum + point[axis], 0) / points.length);
            const meanSquare = points.reduce((sum, point) => sum + [0, 1, 2].reduce((axisSum, axis) => axisSum + (point[axis] - mean[axis]) ** 2, 0), 0) / points.length;
            spread = Math.max(spread, Math.sqrt(meanSquare) * 100);
        }
        return {
            averaged,
            spread,
            count: frames.length,
            quality: quality.reduce((sum, value) => sum + value, 0) / (quality.length || 1),
        };
    }
    async function capturePose(pose) {
        const state = document.getElementById('calib-state');
        if (pose === 'clear') {
            const data = await fetch('/api/calibration/pose', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pose: 'clear' }),
            }).then((response) => response.json());
            ui.retargeter?.setCalibration(data?.rest ? data : null);
            renderCompare([]);
            state.textContent = 'Arm calibration cleared';
            return;
        }
        if (ui.poseBusy) return;
        ui.poseBusy = true;
        setPoseButtons(true);
        try {
            for (let count = 3; count >= 1; count -= 1) {
                showHold(String(count), POSE_LABEL[pose]);
                await wait(1000);
            }
            ui.captureBag = [];
            ui.capturing = true;
            const started = performance.now();
            while (performance.now() - started < 2000) {
                const done = (performance.now() - started) / 2000;
                showHold('Hold', POSE_LABEL[pose]);
                const bar = document.getElementById('calib-bar');
                if (bar) bar.style.width = `${Math.round(done * 100)}%`;
                await wait(100);
            }
            ui.capturing = false;
            hideHold();
            const summary = summarizeCapture(ui.captureBag || []);
            if (summary.count < 15) {
                state.textContent = `Only ${summary.count} frames in 2 seconds. Keep this window in front and try again.`;
                return;
            }
            if (summary.quality < 0.15) {
                state.textContent = 'One or both arms were not visible. Step into frame and try again.';
                return;
            }
            const response = await fetch('/api/calibration/pose', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pose,
                    joints: summary.averaged,
                    spreadCm: summary.spread,
                    frames: summary.count,
                }),
            });
            const data = await response.json();
            renderCompare(data.compare || data.rows || []);
            if (data.calibration) ui.retargeter?.setCalibration(data.calibration);
            if (!response.ok || data.error) state.textContent = data.error || 'Capture was not saved';
            else if (data.ready) state.textContent = `Saved ${pose}. Spread ${summary.spread.toFixed(1)} cm. The map is on — Off versus After is the check.`;
            else state.textContent = `Saved ${pose}. Spread ${summary.spread.toFixed(1)} cm over ${summary.count} frames.`;
        } finally {
            ui.capturing = false;
            ui.poseBusy = false;
            hideHold();
            setPoseButtons(false);
        }
    }
    document.getElementById('pose-down').addEventListener('click', () => capturePose('down'));
    document.getElementById('pose-out').addEventListener('click', () => capturePose('out'));
    document.getElementById('pose-forward').addEventListener('click', () => capturePose('forward'));
    document.getElementById('pose-clear').addEventListener('click', () => capturePose('clear'));
    fetch('/api/calibration').then((response) => response.json()).then((data) => {
        renderCompare(data.compare || []);
        if (data.armMap) ui.retargeter?.setCalibration(data);
    }).catch(() => {});
    document.getElementById('expr-save').addEventListener('click', () => {
        const from = document.getElementById('expr-name').value.trim();
        const target = document.getElementById('expr-target').value.trim();
        if (!from || !target || !ui.profile) return;
        ui.profile.expressions[from] = { target, gain: 1, clamp: 1, mouth: /mouth|jaw|aa|ee|oh|ou/.test(target) };
        saveProfile();
    });
    document.getElementById('rec-start').addEventListener('click', () => fetch('/api/record/start', { method: 'POST' }));
    document.getElementById('roundtrip-run').addEventListener('click', () => {
        runRoundTrip(renderer, scene, camera, controls, ghost, fit).catch((error) => {
            const out = document.getElementById('roundtrip-out');
            if (out) out.textContent = error.message || String(error);
            const button = document.getElementById('roundtrip-run');
            if (button) button.disabled = false;
        });
    });
    document.getElementById('rec-stop').addEventListener('click', async () => {
        await fetch('/api/record/stop', { method: 'POST' });
        const data = await fetch('/api/recordings').then((r) => r.json());
        const host = document.getElementById('recordings');
        host.innerHTML = '';
        for (const file of data.files || []) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = `Play ${file.name}`;
            button.addEventListener('click', () => fetch('/api/recordings/play', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: file.name }),
            }));
            host.appendChild(button);
        }
    });
    document.getElementById('debug').addEventListener('click', () => { ui.debug = !ui.debug; });
    const fit = createFitOverlay();
    const fitButton = document.getElementById('fit-toggle');
    fitButton?.addEventListener('click', () => {
        fit.on = !fit.on;
        fitButton.textContent = fit.on ? 'Fit overlay on' : 'Fit overlay off';
        if (!fit.on) document.getElementById('fit-hud')?.setAttribute('hidden', '');
    });
    // this [2026-10-06] | INFO | ghost-toggle | Show/hide the yellow skeleton; remembered for reloads
    const ghostButton = document.getElementById('ghost-toggle');
    if (ghostButton) {
        ghost.userData.userOn = localStorage.getItem('ghost-on') !== '0';
        ghostButton.textContent = ghost.userData.userOn ? 'Skeleton on' : 'Skeleton off';
        ghostButton.addEventListener('click', () => {
            ghost.userData.userOn = !ghost.userData.userOn;
            localStorage.setItem('ghost-on', ghost.userData.userOn ? '1' : '0');
            ghost.visible = ghost.userData.userOn;
            ghostButton.textContent = ghost.userData.userOn ? 'Skeleton on' : 'Skeleton off';
        });
    }
    document.getElementById('map-lab-close').addEventListener('click', () => stopArmLab());
    document.getElementById('map-save').addEventListener('click', () => {
        saveArmChoice().catch((error) => {
            const state = document.getElementById('map-save-state');
            if (state) state.textContent = error.message || String(error);
        });
    });
    document.getElementById('show-arm-lab').addEventListener('click', () => {
        startArmLab(renderer, scene, camera, controls, ghost);
    });

    await refreshLibrary();
    if (!embedded && (document.getElementById('source').value) === 'browser') {
        try { await useBrowser(); } catch (error) { setStatus(error.message || String(error)); }
    }

    const clock = new THREE.Clock();
    const resize = () => {
        const width = canvas.clientWidth || 640;
        const height = canvas.clientHeight || 480;
        camera.aspect = width / Math.max(1, height);
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
    };
    window.addEventListener('resize', resize);
    ui.resize = resize;
    resize();
    const animate = () => {
        requestAnimationFrame(animate);
        const delta = clock.getDelta();
        controls.update();
        if (ui.armLab?.on) {
            renderArmLab();
            return;
        }
        ui.vrm?.update?.(delta);
        ui.retargeter?.applyFrame(ui.lastFrame || { t: Date.now(), source: 'hold' }, delta);
        updateGhost(ghost, ui.lastFrame, ui.vrm);
        renderer.render(scene, camera);
        if (fit.on) {
            updateFitOverlay(fit, ui.retargeter, ui.vrm);
            renderer.autoClear = false;
            renderer.clearDepth();
            renderer.render(fit.scene, camera);
            renderer.autoClear = true;
        }
    };
    animate();
}

main().catch((error) => {
    setStatus(error.message || String(error));
    console.error(error);
});
