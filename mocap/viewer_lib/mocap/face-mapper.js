/**
 * Face, gaze, and ARKit blendshape routing.
 * this [2026-09-25] | INFO | face-mapper | Perfect sync when the VRM already names ARKit expressions. TTS keeps the mouth.
 */

import * as THREE from 'three';
import { ARKIT_BLENDSHAPES, jointPoint } from './protocol.js';

const MOUTH_KEYS = new Set([
    'jawOpen', 'jawForward', 'jawLeft', 'jawRight', 'mouthClose', 'mouthFunnel', 'mouthPucker',
    'mouthLeft', 'mouthRight', 'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight',
    'mouthDimpleLeft', 'mouthDimpleRight', 'mouthStretchLeft', 'mouthStretchRight',
    'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
    'mouthPressLeft', 'mouthPressRight', 'mouthRollLower', 'mouthRollUpper',
    'mouthShrugLower', 'mouthShrugUpper', 'tongueOut',
    'aa', 'ih', 'ou', 'ee', 'oh',
]);

const PRESET_ROUTES = [
    { from: ['eyeBlinkLeft'], target: 'blinkLeft', gain: 1, mouth: false },
    { from: ['eyeBlinkRight'], target: 'blinkRight', gain: 1, mouth: false },
    { from: ['eyeBlinkLeft', 'eyeBlinkRight'], target: 'blink', gain: 1, mouth: false, avg: true },
    { from: ['mouthSmileLeft', 'mouthSmileRight'], target: 'happy', gain: 0.9, mouth: false, avg: true },
    { from: ['mouthFrownLeft', 'mouthFrownRight'], target: 'sad', gain: 0.75, mouth: false, avg: true },
    { from: ['browDownLeft', 'browDownRight'], target: 'angry', gain: 0.7, mouth: false, avg: true },
    { from: ['eyeWideLeft', 'eyeWideRight', 'browInnerUp'], target: 'surprised', gain: 0.8, mouth: false, max: true },
    { from: ['jawOpen'], target: 'aa', gain: 0.95, mouth: true },
    { from: ['mouthFunnel', 'mouthPucker'], target: 'ou', gain: 0.85, mouth: true, max: true },
    { from: ['mouthLowerDownLeft', 'mouthLowerDownRight'], target: 'ee', gain: 0.6, mouth: true, avg: true },
];

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export function expressionNames(vrm) {
    const manager = vrm?.expressionManager;
    if (!manager) return [];
    if (manager.expressionMap) return Object.keys(manager.expressionMap);
    if (manager.expressions) return Object.keys(manager.expressions);
    return [];
}

export function hasPerfectSync(vrm) {
    const names = new Set(expressionNames(vrm));
    let hits = 0;
    for (const key of ['eyeBlinkLeft', 'jawOpen', 'mouthSmileLeft']) {
        if (names.has(key)) hits += 1;
    }
    return hits >= 2;
}

export class FaceMapper {
    constructor(vrm, profile = {}) {
        this.vrm = vrm;
        this.profile = profile;
        this.perfect = hasPerfectSync(vrm);
        this.written = [];
        this._head = new THREE.Quaternion();
    }

    setProfile(profile) {
        this.profile = profile || {};
        this.perfect = hasPerfectSync(this.vrm);
    }

    bone(name) {
        return this.vrm?.humanoid?.getNormalizedBoneNode?.(name) || null;
    }

    valueOf(blend, names) {
        let best = 0;
        let count = 0;
        let sum = 0;
        for (const name of names) {
            const raw = Number(blend[name]);
            if (!Number.isFinite(raw)) continue;
            best = Math.max(best, raw);
            sum += raw;
            count += 1;
        }
        return { best, avg: count ? sum / count : 0 };
    }

    setWeight(name, weight) {
        const manager = this.vrm?.expressionManager;
        const expr = manager?.getExpression?.(name) || manager?.expressions?.[name];
        if (!expr) return false;
        expr.weight = clamp(weight, 0, 1);
        this.written.push(name);
        return true;
    }

    clear(keys) {
        const list = keys || this.written;
        for (const key of list) this.setWeight(key, 0);
        this.written = [];
    }

