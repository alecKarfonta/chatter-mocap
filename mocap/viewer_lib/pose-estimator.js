/**
 * MediaPipe Pose Landmarker — estimate a person in a photo or live camera and map joints onto this VRM.
 * this [2026-10-06] | INFO | pose-estimator | All live paths (GPU stream, browser camera, video file) solve through the shared MocapRetargeter.
 */

import * as THREE from 'three';
import { vrmToIntentRotation } from './full-body-animator.js';
import { MocapRetargeter } from './mocap/retargeter.js';
import { BrowserMocapSource, imagePoseJoints, imagePoseMeters } from './mocap/source-browser.js';
import { mirrorName, normalizeFrame } from './mocap/protocol.js';

const TASKS_VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21';
const WASM_URL = `${TASKS_VISION_URL}/wasm`;
const POSE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

export const MP_POSE = {
    nose: 0,
    leftEye: 2,
    rightEye: 5,
    leftEar: 7,
    rightEar: 8,
    leftShoulder: 11,
    rightShoulder: 12,
    leftElbow: 13,
    rightElbow: 14,
    leftWrist: 15,
    rightWrist: 16,
    leftHip: 23,
    rightHip: 24,
    leftIndex: 19,
    rightIndex: 20,
};

const POSE_CONNECTIONS = [
    [11, 12],
    [11, 13],
    [13, 15],
    [12, 14],
    [14, 16],
    [11, 23],
    [12, 24],
    [23, 24],
    [0, 11],
    [0, 12],
    [7, 0],
    [8, 0],
];

let poseLandmarkerPromise = null;
let videoPoseLandmarkerPromise = null;

const SIDE_PAIRS = [
    [1, 4], [2, 5], [3, 6], [7, 8],
    [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22],
    [23, 24], [25, 26], [27, 28], [29, 30], [31, 32],
];

function mid(a, b) {
    if (!a || !b) return null;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

function sub(a, b) {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a, b) {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale3(a, s) {
    return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function dist3(a, b) {
    if (!a || !b) return 99;
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function visibilityOf(landmark) {
    const value = landmark?.visibility;
    return Number.isFinite(value) ? value : 1;
}

// this [2026-09-11] | INFO | mpWorldToVrm | MediaPipe world is +X camera-right, +Y down, +Z away from camera
function mpWorldToVrm(point) {
    return { x: point.x, y: -point.y, z: -point.z };
}

function jointVec(point) {
    return new THREE.Vector3(Number(point?.x) || 0, Number(point?.y) || 0, Number(point?.z) || 0);
}

// this [2026-09-15] | INFO | basisAlignmentRotation | Match Vision rest skeleton basis to VRM rest — no axis guessing
function basisAlignmentRotation(visionRest, standingMarks) {
    if (!visionRest || !standingMarks) return null;
    const vHip = visionRest.hips || { x: 0, y: 0, z: 0 };
    const rHip = standingMarks.hips || { x: 0, y: 0, z: 0 };
    const vHead = visionRest.head || visionRest.nose;
    if (!visionRest.leftShoulder || !visionRest.rightShoulder || !vHead) return null;
    if (!standingMarks.ls || !standingMarks.rs || !standingMarks.head) return null;

    const vLeft = jointVec(sub(visionRest.leftShoulder, visionRest.rightShoulder)).normalize();
    let vUp = jointVec(sub(vHead, vHip)).normalize();
    let vFwd = new THREE.Vector3().crossVectors(vLeft, vUp);
    if (vFwd.lengthSq() < 1e-6) return null;
    vFwd.normalize();
    vUp = new THREE.Vector3().crossVectors(vFwd, vLeft).normalize();

    const rLeft = jointVec(sub(standingMarks.ls, standingMarks.rs)).normalize();
    let rUp = jointVec(sub(standingMarks.head, rHip)).normalize();
    let rFwd = new THREE.Vector3().crossVectors(rLeft, rUp);
    if (rFwd.lengthSq() < 1e-6) return null;
    rFwd.normalize();
    rUp = new THREE.Vector3().crossVectors(rFwd, rLeft).normalize();

    const visionBasis = new THREE.Matrix3().set(
        vLeft.x, vUp.x, vFwd.x,
        vLeft.y, vUp.y, vFwd.y,
        vLeft.z, vUp.z, vFwd.z,
    );
    const vrmBasis = new THREE.Matrix3().set(
        rLeft.x, rUp.x, rFwd.x,
        rLeft.y, rUp.y, rFwd.y,
        rLeft.z, rUp.z, rFwd.z,
    );
    return vrmBasis.multiply(visionBasis.clone().transpose());
}

// this [2026-09-15] | INFO | computeVisionVrmAlign | Hip-centered Procrustes: Vision rest pose → VRM bind pose
export function computeVisionVrmAlign(visionRest, standingMarks) {
    const rotation = basisAlignmentRotation(visionRest, standingMarks);
    if (!rotation) return null;
    const visionSpan = dist3(visionRest.leftShoulder, visionRest.rightShoulder);
    const vrmSpan = dist3(standingMarks.ls, standingMarks.rs) || 0.28;
    const scale = clamp(vrmSpan / Math.max(0.04, visionSpan), 0.55, 2.6);
    return {
        rotation,
        scale,
        visionHip: visionRest.hips || { x: 0, y: 0, z: 0 },
    };
}

export async function loadPoseLandmarker() {
    if (poseLandmarkerPromise) return poseLandmarkerPromise;
    poseLandmarkerPromise = createPoseLandmarker('IMAGE');
    try {
        return await poseLandmarkerPromise;
    } catch (error) {
        poseLandmarkerPromise = null;
        throw error;
    }
}

async function createPoseLandmarker(runningMode) {
    const vision = await import(`${TASKS_VISION_URL}/+esm`);
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
    const options = {
        runningMode,
        numPoses: 1,
        minPoseDetectionConfidence: 0.4,
        minPosePresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
    };
    try {
        return await vision.PoseLandmarker.createFromOptions(fileset, {
            ...options,
            baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'GPU' },
        });
    } catch (error) {
        console.warn('[PoseEstimator] GPU landmarker failed, using CPU', error);
        return await vision.PoseLandmarker.createFromOptions(fileset, {
            ...options,
            baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'CPU' },
        });
    }
}

// this [2026-09-11] | INFO | loadVideoPoseLandmarker | Dedicated VIDEO instance so still IMAGE estimates keep working
export async function loadVideoPoseLandmarker() {
    if (videoPoseLandmarkerPromise) return videoPoseLandmarkerPromise;
    videoPoseLandmarkerPromise = createPoseLandmarker('VIDEO');
    try {
        return await videoPoseLandmarkerPromise;
    } catch (error) {
        videoPoseLandmarkerPromise = null;
        throw error;
    }
}

export async function loadImageElement(src) {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`Could not load pose image: ${src}`));
        image.src = src;
    });
    return image;
}

