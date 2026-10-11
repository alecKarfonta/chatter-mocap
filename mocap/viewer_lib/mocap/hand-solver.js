/**
 * Hand orientation and finger curl.
 * this [2026-09-25] | INFO | hand-solver | Palm basis from wrist, index MCP, and pinky MCP. Thumb uses opposition.
 */

import * as THREE from 'three';

const CHAINS = {
    index: [5, 6, 7, 8],
    middle: [9, 10, 11, 12],
    ring: [13, 14, 15, 16],
    little: [17, 18, 19, 20],
};

const BONES = {
    left: {
        hand: 'leftHand',
        index: ['leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal'],
        middle: ['leftMiddleProximal', 'leftMiddleIntermediate', 'leftMiddleDistal'],
        ring: ['leftRingProximal', 'leftRingIntermediate', 'leftRingDistal'],
        little: ['leftLittleProximal', 'leftLittleIntermediate', 'leftLittleDistal'],
        thumb: ['leftThumbProximal', 'leftThumbIntermediate', 'leftThumbDistal'],
    },
    right: {
        hand: 'rightHand',
        index: ['rightIndexProximal', 'rightIndexIntermediate', 'rightIndexDistal'],
        middle: ['rightMiddleProximal', 'rightMiddleIntermediate', 'rightMiddleDistal'],
        ring: ['rightRingProximal', 'rightRingIntermediate', 'rightRingDistal'],
        little: ['rightLittleProximal', 'rightLittleIntermediate', 'rightLittleDistal'],
        thumb: ['rightThumbProximal', 'rightThumbIntermediate', 'rightThumbDistal'],
    },
};

const CURL_LIMIT = {
    proximal: [-0.25, 1.45],
    intermediate: [0, 1.7],
    distal: [0, 1.35],
};
const SPLAY_LIMIT = [-0.4, 0.4];

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function toVec(point) {
    return new THREE.Vector3(point[0], point[1], point[2]);
}

function dir(a, b) {
    return b.clone().sub(a);
}

export class HandSolver {
    constructor(vrm, profile = {}) {
        this.vrm = vrm;
        this.profile = profile;
        this._q = new THREE.Quaternion();
    }

    setProfile(profile) {
        this.profile = profile || {};
    }

    bone(name) {
        return this.vrm?.humanoid?.getNormalizedBoneNode?.(name) || null;
    }

    fingerOpts() {
        const fingers = this.profile?.fingers || {};
        return {
            enabled: fingers.enabled !== false,
            curlGain: Number(fingers.curlGain) > 0 ? Number(fingers.curlGain) : 1,
            splayGain: Number(fingers.splayGain) > 0 ? Number(fingers.splayGain) : 0.65,
            thumbOpposition: Number(fingers.thumbOpposition) > 0 ? Number(fingers.thumbOpposition) : 1,
        };
    }

    palmBasis(landmarks, side) {
        const wrist = toVec(landmarks[0]);
        const index = toVec(landmarks[5]);
        const pinky = toVec(landmarks[17]);
        const middle = toVec(landmarks[9]);
        const across = index.clone().sub(pinky);
        const forward = middle.clone().sub(wrist);
        if (across.lengthSq() < 1e-8 || forward.lengthSq() < 1e-8) return null;
        across.normalize();
        forward.normalize();
        let normal = new THREE.Vector3().crossVectors(across, forward).normalize();
        if (side === 'right') normal.negate();
        const xAxis = new THREE.Vector3().crossVectors(normal, forward).normalize();
        const matrix = new THREE.Matrix4().makeBasis(xAxis, forward, normal);
        return { wrist, forward, normal, xAxis, quat: new THREE.Quaternion().setFromRotationMatrix(matrix) };
    }

    writeQuat(name, quat, out) {
        if (!quat || !this.bone(name)) return;
        out[name] = quat.clone();
    }

