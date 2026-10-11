/**
 * Browser camera source: pose, two hands, and face in one frame.
 * this [2026-09-25] | INFO | source-browser | Hands follow the pose wrists. MediaPipe handedness is only a hint.
 */

import { mpWorldToCanonical, normalizeFrame } from './protocol.js';

const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21';
const WASM_URL = `${VISION_URL}/wasm`;
const POSE_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
const HAND_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const FACE_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const POSE_NAMES = {
    0: 'nose', 2: 'leftEye', 5: 'rightEye', 7: 'leftEar', 8: 'rightEar',
    11: 'leftShoulder', 12: 'rightShoulder', 13: 'leftElbow', 14: 'rightElbow',
    15: 'leftWrist', 16: 'rightWrist', 23: 'leftHip', 24: 'rightHip',
    25: 'leftKnee', 26: 'rightKnee', 27: 'leftAnkle', 28: 'rightAnkle',
};

let filesetPromise = null;

async function fileset() {
    if (!filesetPromise) {
        const vision = await import(`${VISION_URL}/+esm`);
        filesetPromise = vision.FilesetResolver.forVisionTasks(WASM_URL).then((set) => ({ vision, set }));
    }
    return filesetPromise;
}

async function createLandmarker(factory, modelUrl, extra, gpu) {
    const { vision, set } = await fileset();
    const base = { modelAssetPath: modelUrl, delegate: gpu ? 'GPU' : 'CPU' };
    try {
        return await factory(vision, set, base, extra);
    } catch (error) {
        if (!gpu) throw error;
        console.warn('[mocap] GPU delegate failed, using CPU', error);
        return factory(vision, set, { modelAssetPath: modelUrl, delegate: 'CPU' }, extra);
    }
}

function lm(point) {
    return mpWorldToCanonical(point);
}