export async function estimatePoseFromImage(image) {
    const landmarker = await loadPoseLandmarker();
    const result = landmarker.detect(image);
    const imageLandmarks = result?.landmarks?.[0] || [];
    const worldLandmarks = result?.worldLandmarks?.[0] || [];
    if (worldLandmarks.length < 25 && imageLandmarks.length < 25) {
        throw new Error('Pose model did not find a person in that photo');
    }
    return {
        imageLandmarks,
        worldLandmarks: worldLandmarks.length ? worldLandmarks : imageLandmarks,
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
    };
}

function cloneLandmarkList(list) {
    return (list || []).map((point) => (point ? { ...point } : point));
}

function swapLandmarkSides(list) {
    const out = cloneLandmarkList(list);
    for (const [left, right] of SIDE_PAIRS) {
        const hold = out[left];
        out[left] = out[right];
        out[right] = hold;
    }
    return out;
}

function negateLandmarkX(list) {
    return (list || []).map((point) => (point ? { ...point, x: -point.x } : point));
}

// this [2026-09-11] | INFO | mirrorPoseLandmarks | Selfie-mirror: swap sides and flip X so the avatar faces you
export function mirrorPoseLandmarks(estimate) {
    if (!estimate) return estimate;
    return {
        ...estimate,
        imageLandmarks: swapLandmarkSides(estimate.imageLandmarks),
        worldLandmarks: negateLandmarkX(swapLandmarkSides(estimate.worldLandmarks)),
    };
}

// this [2026-09-11] | INFO | estimatePoseFromVideo | VIDEO-mode detect; empty frame is allowed for the live loop
export async function estimatePoseFromVideo(video, timestampMs) {
    const landmarker = await loadVideoPoseLandmarker();
    const result = landmarker.detectForVideo(video, timestampMs);
    const imageLandmarks = result?.landmarks?.[0] || [];
    const worldLandmarks = result?.worldLandmarks?.[0] || [];
    return {
        imageLandmarks,
        worldLandmarks: worldLandmarks.length ? worldLandmarks : imageLandmarks,
        width: video.videoWidth || video.width || 640,
        height: video.videoHeight || video.height || 480,
        empty: worldLandmarks.length < 25 && imageLandmarks.length < 25,
    };
}