    applyBlendshapes(blend, options = {}) {
        const speaking = Boolean(options.speaking);
        const table = this.profile?.expressions || {};
        const used = [];
        if (this.perfect) {
            for (const name of ARKIT_BLENDSHAPES) {
                if (!(name in (blend || {}))) continue;
                const spec = table[name] || {};
                if (speaking && (spec.mouth || MOUTH_KEYS.has(spec.target || name))) continue;
                const gain = Number.isFinite(spec.gain) ? spec.gain : 1;
                const limit = Number.isFinite(spec.clamp) ? spec.clamp : 1;
                const target = spec.target || name;
                if (this.setWeight(target, Math.min(limit, Number(blend[name]) * gain))) used.push(target);
            }
            return used;
        }
        const routes = PRESET_ROUTES.map((route) => {
            const spec = table[route.target] || table[route.from[0]] || {};
            return {
                ...route,
                target: spec.target || route.target,
                gain: Number.isFinite(spec.gain) ? spec.gain : route.gain,
                clamp: Number.isFinite(spec.clamp) ? spec.clamp : 1,
                mouth: spec.mouth != null ? spec.mouth : route.mouth,
            };
        });
        for (const route of routes) {
            if (speaking && route.mouth) continue;
            const stats = this.valueOf(blend || {}, route.from);
            const raw = route.avg ? stats.avg : stats.best;
            if (this.setWeight(route.target, Math.min(route.clamp, raw * route.gain))) used.push(route.target);
        }
        return used;
    }

    headFromFace(face) {
        const quat = face?.headRotation;
        if (!Array.isArray(quat) || quat.length !== 4) return null;
        if (!quat.every((item) => Number.isFinite(item))) return null;
        this._head.set(quat[0], quat[1], quat[2], quat[3]).normalize();
        // this [2026-10-08] | FIX | FaceMapper.headFromFace | MediaPipe facial-transform +X = look UP, VRM head +X = face DOWN. Flip pitch so nodding matches; yaw/roll already agree (verified vs Vision ground truth).
        const euler = new THREE.Euler().setFromQuaternion(this._head, 'YXZ');
        euler.x = -euler.x;
        return new THREE.Quaternion().setFromEuler(euler);
    }

    headFromBody(frame, calibration) {
        const joints = frame?.body?.joints;
        if (!joints) return null;
        const head = jointPoint(joints, 'head') || jointPoint(joints, 'nose');
        if (!head) return null;
        const rest = calibration?.rest || {};
        // this [2026-10-06] | FIX | FaceMapper.headFromBody | Reference the chest, not hips: torso lean must not fake head rotation
        const base = jointPoint(joints, 'chest') || jointPoint(joints, 'neck');
        const restBase = (base && rest[base.name]) || rest.chest;
        const restHead = rest.head || { x: 0, y: 0.55, z: 0.05 };
        if (!base || !restBase) return null;
        // this [2026-10-06] | FIX | FaceMapper.headFromBody | Angle-based: normalize delta by head-chest span so camera distance is irrelevant
        const span = Math.max(0.12, Math.hypot(head.x - base.x, head.y - base.y, head.z - base.z));
        const dx = (head.x - base.x) - (restHead.x - restBase.x);
        const dz = (head.z - base.z) - (restHead.z - restBase.z);
        // this [2026-10-06] | FIX | FaceMapper.headFromBody | Look up = skull away from camera = dz<0 must pitch UP (neg X); sign was inverted
        const yaw = clamp(Math.asin(clamp(dx / span, -1, 1)) * 0.7, -0.7, 0.7);
        const pitch = clamp(Math.asin(clamp(dz / span, -1, 1)) * 0.6, -0.35, 0.35);
        let roll = 0;
        const left = jointPoint(joints, 'leftEar');
        const right = jointPoint(joints, 'rightEar');
        if (left && right) roll = clamp((right.y - left.y) * 1.2, -0.3, 0.3);
        return new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
    }

    applyHead(frame, calibration, out) {
        const face = frame?.face;
        const quat = this.headFromFace(face) || this.headFromBody(frame, calibration);
        if (!quat) return;
        if (this.bone('head') && this.profile?.bones?.head?.enabled !== false) out.head = quat.clone();
        if (this.bone('neck') && this.profile?.bones?.neck?.enabled !== false) {
            // this [2026-10-06] | FIX | FaceMapper.applyHead | Neck gets a gentle 25% follow, head carries the motion
            out.neck = quat.clone().slerp(new THREE.Quaternion(), 0.75);
        }
    }

    applyGaze(frame) {
        const gaze = frame?.face?.gaze;
        const settings = this.profile?.gaze || {};
        if (!gaze || settings.enabled === false) return;
        const yawRange = Number(settings.yaw) > 0 ? Number(settings.yaw) : 0.6;
        const pitchRange = Number(settings.pitch) > 0 ? Number(settings.pitch) : 0.4;
        const yaw = clamp(gaze.x, -1, 1) * yawRange;
        const pitch = clamp(gaze.y, -1, 1) * pitchRange;
        const applier = this.vrm?.lookAt?.applier;
        if (applier?.applyYawPitch) applier.applyYawPitch(yaw, pitch);
    }

    apply(frame, calibration, options, out) {
        this.written = [];
        this.applyHead(frame, calibration, out);
        this.applyGaze(frame);
        if (frame?.face?.blendshapes) this.applyBlendshapes(frame.face.blendshapes, options);
        return this.written.slice();
    }
}