function sub(a, b) {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dist(a, b) {
    if (!a || !b) return 99;
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export class BrowserMocapSource {
    constructor(options = {}) {
        this.mirror = options.mirror !== false;
        this.onFrame = options.onFrame || (() => {});
        this.video = options.video || null;
        this.stream = null;
        this.running = false;
        this.pose = null;
        this.hands = null;
        this.face = null;
        this.lastTs = 0;
        this.handStick = { left: null, right: null };
        this.raf = 0;
    }

    async open(deviceId) {
        // this [2026-09-25] | INFO | BrowserMocapSource.open | Pose, hands, and face share one camera track
        if (this.stream) this.stop();
        const video = this.video || document.createElement('video');
        this.video = video;
        video.muted = true;
        video.playsInline = true;
        const constraints = {
            audio: false,
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
            },
        };
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = this.stream;
        await video.play();
        await this.loadModels();
        this.running = true;
        this.pump();
        return video;
    }

    async loadModels() {
        const { vision, set } = await fileset();
        const poseOptions = {
            runningMode: 'VIDEO',
            numPoses: 1,
            minPoseDetectionConfidence: 0.45,
            minPosePresenceConfidence: 0.45,
            minTrackingConfidence: 0.45,
        };
        this.pose = await createLandmarker(
            (mod, files, base) => mod.PoseLandmarker.createFromOptions(files, {
                ...poseOptions,
                baseOptions: base,
            }),
            POSE_URL,
            poseOptions,
            true,
        );
        this.hands = await createLandmarker(
            (mod, files, base) => mod.HandLandmarker.createFromOptions(files, {
                runningMode: 'VIDEO',
                numHands: 2,
                baseOptions: base,
            }),
            HAND_URL,
            null,
            true,
        );
        this.face = await createLandmarker(
            (mod, files, base) => mod.FaceLandmarker.createFromOptions(files, {
                runningMode: 'VIDEO',
                numFaces: 1,
                outputFaceBlendshapes: true,
                outputFacialTransformationMatrixes: true,
                baseOptions: base,
            }),
            FACE_URL,
            null,
            true,
        );
        this.vision = vision;
        this.fileset = set;
    }

    stop() {
        this.running = false;
        cancelAnimationFrame(this.raf);
        if (this.stream) {
            this.stream.getTracks().forEach((track) => track.stop());
            this.stream = null;
        }
        if (this.video) this.video.srcObject = null;
    }

    pump() {
        if (!this.running) return;
        this.raf = requestAnimationFrame(() => this.pump());
        const video = this.video;
        if (!video || video.readyState < 2) return;
        const ts = Math.max(performance.now(), this.lastTs + 1);
        this.lastTs = ts;
        try {
            const frame = this.detect(ts);
            if (frame) {
                this._misses = 0;
                this.onFrame(frame);
            } else {
                this._misses = (this._misses || 0) + 1;
                if (this._misses === 45) {
                    const status = document.getElementById('status');
                    if (status) status.textContent = 'Camera is on. No body in frame.';
                }
            }
        } catch (error) {
            console.warn('[mocap] browser detect failed', error);
            const status = document.getElementById('status');
            if (status) status.textContent = `detect: ${error && error.message ? error.message : error}`;
        }
    }

    detect(ts) {
        const video = this.video;
        const poseResult = this.pose.detectForVideo(video, ts);
        const world = poseResult?.worldLandmarks?.[0];
        const image = poseResult?.landmarks?.[0];
        if (!world || !image || world.length < 25 || image.length < 25) return null;
        // this [2026-09-28] | FIX | BrowserMocapSource.detect | World landmarks were yawed ~75° off the camera, so the avatar twisted while the overlay stayed true. X and Y now come from the image points.
        const hipImage = mid(image[23], image[24]);
        const meters = this.imageMeters(image, world);
        const joints = {};
        const EDGE_HARD = 0.015;
        const EDGE_SOFT = 0.05;
        const edgePenalty = (point) => {
            // this [2026-10-01] | FIX | BrowserMocapSource.detect | Only distrust a joint truly pinned to the border. MediaPipe still infers near-edge joints well, and the user wants those tracked.
            const margin = Math.min(point.x, 1 - point.x, point.y, 1 - point.y);
            if (margin < EDGE_HARD) return 0.15;
            if (margin < EDGE_SOFT) return 0.55;
            return 1;
        };
        for (const [index, name] of Object.entries(POSE_NAMES)) {
            const point = image[Number(index)];
            if (!point) continue;
            const vis = Math.min(point.visibility ?? 1, edgePenalty(point));
            joints[name] = [
                (point.x - hipImage.x) * meters,
                (hipImage.y - point.y) * meters,
                0,
                vis,
            ];
        }
        if (joints.nose) joints.head = joints.nose.slice();
        const preview = { joints: {} };
        for (const [index, name] of Object.entries(POSE_NAMES)) {
            const point = image?.[Number(index)];
            if (!point) continue;
            preview.joints[name] = [point.x, point.y];
        }
        if (preview.joints.nose) preview.joints.head = preview.joints.nose.slice();
        const armVis = (index) => Math.min(visAt(image, index), edgePenalty(image[index] || {}));
        let quality = {
            body: avgVis(image, [11, 12, 23, 24]),
            leftArm: Math.min(armVis(13), armVis(15)),
            rightArm: Math.min(armVis(14), armVis(16)),
            face: 0,
            leftHand: 0,
            rightHand: 0,
        };
        if (this.mirror) mirrorJoints(joints, quality);
        const hands = this.detectHands(ts, joints);
        quality.leftHand = hands.left?.score || 0;
        quality.rightHand = hands.right?.score || 0;
        const face = this.detectFace(ts);
        if (face) {
            quality.face = 0.9;
            // this [2026-10-11] | INFO | detect.preview | Face-mesh dots ride along in preview.face for the camera overlay
            if (face.previewFace) preview.face = face.previewFace;
            delete face.previewFace;
        }
        return normalizeFrame({
            t: Date.now(),
            source: 'browser',
            body: { metric: true, joints },
            hands,
            face,
            preview,
            quality,
        });
    }

    detectHands(ts, joints) {
        const result = this.hands?.detectForVideo(this.video, ts);
        const worlds = result?.worldLandmarks || [];
        const handed = result?.handednesses || [];
        const leftWrist = pointOf(joints.leftWrist);
        const rightWrist = pointOf(joints.rightWrist);
        const assigned = { left: null, right: null };
        worlds.forEach((landmarks, index) => {
            if (!landmarks || landmarks.length < 21) return;
            const wrist = lm(landmarks[0]);
            const hint = handed[index]?.[0]?.categoryName === 'Right' ? 'right' : 'left';
            const score = handed[index]?.[0]?.score ?? 0.5;
            const toLeft = dist(wrist, leftWrist);
            const toRight = dist(wrist, rightWrist);
            let side = toLeft <= toRight ? 'left' : 'right';
            const stuck = this.handStick[side];
            if (stuck && stuck !== hint && Math.abs(toLeft - toRight) < 0.04) side = stuck;
            if (assigned[side] && assigned[side].score >= score) return;
            const points = landmarks.map((landmark) => {
                const canon = lm(sub(landmark, landmarks[0]));
                const base = pointOf(joints[`${side}Wrist`]) || { x: 0, y: 0, z: 0 };
                const placed = {
                    x: base.x + (this.mirror ? -canon.x : canon.x),
                    y: base.y + canon.y,
                    z: base.z + canon.z,
                };
                return [placed.x, placed.y, placed.z];
            });
            assigned[side] = { landmarks: points, score };
            this.handStick[side] = side;
        });
        const hands = {};
        if (assigned.left) hands.left = assigned.left;
        if (assigned.right) hands.right = assigned.right;
        return hands;
    }

    detectFace(ts) {
        const result = this.face?.detectForVideo(this.video, ts);
        if (!result?.faceBlendshapes?.[0]) return null;
        const blendshapes = {};
        for (const cat of result.faceBlendshapes[0].categories || result.faceBlendshapes[0]) {
            const name = cat.categoryName || cat.category_name;
            const score = cat.score;
            if (name) blendshapes[name] = score;
        }
        if (this.mirror) swapBlendSides(blendshapes);
        let headRotation = null;
        const matrix = result.facialTransformationMatrixes?.[0]?.data;
        if (matrix && matrix.length >= 16) {
            headRotation = quatFromMatrix(matrix, this.mirror);
        }
        const gaze = {
            x: ((blendshapes.eyeLookOutLeft || 0) + (blendshapes.eyeLookInRight || 0)
                - (blendshapes.eyeLookInLeft || 0) - (blendshapes.eyeLookOutRight || 0)) * 0.5,
            y: ((blendshapes.eyeLookUpLeft || 0) + (blendshapes.eyeLookUpRight || 0)
                - (blendshapes.eyeLookDownLeft || 0) - (blendshapes.eyeLookDownRight || 0)) * 0.5,
        };
        // this [2026-10-11] | INFO | detectFace.preview | 2D face-mesh points for the camera overlay (dots over the user's face)
        let previewFace = null;
        const mesh = result?.faceLandmarks?.[0];
        if (mesh && mesh.length) {
            previewFace = mesh.map((p) => (this.mirror ? [1 - p.x, p.y] : [p.x, p.y]));
        }
        return { blendshapes, headRotation, gaze, previewFace };
    }

    imageMeters(image, world) {
        const left = image?.[11];
        const right = image?.[12];
        const imageSpan = left && right ? Math.hypot(left.x - right.x, left.y - right.y) : 0;
        const hips = mid(world?.[23], world?.[24]);
        const spanOf = (index) => {
            const point = world?.[index];
            if (!point) return null;
            return lm(sub(point, hips));
        };
        const a = spanOf(11);
        const b = spanOf(12);
        const worldSpan = a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : 0;
        if (imageSpan < 0.02 || worldSpan < 0.05) return 1.6;
        return Math.min(4, Math.max(0.4, worldSpan / imageSpan));
    }
}

function mid(a, b) {
    if (!a || !b) return { x: 0, y: 0, z: 0 };
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

function visAt(list, index) {
    const value = list?.[index]?.visibility;
    return Number.isFinite(value) ? value : 0;
}

function avgVis(list, indices) {
    const values = indices.map((index) => visAt(list, index));
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pointOf(tuple) {
    if (!tuple) return null;
    return { x: tuple[0], y: tuple[1], z: tuple[2] };
}

function mirrorJoints(joints, quality) {
    const swapped = {};
    for (const [name, point] of Object.entries(joints)) {
        const flipped = [-point[0], point[1], point[2], point[3]];
        const next = name.startsWith('left') ? `right${name.slice(4)}` : name.startsWith('right') ? `left${name.slice(5)}` : name;
        swapped[next] = flipped;
    }
    for (const key of Object.keys(joints)) delete joints[key];
    Object.assign(joints, swapped);
    const leftArm = quality.leftArm;
    quality.leftArm = quality.rightArm;
    quality.rightArm = leftArm;
}

const BLEND_PAIRS = [
    ['eyeBlinkLeft', 'eyeBlinkRight'],
    ['eyeLookDownLeft', 'eyeLookDownRight'],
    ['eyeLookInLeft', 'eyeLookOutRight'],
    ['eyeLookOutLeft', 'eyeLookInRight'],
    ['eyeLookUpLeft', 'eyeLookUpRight'],
    ['jawLeft', 'jawRight'],
    ['mouthSmileLeft', 'mouthSmileRight'],
    ['mouthFrownLeft', 'mouthFrownRight'],
    ['browDownLeft', 'browDownRight'],
    ['browOuterUpLeft', 'browOuterUpRight'],
];

function swapBlendSides(blend) {
    for (const [left, right] of BLEND_PAIRS) {
        const a = blend[left];
        blend[left] = blend[right] ?? 0;
        blend[right] = a ?? 0;
    }
}

function quatFromMatrix(data, mirror) {
    const m = data;
    const trace = m[0] + m[5] + m[10];
    let x; let y; let z; let w;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        w = 0.25 * s;
        x = (m[6] - m[9]) / s;
        y = (m[8] - m[2]) / s;
        z = (m[1] - m[4]) / s;
    } else if (m[0] > m[5] && m[0] > m[10]) {
        const s = Math.sqrt(1 + m[0] - m[5] - m[10]) * 2;
        w = (m[6] - m[9]) / s;
        x = 0.25 * s;
        y = (m[1] + m[4]) / s;
        z = (m[8] + m[2]) / s;
    } else if (m[5] > m[10]) {
        const s = Math.sqrt(1 + m[5] - m[0] - m[10]) * 2;
        w = (m[8] - m[2]) / s;
        x = (m[1] + m[4]) / s;
        y = 0.25 * s;
        z = (m[6] + m[9]) / s;
    } else {
        const s = Math.sqrt(1 + m[10] - m[0] - m[5]) * 2;
        w = (m[1] - m[4]) / s;
        x = (m[8] + m[2]) / s;
        y = (m[6] + m[9]) / s;
        z = 0.25 * s;
    }
    if (mirror) y = -y;
    return [x, y, z, w];
}

export async function listCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'videoinput').map((device) => ({
        id: device.deviceId,
        label: device.label || 'Camera',
    }));
}

export function imagePoseJoints(poseResult, meters = 1.6) {
    // this [2026-10-01] | INFO | imagePoseJoints | Same image-plane conversion the live camera path uses, shared with the round-trip probe
    const image = poseResult?.landmarks?.[0];
    if (!image || image.length < 25) return null;
    const hipImage = mid(image[23], image[24]);
    const joints = {};
    for (const [index, name] of Object.entries(POSE_NAMES)) {
        const point = image[Number(index)];
        if (!point) continue;
        joints[name] = [
            (point.x - hipImage.x) * meters,
            (hipImage.y - point.y) * meters,
            0,
            point.visibility ?? 1,
        ];
    }
    return joints;
}

export function imagePoseMeters(poseResult) {
    // this [2026-10-01] | INFO | imagePoseMeters | Scale from the shoulder span in normalized image units, matching the overlay the user trusts
    const image = poseResult?.landmarks?.[0];
    if (!image) return { meters: 1.6, span: 0 };
    const left = image[11];
    const right = image[12];
    const span = left && right ? Math.hypot(left.x - right.x, left.y - right.y) : 0;
    if (span < 0.03) return { meters: 1.6, span };
    return { meters: Math.min(4, Math.max(0.4, 0.36 / span)), span };
}