export function vrmTargetsFromEstimate(estimate, standingMarks, options = {}) {
    const world = estimate.worldLandmarks || [];
    const image = estimate.imageLandmarks || [];
    const hips = standingMarks?.hips || { x: 0, y: 0.12, z: -0.11 };
    const head = standingMarks?.head || { x: 0, y: 0.45, z: -0.13 };
    const leftShoulder = standingMarks?.lu || { x: 0.12, y: 0.32, z: -0.08 };
    const rightShoulder = standingMarks?.ru || { x: -0.12, y: 0.32, z: -0.08 };

    const mpHips = mid(world[MP_POSE.leftHip], world[MP_POSE.rightHip]) || { x: 0, y: 0, z: 0 };
    const mpLeftShoulder = world[MP_POSE.leftShoulder];
    const mpRightShoulder = world[MP_POSE.rightShoulder];
    if (!mpLeftShoulder || !mpRightShoulder) {
        if (options.allowEmpty) return { sides: [], visibility: { left: 0, right: 0 }, scale: 1 };
        throw new Error('Pose model did not see both shoulders');
    }

    const mpShoulderMid = mid(mpLeftShoulder, mpRightShoulder);
    const mpSpan = dist3(mpWorldToVrm(mpLeftShoulder), mpWorldToVrm(mpRightShoulder));
    const mpHeight = mpShoulderMid ? Math.abs(mpWorldToVrm(sub(mpShoulderMid, mpHips)).y) : 0;
    const vrmSpan = dist3(leftShoulder, rightShoulder);
    // this [2026-09-11] | INFO | vrmTargetsFromEstimate | Scale against hip→head; chest-only height crushed raised arms
    const vrmHeight = Math.abs((head.y || 0.45) - hips.y) || 0.32;
    const widthScale = vrmSpan / Math.max(0.04, mpSpan);
    const heightScale = vrmHeight / Math.max(0.12, mpHeight || vrmHeight);
    const scale = clamp((widthScale * 0.25) + (heightScale * 0.75), 0.7, 2.2);

    function joint(index) {
        const source = world[index];
        if (!source) return null;
        return add(hips, scale3(mpWorldToVrm(sub(source, mpHips)), scale));
    }

    const targets = {
        rh: joint(MP_POSE.rightWrist),
        re: joint(MP_POSE.rightElbow),
        rs: joint(MP_POSE.rightShoulder),
        lh: joint(MP_POSE.leftWrist),
        le: joint(MP_POSE.leftElbow),
        ls: joint(MP_POSE.leftShoulder),
        ri: joint(MP_POSE.rightIndex),
        li: joint(MP_POSE.leftIndex),
        leftEar: joint(MP_POSE.leftEar),
        rightEar: joint(MP_POSE.rightEar),
        leftEye: joint(MP_POSE.leftEye),
        rightEye: joint(MP_POSE.rightEye),
        head: joint(MP_POSE.nose) || head,
        scale,
        sides: [],
        visibility: {
            right: Math.min(visibilityOf(image[MP_POSE.rightWrist] || world[MP_POSE.rightWrist]), visibilityOf(image[MP_POSE.rightElbow] || world[MP_POSE.rightElbow])),
            left: Math.min(visibilityOf(image[MP_POSE.leftWrist] || world[MP_POSE.leftWrist]), visibilityOf(image[MP_POSE.leftElbow] || world[MP_POSE.leftElbow])),
        },
    };

    if (targets.rh && targets.re && targets.visibility.right >= 0.35) targets.sides.push('right');
    if (targets.lh && targets.le && targets.visibility.left >= 0.35) targets.sides.push('left');
    if (!targets.sides.length && !options.allowEmpty) {
        throw new Error('Pose model saw a person, but not enough of the arms');
    }

    const shoulderMid = mid(targets.ls || leftShoulder, targets.rs || rightShoulder) || { x: 0, y: 0.32, z: -0.08 };
    targets.headIntent = buildHeadIntent(targets, shoulderMid);
    return targets;
}

// this [2026-09-11] | INFO | buildHeadIntent | Keep the good pitch; yaw uses ears so left/right reads
function buildHeadIntent(targets, shoulderMid, options = {}) {
    const nose = targets.head;
    if (!nose || !shoulderMid) return null;
    const look = sub(nose, shoulderMid);
    // this [2026-09-15] | INFO | buildHeadIntent | Pitch is relative to a facing-camera rest so a high webcam does not look up
    const restLookY = Number(options.restLookY ?? 0.30);
    const extraDown = Number(options.pitchBias ?? 0.10);
    const pitch = clamp((look.y - restLookY) * -1.05 + extraDown, -0.32, 0.36);

    const leftEar = targets.leftEar;
    const rightEar = targets.rightEar;
    const leftEye = targets.leftEye;
    const rightEye = targets.rightEye;
    let yaw = 0;
    let yawWeight = 0;

    if (leftEar && rightEar) {
        const earWidth = Math.max(0.03, dist3(leftEar, rightEar));
        const depthYaw = clamp(((leftEar.z - rightEar.z) / earWidth) * 0.95, -1.15, 1.15);
        const earMid = mid(leftEar, rightEar);
        const noseYaw = clamp(((nose.x - earMid.x) / earWidth) * 2.1, -1.15, 1.15);
        yaw += depthYaw * 0.6 + noseYaw * 0.4;
        yawWeight += 1;
    }
    if (leftEye && rightEye) {
        const eyeWidth = Math.max(0.02, dist3(leftEye, rightEye));
        const eyeDepthYaw = clamp(((leftEye.z - rightEye.z) / eyeWidth) * 0.7, -1.05, 1.05);
        yaw += eyeDepthYaw * 0.35;
        yawWeight += 0.35;
    }
    const shoulderYaw = clamp(look.x / Math.max(0.05, Math.abs(look.z) + 0.025) * 0.62, -1.05, 1.05);
    yaw += shoulderYaw * 0.2;
    yawWeight += 0.2;

    yaw = clamp((yaw / Math.max(0.4, yawWeight)) * 1.2, -1.12, 1.12);

    let roll = 0;
    if (leftEar && rightEar) {
        roll = clamp((rightEar.y - leftEar.y) * 3.4, -0.42, 0.42);
    }

    return { x: pitch, y: yaw, z: roll };
}