    curlQuat(parentDir, childDir, palmNormal, palmAcross, curlGain, splayGain, slot) {
        const a = parentDir.clone().normalize();
        const b = childDir.clone().normalize();
        if (a.lengthSq() < 1e-8 || b.lengthSq() < 1e-8) return null;
        const bend = Math.acos(clamp(a.dot(b), -1, 1));
        const limits = CURL_LIMIT[slot] || CURL_LIMIT.proximal;
        const curl = clamp(bend * curlGain, limits[0], limits[1]);
        const reject = b.clone().addScaledVector(a, -b.dot(a));
        let splay = 0;
        if (reject.lengthSq() > 1e-8) {
            const sign = Math.sign(palmNormal.clone().cross(a).dot(reject));
            splay = clamp(reject.length() * splayGain * sign, SPLAY_LIMIT[0], SPLAY_LIMIT[1]);
        }
        const curlQ = new THREE.Quaternion().setFromAxisAngle(palmAcross, curl);
        const splayQ = new THREE.Quaternion().setFromAxisAngle(palmNormal, splay);
        return splayQ.multiply(curlQ);
    }

    solveSide(side, hand, opts, out) {
        const landmarks = hand?.landmarks;
        if (!landmarks || landmarks.length < 21 || (hand.score ?? 1) < 0.35) return;
        const names = BONES[side];
        const palm = this.palmBasis(landmarks, side);
        if (!palm) return;
        if (this.bone(names.hand)) {
            const rest = new THREE.Quaternion();
            const node = this.bone(names.hand);
            const parentQ = new THREE.Quaternion();
            node.parent?.getWorldQuaternion(parentQ);
            const local = parentQ.invert().multiply(palm.quat);
            rest.copy(local);
            this.writeQuat(names.hand, rest, out);
        }
        const slots = ['proximal', 'intermediate', 'distal'];
        for (const [finger, indices] of Object.entries(CHAINS)) {
            const bones = names[finger];
            for (let i = 0; i < 3; i += 1) {
                const from = toVec(landmarks[indices[i]]);
                const mid = toVec(landmarks[indices[i + 1]]);
                const next = indices[i + 2] != null ? toVec(landmarks[indices[i + 2]]) : null;
                const parentDir = i === 0 ? palm.forward : dir(toVec(landmarks[indices[i - 1]]), from);
                const childDir = next ? dir(mid, next) : dir(from, mid);
                const quat = this.curlQuat(parentDir, childDir, palm.normal, palm.xAxis, opts.curlGain, opts.splayGain, slots[i]);
                if (quat) this.writeQuat(bones[i], quat, out);
            }
        }
        this.solveThumb(side, landmarks, palm, opts, out);
    }

    solveThumb(side, landmarks, palm, opts, out) {
        const bones = BONES[side].thumb;
        const cmc = toVec(landmarks[1]);
        const mcp = toVec(landmarks[2]);
        const ip = toVec(landmarks[3]);
        const tip = toVec(landmarks[4]);
        const points = [cmc, mcp, ip, tip];
        const sign = side === 'left' ? 1 : -1;
        for (let i = 0; i < 3; i += 1) {
            const a = points[i];
            const b = points[i + 1];
            const segment = b.clone().sub(a).normalize();
            const oppose = clamp(segment.dot(palm.normal) * -1.4 * opts.thumbOpposition * sign, -0.4, 1.15);
            const curl = clamp(Math.acos(clamp(palm.forward.dot(segment), -1, 1)) * opts.curlGain, 0, 1.2);
            const quat = new THREE.Quaternion()
                .setFromAxisAngle(palm.xAxis, oppose)
                .multiply(new THREE.Quaternion().setFromAxisAngle(palm.normal, curl * 0.45));
            this.writeQuat(bones[i], quat, out);
        }
    }

    solve(frame, out) {
        const opts = this.fingerOpts();
        if (!opts.enabled || !frame?.hands) return out;
        this.solveSide('left', frame.hands.left, opts, out);
        this.solveSide('right', frame.hands.right, opts, out);
        return out;
    }
}
