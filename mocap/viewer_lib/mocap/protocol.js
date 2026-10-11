/**
 * MocapFrame v1 helpers.
 * this [2026-09-25] | INFO | protocol | Canonical space: hips origin, +Y up, +X subject-left, +Z toward camera.
 */

export const FRAME_VERSION = 1;
export const SECTION_STALE_MS = 400;
export const HAND_COUNT = 21;

export const BODY_JOINTS = [
    'hips', 'spine', 'chest', 'neck', 'head', 'headTop', 'nose',
    'leftEye', 'rightEye', 'leftEar', 'rightEar',
    'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
    'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle',
];

export const ARKIT_BLENDSHAPES = [
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
];

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

export function jointTuple(value) {
    if (!value) return null;
    let x; let y; let z; let conf = 1;
    if (Array.isArray(value)) {
        x = finite(value[0]);
        y = finite(value[1]);
        z = finite(value[2]);
        if (value.length > 3 && finite(value[3]) != null) conf = finite(value[3]);
    } else {
        x = finite(value.x);
        y = finite(value.y);
        z = finite(value.z);
        const raw = finite(value.conf ?? value.visibility);
        if (raw != null) conf = raw;
    }
    if (x == null || y == null || z == null) return null;
    return [x, y, z, Math.min(1, Math.max(0, conf))];
}

function jointsFrom(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [name, value] of Object.entries(raw)) {
        const point = jointTuple(value);
        if (point) out[name] = point;
    }
    return out;
}

function handFrom(raw) {
    if (!raw || !Array.isArray(raw.landmarks) || raw.landmarks.length !== HAND_COUNT) return null;
    const landmarks = [];
    for (const item of raw.landmarks) {
        const point = jointTuple(item);
        if (!point) return null;
        landmarks.push([point[0], point[1], point[2]]);
    }
    const score = finite(raw.score);
    return { landmarks, score: score == null ? 0 : Math.min(1, Math.max(0, score)) };
}

export function normalizeFrame(raw, source) {
    if (!raw || typeof raw !== 'object') throw new Error('frame must be an object');
    const frame = {
        v: FRAME_VERSION,
        t: finite(raw.t) ?? Date.now(),
        source: String(source || raw.source || 'unknown'),
    };
    const body = raw.body && typeof raw.body === 'object' ? raw.body : null;
    const joints = jointsFrom(body?.joints);
    const legacy = Object.keys(joints).length ? joints : jointsFrom(raw.joints);
    if (Object.keys(legacy).length) {
        frame.body = { metric: body ? body.metric !== false : raw.metric !== false, joints: legacy };
    }
    const handsIn = raw.hands && typeof raw.hands === 'object' ? raw.hands : {};
    const hands = {};
    for (const side of ['left', 'right']) {
        const hand = handFrom(handsIn[side]);
        if (hand) hands[side] = hand;
    }
    if (Object.keys(hands).length) frame.hands = hands;
    const faceIn = raw.face && typeof raw.face === 'object' ? raw.face : {};
    const blend = faceIn.blendshapes || raw.blendshapes;
    const gaze = faceIn.gaze || raw.gaze;
    const face = {};
    if (blend && typeof blend === 'object') {
        const cleaned = {};
        for (const [name, value] of Object.entries(blend)) {
            const number = finite(value);
            if (number != null) cleaned[name] = Math.min(1, Math.max(0, number));
        }
        if (Object.keys(cleaned).length) face.blendshapes = cleaned;
    }
    if (Array.isArray(faceIn.headRotation) && faceIn.headRotation.length === 4) {
        const quat = faceIn.headRotation.map(finite);
        if (quat.every((item) => item != null)) face.headRotation = quat;
    }
    if (gaze && finite(gaze.x) != null && finite(gaze.y) != null) {
        face.gaze = {
            x: Math.min(1, Math.max(-1, finite(gaze.x))),
            y: Math.min(1, Math.max(-1, finite(gaze.y))),
        };
    }
    if (Object.keys(face).length) frame.face = face;
    const quality = {};
    if (raw.quality && typeof raw.quality === 'object') {
        for (const [name, value] of Object.entries(raw.quality)) {
            const number = finite(value);
            if (number != null) quality[name] = number;
        }
    }
    frame.quality = quality;
    if (raw.preview && typeof raw.preview === 'object') frame.preview = raw.preview;
    if (raw.debug && typeof raw.debug === 'object') frame.debug = raw.debug;
    return frame;
}

export function jointPoint(joints, name) {
    const point = joints?.[name];
    if (!point) return null;
    return { x: point[0], y: point[1], z: point[2], conf: point[3] ?? 1 };
}

export function mpWorldToCanonical(point) {
    // this [2026-09-25] | INFO | protocol.mpWorldToCanonical | Camera-right is subject-left
    return { x: point.x, y: -point.y, z: -point.z };
}

export function mirrorName(name) {
    if (name.startsWith('left')) return `right${name.slice(4)}`;
    if (name.startsWith('right')) return `left${name.slice(5)}`;
    return name;
}

export class ChannelMerger {
    constructor(staleMs = SECTION_STALE_MS) {
        this.staleMs = staleMs;
        this.sections = {};
    }

    push(frame) {
        const normalized = normalizeFrame(frame);
        for (const key of ['body', 'hands', 'face']) {
            if (normalized[key]) {
                this.sections[key] = { at: normalized.t, source: normalized.source, value: normalized[key] };
            }
        }
        if (normalized.quality && Object.keys(normalized.quality).length) {
            this.sections.quality = { at: normalized.t, source: normalized.source, value: normalized.quality };
        }
        return this.snapshot(normalized.t);
    }

    snapshot(now = Date.now()) {
        const frame = { v: FRAME_VERSION, t: now, source: 'merged', quality: {}, channels: {} };
        const sources = [];
        for (const key of ['body', 'hands', 'face']) {
            const held = this.sections[key];
            if (!held || now - held.at > this.staleMs) continue;
            frame[key] = held.value;
            frame.channels[key] = held.source;
            sources.push(held.source);
        }
        const quality = this.sections.quality;
        if (quality && now - quality.at <= this.staleMs) frame.quality = { ...quality.value };
        if (sources.length) frame.source = new Set(sources).size === 1 ? sources[0] : 'merged';
        return frame;
    }
}