export function drawPoseOverlay(canvas, estimate, options = {}) {
    if (!canvas || !estimate?.imageLandmarks?.length) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    if (options.background !== false) {
        ctx.fillStyle = options.background || '#111827';
        ctx.fillRect(0, 0, width, height);
    }
    const points = estimate.imageLandmarks;
    ctx.strokeStyle = '#64b5f6';
    ctx.lineWidth = 2;
    for (const [a, b] of POSE_CONNECTIONS) {
        if (!points[a] || !points[b]) continue;
        ctx.beginPath();
        ctx.moveTo(points[a].x * width, points[a].y * height);
        ctx.lineTo(points[b].x * width, points[b].y * height);
        ctx.stroke();
    }
    for (const index of Object.values(MP_POSE)) {
        const point = points[index];
        if (!point) continue;
        ctx.fillStyle = index === MP_POSE.nose ? '#ffca28' : '#90caf9';
        ctx.beginPath();
        ctx.arc(point.x * width, point.y * height, 3, 0, Math.PI * 2);
        ctx.fill();
    }
}

export async function estimatePoseFromUrl(url) {
    const image = await loadImageElement(url);
    const estimate = await estimatePoseFromImage(image);
    estimate.source = url;
    return estimate;
}

export async function estimatePoseFromFile(file) {
    const url = URL.createObjectURL(file);
    try {
        return await estimatePoseFromUrl(url);
    } finally {
        URL.revokeObjectURL(url);
    }
}

const MAX_CLIP_FRAMES = 18;

function isVideoFile(file) {
    return Boolean(file?.type?.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(file?.name || ''));
}

function isAnimatedImageFile(file) {
    return Boolean(/image\/(gif|webp|apng|avif)/.test(file?.type || '') || /\.(gif|webp|apng)$/i.test(file?.name || ''));
}

async function loadImageFromFile(file) {
    const url = URL.createObjectURL(file);
    try {
        return await loadImageElement(url);
    } finally {
        URL.revokeObjectURL(url);
    }
}

function seekVideo(video, time) {
    return new Promise((resolve, reject) => {
        const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked);
            resolve();
        };
        video.addEventListener('seeked', onSeeked);
        video.onerror = () => reject(new Error('Could not seek that video'));
        video.currentTime = time;
    });
}

// this [2026-09-11] | INFO | extractDecodedImageFrames | GIF / animated WebP frames via ImageDecoder
export async function extractDecodedImageFrames(file, options = {}) {
    if (typeof ImageDecoder === 'undefined') return [];
    const type = file.type || (/\.gif$/i.test(file.name) ? 'image/gif' : 'image/webp');
    const decoder = new ImageDecoder({ data: await file.arrayBuffer(), type });
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    const count = Number(track?.frameCount) || 0;
    if (count <= 1) {
        decoder.close?.();
        return [];
    }
    const maxFrames = options.maxFrames || MAX_CLIP_FRAMES;
    const stride = Math.max(1, Math.ceil(count / maxFrames));
    const frames = [];
    let timeMs = 0;
    for (let index = 0; index < count && frames.length < maxFrames; index += 1) {
        const result = await decoder.decode({ frameIndex: index });
        const durationMs = Math.max(20, Number(result.image.duration || 0) / 1000);
        if (index % stride === 0) {
            frames.push({
                image: await createImageBitmap(result.image),
                timeMs: Math.round(timeMs),
                source: file.name,
            });
        }
        result.image.close?.();
        timeMs += durationMs;
    }
    decoder.close?.();
    return frames;
}

// this [2026-09-11] | INFO | extractVideoFrames | Sample a short clip into stills the pose model can read
export async function extractVideoFrames(file, options = {}) {
    const maxFrames = options.maxFrames || MAX_CLIP_FRAMES;
    const fps = options.fps || 8;
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.src = url;
    try {
        await new Promise((resolve, reject) => {
            video.onloadeddata = () => resolve();
            video.onerror = () => reject(new Error('Could not read that video'));
        });
        const duration = Math.max(0.1, Number(video.duration) || 1);
        const step = Math.max(1 / fps, duration / maxFrames);
        const frames = [];
        for (let time = 0; time < duration - 0.02 && frames.length < maxFrames; time += step) {
            await seekVideo(video, Math.min(time, duration - 0.05));
            frames.push({
                image: await createImageBitmap(video),
                timeMs: Math.round(time * 1000),
                source: file.name,
            });
        }
        return frames;
    } finally {
        URL.revokeObjectURL(url);
    }
}

// this [2026-09-11] | INFO | extractFramesFromFiles | One still, many photos, a GIF, or a short video
export async function extractFramesFromFiles(files, options = {}) {
    const list = [...(files || [])].filter(Boolean);
    if (!list.length) throw new Error('Choose a photo, GIF, or short video first');
    if (list.length === 1 && isVideoFile(list[0])) {
        const frames = await extractVideoFrames(list[0], options);
        if (!frames.length) throw new Error('That video had no readable frames');
        return frames;
    }
    if (list.length === 1 && isAnimatedImageFile(list[0])) {
        const frames = await extractDecodedImageFrames(list[0], options);
        if (frames.length > 1) return frames;
    }
    if (list.length === 1) {
        return [{ image: await loadImageFromFile(list[0]), timeMs: 0, source: list[0].name }];
    }
    list.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
    const step = Number(options.stillStepMs) || 150;
    const maxFrames = options.maxFrames || MAX_CLIP_FRAMES;
    const frames = [];
    for (let index = 0; index < list.length && frames.length < maxFrames; index += 1) {
        frames.push({
            image: await loadImageFromFile(list[index]),
            timeMs: index * step,
            source: list[index].name,
        });
    }
    return frames;
}

function friendlyCameraError(error) {
    const name = error?.name || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        return 'Camera permission was blocked. Allow the camera for this page, then click Start again.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        return 'No camera found. Plug one in, or pick a video file below.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
        return 'The camera is busy in another app. Close that app and try again.';
    }
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
        return 'This camera rejected the requested mode. Trying a simpler open…';
    }
    if (name === 'SecurityError') {
        return 'The browser blocked the camera on this URL. Use http://127.0.0.1 or https.';
    }
    return error?.message || String(error);
}

function setLivePoseStatus(message) {
    const node = document.getElementById('live-pose-status');
    if (node) node.textContent = message;
}

export function installLivePoseWindowHooks() {
    if (typeof window === 'undefined' || window.__livePoseHooksBound) return;
    window.__livePoseHooksBound = true;
    window.startLiveCamera = async () => {
        const ctrl = window.livePoseController;
        if (!ctrl) {
            window.__livePoseWanted = 'camera';
            setLivePoseStatus('Waiting for the avatar to finish loading…');
            return;
        }
        try {
            await ctrl.startCamera();
        } catch (error) {
            setLivePoseStatus(friendlyCameraError(error));
        }
    };
    window.stopLivePose = () => {
        window.__livePoseWanted = null;
        window.livePoseController?.stop();
        if (!window.livePoseController) setLivePoseStatus('Listening for GPU mocap. Browser camera is a fallback.');
    };
    document.addEventListener('click', (event) => {
        if (event.target.closest('#live-pose-start')) {
            event.preventDefault();
            window.startLiveCamera();
        } else if (event.target.closest('#live-pose-stop')) {
            event.preventDefault();
            window.stopLivePose();
        }
    });
}

// this [2026-10-06] | INFO | estimateToFrame | Video-file pose → MocapFrame v1 via the same image-plane conversion the camera path uses
function estimateToFrame(estimate, mirror) {
    const raw = { landmarks: [estimate.imageLandmarks] };
    const { meters } = imagePoseMeters(raw);
    const joints = imagePoseJoints(raw, meters);
    if (!joints) return null;
    const quality = {
        body: 1,
        face: 0,
        leftHand: 0,
        rightHand: 0,
        leftArm: Math.min(
            visibilityOf(estimate.imageLandmarks[MP_POSE.leftElbow]),
            visibilityOf(estimate.imageLandmarks[MP_POSE.leftWrist]),
        ),
        rightArm: Math.min(
            visibilityOf(estimate.imageLandmarks[MP_POSE.rightElbow]),
            visibilityOf(estimate.imageLandmarks[MP_POSE.rightWrist]),
        ),
    };
    if (mirror) {
        // this [2026-10-06] | INFO | estimateToFrame.mirror | Selfie flip in canonical space, matching BrowserMocapSource
        const swapped = {};
        for (const [name, point] of Object.entries(joints)) {
            swapped[mirrorName(name)] = [-point[0], point[1], point[2], point[3]];
        }
        return normalizeFrame({
            t: Date.now(),
            source: 'file',
            body: { metric: false, joints: swapped },
            quality: {
                ...quality,
                leftArm: quality.rightArm,
                rightArm: quality.leftArm,
            },
        });
    }
    return normalizeFrame({
        t: Date.now(),
        source: 'file',
        body: { metric: false, joints },
        quality,
    });
}

export class LivePoseController {
    constructor(client) {
        this.client = client;
        this.running = false;
        this.mirror = true;
        this.smooth = 0.55;
        this.stream = null;
        this.objectUrl = null;
        this.video = null;
        this.overlay = null;
        this.lastDetectAt = 0;
        this.lastTimestamp = 0;
        this.fps = 0;
        this.detectCount = 0;
        this.fpsAt = 0;
        this.liveRawPose = {};
        this.idleWasEnabled = true;
        this.status = 'Listening for GPU mocap. Browser camera is a fallback.';
        this.uiBound = false;
        this.detectError = '';
        this.sessionLabel = 'GPU mocap';
        this.remoteFrame = null;
        this.remoteUntil = 0;
        this.remoteSession = false;
        this.remoteFps = 0;
        this.remoteCount = 0;
        this.remoteFpsAt = 0;
        this.liveFaceKeys = [];
        this.retargeter = null;
        this.browserSource = null;
    }

    ensureRetargeter() {
        const vrm = this.client?.vrm;
        if (!vrm) return null;
        if (!this.retargeter || this.retargeter.vrm !== vrm) {
            this.retargeter = new MocapRetargeter(vrm);
        }
        return this.retargeter;
    }

    isRunning() {
        return this.running || this.isMocapLive();
    }

    isDriving() {
        return this.running || this.isMocapLive();
    }

    isMocapLive() {
        return Boolean(this.remoteFrame) && Date.now() < this.remoteUntil;
    }

    drivenBones() {
        return Object.keys(this.liveRawPose || {});
    }

    setStatus(message) {
        this.status = message;
        const node = document.getElementById('live-pose-status');
        if (node) node.textContent = message;
    }

    bindUi() {
        if (this.uiBound) return;
        this.video = document.getElementById('live-pose-video');
        this.overlay = document.getElementById('live-pose-overlay');
        const start = document.getElementById('live-pose-start');
        const stop = document.getElementById('live-pose-stop');
        const capture = document.getElementById('live-pose-capture');
        const file = document.getElementById('live-pose-file');
        const mirror = document.getElementById('live-pose-mirror');
        const smooth = document.getElementById('live-pose-smooth');
        if (!start || !stop || !this.video) return;
        capture?.addEventListener('click', () => this.captureToSelectedEmote());
        file?.addEventListener('change', (event) => {
            const picked = event.target.files?.[0];
            if (!picked) return;
            this.startFromFile(picked).catch((error) => this.setStatus(error.message || String(error)));
        });
        mirror?.addEventListener('change', () => {
            this.mirror = Boolean(mirror.checked);
            if (this.browserSource) this.browserSource.mirror = this.mirror;
            this.syncPreviewMirror();
        });
        smooth?.addEventListener('input', () => {
            this.smooth = clamp(Number(smooth.value) / 100, 0, 0.92);
        });
        this.mirror = mirror ? Boolean(mirror.checked) : true;
        this.smooth = smooth ? clamp(Number(smooth.value) / 100, 0, 0.92) : 0.55;
        this.syncPreviewMirror();
        this.uiBound = true;
    }

    syncPreviewMirror() {
        document.getElementById('live-pose-preview')?.classList.toggle('mirror', this.mirror);
    }

    // this [2026-10-06] | INFO | LivePoseController.resetPoseOverrides | Drop held actions and arm locks so mocap owns the rig
    resetPoseOverrides() {
        const client = this.client;
        if (!client) return;
        client.heldActionPose = null;
        client.syncArmLockFromEmote?.();
    }

    async ensureVideoReady() {
        const video = this.video || document.getElementById('live-pose-video');
        this.video = video;
        this.overlay = this.overlay || document.getElementById('live-pose-overlay');
        if (!video) throw new Error('Live pose preview is missing');
        const started = Date.now();
        while (Date.now() - started < 8000) {
            if (video.readyState >= 2 && (video.videoWidth || 0) > 0) return video;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('Camera opened, but no video frames arrived. Try another camera or a video file.');
    }

    beginSession(label) {
        const idle = this.client?.idleEventController;
        this.idleWasEnabled = idle ? idle.enabled !== false : true;
        if (idle) idle.enabled = false;
        this.resetPoseOverrides();
        this.liveRawPose = {};
        this.running = true;
        this.sessionLabel = label || 'GPU mocap';
        this.lastTimestamp = 0;
        this.detectCount = 0;
        this.fpsAt = performance.now();
    }

    setBusy(busy) {
        this.starting = Boolean(busy);
        const start = document.getElementById('live-pose-start');
        if (start) {
            start.disabled = this.starting || this.running;
            start.textContent = this.running ? 'Camera on' : (this.starting ? 'Starting…' : 'Start camera');
        }
    }

    async startCamera() {
        this.bindUi();
        this.video = this.video || document.getElementById('live-pose-video');
        if (!this.video) throw new Error('Live pose preview is missing. Hard-refresh /view and open Emotes.');
        if (!this.client?.vrm) {
            window.__livePoseWanted = 'camera';
            this.setStatus('Waiting for the avatar to finish loading…');
            return;
        }
        if (this.starting) return;
        this.setBusy(true);
        this.setStatus('Asking for the camera…');
        try {
            if (this.stream) {
                this.stream.getTracks().forEach((track) => track.stop());
                this.stream = null;
            }
            this.video.pause?.();
            this.video.srcObject = null;
            this.browserSource?.stop();
            this.browserSource = new BrowserMocapSource({
                video: this.video,
                mirror: this.mirror,
                onFrame: (frame) => this.applyMocapFrame(frame, 'Browser camera'),
            });
            this.setStatus('Loading pose, hand, and face models…');
            await this.browserSource.open();
            this.beginSession('Browser camera');
            this.setStatus('Live pose is running. Stand facing the camera.');
        } catch (error) {
            this.running = false;
            await this.stopTracks();
            this.setBusy(false);
            throw error;
        }
        this.setBusy(false);
    }

    async startFromFile(file) {
        this.bindUi();
        if (!file) throw new Error('Choose a video first');
        this.setStatus(`Loading ${file.name}…`);
        await this.stopTracks();
        this.objectUrl = URL.createObjectURL(file);
        this.video.srcObject = null;
        this.video.src = this.objectUrl;
        this.video.loop = true;
        this.video.muted = true;
        this.video.playsInline = true;
        await this.video.play();
        await this.ensureVideoReady();
        await loadVideoPoseLandmarker();
        this.beginSession(`Live pose · ${file.name}`);
        this.setStatus(`Live pose from ${file.name}`);
    }

    async startFromUrl(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Could not load ${url}`);
        const blob = await response.blob();
        const name = String(url).split('/').pop() || 'pose.mp4';
        return this.startFromFile(new File([blob], name, { type: blob.type || 'video/mp4' }));
    }

    async stopTracks() {
        this.browserSource?.stop();
        this.browserSource = null;
        if (this.stream) {
            this.stream.getTracks().forEach((track) => track.stop());
            this.stream = null;
        }
        if (this.video) {
            this.video.pause?.();
            this.video.srcObject = null;
            if (this.video.getAttribute('src')) this.video.removeAttribute('src');
        }
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = null;
        }
    }

    stop() {
        this.running = false;
        this.liveRawPose = {};
        this.stopTracks();
        if (this.client?.idleEventController) {
            this.client.idleEventController.enabled = this.idleWasEnabled;
        }
        this.resetPoseOverrides();
        if (this.overlay) {
            const ctx = this.overlay.getContext('2d');
            ctx?.clearRect(0, 0, this.overlay.width, this.overlay.height);
        }
        this.setBusy(false);
        this.setStatus(this.isMocapLive()
            ? `${this.sessionLabel} · ${this.remoteFps || '…'} fps`
            : 'Listening for GPU mocap. Browser camera is a fallback.');
    }

    captureToSelectedEmote() {
        const editor = window.emoteEditor;
        if (!editor?.draft) {
            this.setStatus('Select an emote first, then capture this live pose');
            return;
        }
        if (!Object.keys(this.liveRawPose).length) {
            this.setStatus('No live pose yet');
            return;
        }
        const pose = this.toIntentPose();
        editor.sculptPose = pose;
        editor.commitSculptToDraft();
        editor.applySculpt(pose);
        editor.renderSculptSliders();
        this.setStatus(`Captured onto ${editor.draft.name || editor.draft.id}. Save to keep it.`);
    }

    toIntentPose() {
        const pose = {};
        const restMap = this.client?.emoteStandingRest || {};
        for (const [bone, raw] of Object.entries(this.liveRawPose || {})) {
            const rest = restMap[bone] || { x: 0, y: 0, z: 0 };
            pose[bone] = vrmToIntentRotation(bone, {
                x: (raw.x || 0) - (rest.x || 0),
                y: (raw.y || 0) - (rest.y || 0),
                z: (raw.z || 0) - (rest.z || 0),
            });
        }
        return pose;
    }

    // this [2026-09-11] | INFO | LivePoseController.applyMocapFrame | Stash the stream; animate() solves after vrm.update()
    applyMocapFrame(frame, label) {
        if (!frame || typeof frame !== 'object') return;
        if (label) this.sessionLabel = label;
        this.remoteFrame = frame;
        this.remoteUntil = Date.now() + 400;
        this.remoteCount += 1;
        const now = performance.now();
        if (!this.remoteFpsAt) this.remoteFpsAt = now;
        if (now - this.remoteFpsAt >= 1000) {
            this.remoteFps = this.remoteCount;
            this.remoteCount = 0;
            this.remoteFpsAt = now;
        }
        if (this.client?.vrm && !this.remoteSession) this.beginRemoteSession();
        const retargeter = this.ensureRetargeter();
        if (frame.calibration?.rest) retargeter?.setCalibration(frame.calibration);
        const quality = frame.quality || {};
        const parts = [];
        if (quality.body != null) parts.push(`body ${Number(quality.body).toFixed(2)}`);
        if (quality.face != null) parts.push(`face ${Number(quality.face).toFixed(2)}`);
        const sides = [];
        if ((quality.leftArm ?? quality.leftHand ?? quality.body ?? 0) >= 0.35) sides.push('left');
        if ((quality.rightArm ?? quality.rightHand ?? quality.body ?? 0) >= 0.35) sides.push('right');
        this.setStatus(`${this.sessionLabel} · ${this.remoteFps || '…'} fps · ${sides.join(' + ') || 'head'}${parts.length ? ` · ${parts.join(' · ')}` : ''}`);
    }

    beginRemoteSession() {
        if (this.remoteSession) return;
        const idle = this.client?.idleEventController;
        this.idleWasEnabled = idle ? idle.enabled !== false : true;
        if (idle) idle.enabled = false;
        this.resetPoseOverrides();
        this.liveRawPose = {};
        this.remoteSession = true;
    }

    endRemoteSession() {
        if (!this.remoteSession && !this.remoteFrame) return;
        this.remoteSession = false;
        this.remoteFrame = null;
        this.remoteUntil = 0;
        this.liveRawPose = {};
        if (this.client?.gazeController) this.client.gazeController.mocapGaze = null;
        this.client?.clearLiveFaceWeights?.(this.liveFaceKeys);
        this.liveFaceKeys = [];
        if (!this.running && this.client?.idleEventController) {
            this.client.idleEventController.enabled = this.idleWasEnabled;
        }
        if (!this.running) {
            this.resetPoseOverrides();
            this.setStatus('Listening for GPU mocap. Browser camera is a fallback.');
        }
    }

    applyRemoteFrame(frame) {
        // this [2026-09-25] | INFO | LivePoseController.applyRemoteFrame | Shared retargeter owns body, hands, and face
        const retargeter = this.ensureRetargeter();
        if (!retargeter) return;
        retargeter.applyFrame(frame, 1 / 60, {
            speaking: Boolean(this.client?.activeVisemeTrack),
        });
        this.liveRawPose = {};
        for (const [bone, quat] of Object.entries(retargeter.live || {})) {
            const euler = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
            this.liveRawPose[bone] = { x: euler.x, y: euler.y, z: euler.z };
        }
        const gaze = frame.face?.gaze || frame.gaze || null;
        if (this.client?.gazeController) this.client.gazeController.mocapGaze = gaze;
        this.liveFaceKeys = retargeter.faceKeys || [];
    }

    // this [2026-10-06] | INFO | LivePoseController.applyFrame | GPU stream wins; browser camera and video files share the same retargeter
    applyFrame() {
        if (!this.client?.vrm) return;
        if (this.isMocapLive()) {
            if (!this.remoteSession) this.beginRemoteSession();
            // this [2026-09-15] | INFO | LivePoseController.applyFrame | Solve after vrm.update so humanoid does not erase IK
            this.applyRemoteFrame(this.remoteFrame);
            return;
        }
        if (this.remoteSession) this.endRemoteSession();
        if (!this.running || !this.video) return;
        const now = performance.now();
        if (now - this.lastDetectAt >= 1000 / 24) {
            this.lastDetectAt = now;
            this.detectFrame(now).catch((error) => {
                this.detectError = error.message || String(error);
            });
        }
        // this [2026-10-06] | INFO | LivePoseController.applyFrame | Video-file mode fades to rest between detects
        this.ensureRetargeter()?.tick();
    }

    async detectFrame(now) {
        const video = this.video;
        if (!video || video.readyState < 2) return;
        const timestamp = Math.max(now, this.lastTimestamp + 1);
        this.lastTimestamp = timestamp;
        const raw = await estimatePoseFromVideo(video, timestamp);
        if (raw.empty) {
            this.setStatus(`${this.sessionLabel} · no person in frame`);
            return;
        }
        drawPoseOverlay(this.overlay, raw, { background: false });
        const frame = estimateToFrame(raw, this.mirror);
        if (!frame) return;
        this.applyMocapFrame(frame);
        this.detectCount += 1;
        if (now - this.fpsAt >= 1000) {
            this.fps = this.detectCount;
            this.detectCount = 0;
            this.fpsAt = now;
        }
        if (this.detectError) {
            this.setStatus(`${this.detectError}`);
            this.detectError = '';
        }
    }
}

if (typeof window !== 'undefined') {
    installLivePoseWindowHooks();
    window.PoseEstimator = {
        loadPoseLandmarker,
        loadVideoPoseLandmarker,
        estimatePoseFromImage,
        estimatePoseFromUrl,
        estimatePoseFromFile,
        estimatePoseFromVideo,
        extractFramesFromFiles,
        extractDecodedImageFrames,
        extractVideoFrames,
        vrmTargetsFromEstimate,
        computeVisionVrmAlign,
        mirrorPoseLandmarks,
        drawPoseOverlay,
        LivePoseController,
    };
}
