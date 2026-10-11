/**
 * Body retarget onto VRM normalized bones.
 * this [2026-09-25] | INFO | body-solver | Torso basis plus two-bone arms. Legs stay off while seated.
 */

import * as THREE from 'three';
import { jointPoint } from './protocol.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

const ARM = {
    left: {
        shoulder: 'leftShoulder', upper: 'leftUpperArm', lower: 'leftLowerArm', hand: 'leftHand',
        sh: 'leftShoulder', el: 'leftElbow', wr: 'leftWrist',
    },
    right: {
        shoulder: 'rightShoulder', upper: 'rightUpperArm', lower: 'rightLowerArm', hand: 'rightHand',
        sh: 'rightShoulder', el: 'rightElbow', wr: 'rightWrist',
    },
};

const LEG = {
    left: { upper: 'leftUpperLeg', lower: 'leftLowerLeg', foot: 'leftFoot', hip: 'leftHip', knee: 'leftKnee', ankle: 'leftAnkle' },
    right: { upper: 'rightUpperLeg', lower: 'rightLowerLeg', foot: 'rightFoot', hip: 'rightHip', knee: 'rightKnee', ankle: 'rightAnkle' },
};

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function round3(value) {
    return Math.round(value * 1000) / 1000;
}

function sub(a, b) {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dist(a, b) {
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export class BodySolver {
    constructor(vrm, profile = {}) {
        this.vrm = vrm;
        this.profile = profile;
        this.restAxes = {};
        this.standing = {};
        this.smoothed = new Set();
        this.armMissing = {};
        this.legMissing = {};
        this.lastScale = 0;
        this.resetFit();
        this.captureStanding();
    }

    setProfile(profile) {
        this.profile = profile || {};
    }

    bone(name) {
        return this.vrm?.humanoid?.getNormalizedBoneNode?.(name) || null;
    }

    boneEnabled(name) {
        const spec = this.profile?.bones?.[name];
        if (spec && spec.enabled === false) return false;
        return Boolean(this.bone(name));
    }

    weight(name) {
        const spec = this.profile?.bones?.[name];
        const value = Number(spec?.weight);
        return Number.isFinite(value) ? clamp(value, 0, 1) : 1;
    }

    captureStanding() {
        this.vrm?.scene?.updateMatrixWorld?.(true);
        const worldOf = (name) => {
            const node = this.bone(name);
            if (!node) return null;
            const point = new THREE.Vector3();
            node.getWorldPosition(point);
            return { x: point.x, y: point.y, z: point.z };
        };
        this.standing = {};
        for (const name of [
            'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
            'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm',
            'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand',
            'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot',
        ]) {
            const point = worldOf(name);
            if (point) this.standing[name] = point;
        }
        return this.standing;
    }

    restAxis(boneName, childName) {
        const key = `${boneName}:${childName}`;
        if (this.restAxes[key]) return this.restAxes[key].clone();
        const bone = this.bone(boneName);
        const child = this.bone(childName);
        let axis = new THREE.Vector3(0, 1, 0);
        if (bone && child && child.parent === bone && child.position.lengthSq() > 1e-8) {
            axis = child.position.clone();
        } else if (bone && child) {
            axis = bone.worldToLocal(child.getWorldPosition(new THREE.Vector3()));
        }
        if (axis.lengthSq() < 1e-8) axis.set(0, 1, 0);
        this.restAxes[key] = axis.normalize();
        return this.restAxes[key].clone();
    }

    aimBone(boneName, childName, worldTarget) {
        const node = this.bone(boneName);
        if (!node || !worldTarget || !node.parent) return null;
        const restAxis = this.restAxis(boneName, childName);
        node.parent.updateWorldMatrix(true, false);
        node.updateWorldMatrix(true, false);
        const origin = new THREE.Vector3();
        node.getWorldPosition(origin);
        const parentQ = new THREE.Quaternion();
        node.parent.getWorldQuaternion(parentQ);
        const desiredWorld = worldTarget.clone().sub(origin);
        if (desiredWorld.lengthSq() < 1e-8) return null;
        const desiredLocal = desiredWorld.normalize().applyQuaternion(parentQ.invert());
        if (desiredLocal.lengthSq() < 1e-8 || restAxis.dot(desiredLocal) < -0.999) {
            const ortho = Math.abs(restAxis.x) < 0.9 ? _v1.set(1, 0, 0) : _v1.set(0, 1, 0);
            const twist = new THREE.Vector3().crossVectors(restAxis, ortho).normalize();
            _q.setFromAxisAngle(twist, Math.PI);
        } else {
            _q.setFromUnitVectors(restAxis, desiredLocal);
        }
        return _q.clone();
    }

    solveTwoBone(chain, wristWorld, elbowHintWorld) {
        const upperNode = this.bone(chain.upper);
        const lowerNode = this.bone(chain.lower);
        if (!upperNode || !lowerNode || !upperNode.parent) return null;
        const sh = this.standing[chain.upper];
        const elb = this.standing[chain.lower];
        const hand = this.standing[chain.hand];
        if (!sh || !elb || !hand) return null;
        const L1 = dist(sh, elb);
        const L2 = dist(elb, hand);
        if (L1 < 1e-4 || L2 < 1e-4) return null;
        upperNode.parent.updateWorldMatrix(true, false);
        const origin = new THREE.Vector3();
        upperNode.getWorldPosition(origin);
        const toTarget = wristWorld.clone().sub(origin);
        const distW = toTarget.length();
        if (distW < 1e-4) return null;
        const reach = Math.min(Math.max(distW, Math.abs(L1 - L2) + 1e-3), L1 + L2 - 1e-3);
        const cosUpper = clamp((L1 * L1 + reach * reach - L2 * L2) / (2 * L1 * reach), -1, 1);
        const bend = Math.acos(cosUpper);
        const dir = toTarget.clone().normalize();
        let pole = null;
        if (elbowHintWorld) {
            pole = elbowHintWorld.clone().sub(origin);
            pole.addScaledVector(dir, -pole.dot(dir));
        }
        if (!pole || pole.lengthSq() < 1e-6) pole = _v2.set(0, -1, 0).sub(dir.clone().multiplyScalar(-dir.y));
        if (pole.lengthSq() < 1e-6) pole = _v2.set(0, 0, 1);
        pole.normalize();
        const sign = chain.upper.startsWith('left') ? 1 : -1;
        const axis = new THREE.Vector3().crossVectors(dir, pole);
        if (axis.lengthSq() < 1e-8) return null;
        const elbowDir = dir.clone().applyAxisAngle(axis.normalize(), -bend * sign).normalize();
        const elbowWorld = origin.clone().addScaledVector(elbowDir, L1);
        const upper = this.aimBone(chain.upper, chain.lower, elbowWorld);
        if (upper) upperNode.quaternion.copy(upper);
        upperNode.updateWorldMatrix(true, true);
        const lower = this.aimBone(chain.lower, chain.hand, wristWorld);
        return { upper, lower };
    }

    scaleFor(joints, calibration) {
        const profileScale = Number(this.profile?.scale);
        if (profileScale > 0) return profileScale;
        const srcL = jointPoint(joints, 'leftShoulder');
        const srcR = jointPoint(joints, 'rightShoulder');
        // this [2026-10-01] | FIX | BodySolver.scaleFor | A shoulder at the frame edge gives a garbage span. Keep the last good scale until both are back.
        if ((srcL?.conf ?? 0) < 0.3 || (srcR?.conf ?? 0) < 0.3) {
            return this.lastScale || calibration?.bodyScale || 1;
        }
        const vrmSpan = dist(this.standing.leftShoulder, this.standing.rightShoulder) || 0.32;
        const srcSpan = dist(srcL, srcR);
        if (srcSpan < 0.02) return calibration?.bodyScale || 1;
        const scale = clamp(vrmSpan / srcSpan, 0.35, 3);
        this.lastScale = scale;
        return scale;
    }

    toWorld(name, joints, rest, scale) {
        // this [2026-09-28] | FIX | BodySolver.toWorld | Place the live joint on the VRM. Adding the delta to the T-pose rest left the arms stuck out.
        const live = jointPoint(joints, name);
        if (!live || live.conf < 0.2) return null;
        const origin = this.standing.hips || { x: 0, y: 0, z: 0 };
        return new THREE.Vector3(
            origin.x + live.x * scale,
            origin.y + live.y * scale,
            origin.z + live.z * scale,
        );
    }

    worldForBone(boneName, jointName, joints, rest, scale) {
        return this.toWorld(jointName, joints, rest, scale);
    }

    toward() {
        const smooth = Number(this.profile?.smoothing?.body);
        return 1 - clamp(Number.isFinite(smooth) ? smooth : 0.35, 0, 0.95);
    }

    tauFor(key) {
        // this [2026-10-01] | INFO | BodySolver.tauFor | Smoothing slider becomes a time constant, so the feel is the same at any camera fps
        const amount = Number(this.profile?.smoothing?.[key]);
        const fallback = Number(this.profile?.smoothing?.body);
        const value = Number.isFinite(amount) ? amount : (Number.isFinite(fallback) ? fallback : 0.35);
        return 0.02 + clamp(value, 0, 0.95) * 0.4;
    }

    alphaFor(key, dt) {
        return 1 - Math.exp(-Math.max(dt, 1e-4) / this.tauFor(key));
    }

    resetFit() {
        this.lengths = {};
        this.dirs = {};
        this.lastSolveT = 0;
    }

    learnLength(key, value, prior) {
        // this [2026-09-30] | INFO | BodySolver.learnLength | The longest this segment has looked is the person's real length. Shorter than that means it points at the camera.
        if (!this.lengths) this.lengths = {};
        const prev = this.lengths[key];
        const next = prev
            ? Math.max(prev * 0.9995, Math.min(value, prev * 1.04))
            : Math.max(value, prior);
        this.lengths[key] = next;
        return next;
    }

    liftDir(a, b, length) {
        // this [2026-09-30] | INFO | BodySolver.liftDir | Flat camera segment plus its learned length gives the missing depth
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        if (Math.abs(dz) > 1e-4) {
            const mag = Math.hypot(dx, dy, dz) || 1;
            return new THREE.Vector3(dx / mag, dy / mag, dz / mag);
        }
        const planar = Math.hypot(dx, dy);
        const flat = Math.min(1, planar / Math.max(length, 1e-4) / 0.92);
        const sign = Number(this.profile?.armDepthSign) === -1 ? -1 : 1;
        const depth = Math.sqrt(Math.max(0, 1 - flat * flat)) * sign;
        if (planar < 1e-6) return new THREE.Vector3(0, 0, sign);
        return new THREE.Vector3(dx / planar * flat, dy / planar * flat, depth).normalize();
    }

    smoothDir(key, dir, alpha) {
        if (!this.dirs) this.dirs = {};
        const prev = this.dirs[key];
        const next = prev ? prev.clone().lerp(dir, alpha).normalize() : dir.clone();
        this.dirs[key] = next;
        return next.clone();
    }

    armOffsetQuat(side, part) {
        // this [2026-10-01] | INFO | BodySolver.armOffsetQuat | User trim in degrees, applied as a world-space post-rotation so the meaning is bind-pose independent
        const spec = this.profile?.armOffsets?.[`${side}${part === 'upper' ? 'Upper' : 'Lower'}`];
        if (!spec) return null;
        const euler = new THREE.Euler(
            THREE.MathUtils.degToRad(Number(spec[0]) || 0),
            THREE.MathUtils.degToRad(Number(spec[1]) || 0),
            THREE.MathUtils.degToRad(Number(spec[2]) || 0),
            'ZYX',
        );
        _q2.setFromEuler(euler);
        return _q2.clone();
    }

    applyWorldOffset(node, worldOffsetQuat) {
        if (!node || !worldOffsetQuat) return;
        node.updateWorldMatrix(true, false);
        const worldQ = node.getWorldQuaternion(new THREE.Quaternion());
        worldQ.premultiply(worldOffsetQuat);
        const parentQ = node.parent.getWorldQuaternion(new THREE.Quaternion());
        node.quaternion.copy(parentQ.invert().multiply(worldQ));
    }

    armMapMatrix(side, calibration) {
        // this [2026-10-06] | INFO | BodySolver.armMapMatrix | The 3-pose calibration fits a per-side 3x3 that maps camera arm deltas onto down/out/forward
        const matrix = calibration?.armMap?.arms?.[side]?.m;
        if (!Array.isArray(matrix) || matrix.length !== 9) return null;
        if (!matrix.every((value) => Number.isFinite(value))) return null;
        return matrix;
    }

    applyArmMap(delta, matrix) {
        return {
            x: matrix[0] * delta.x + matrix[1] * delta.y + matrix[2] * delta.z,
            y: matrix[3] * delta.x + matrix[4] * delta.y + matrix[5] * delta.z,
            z: matrix[6] * delta.x + matrix[7] * delta.y + matrix[8] * delta.z,
        };
    }

    fitArm(side, joints, dt, info, calibration) {
        // this [2026-09-30] | INFO | BodySolver.fitArm | Aim the VRM arm along the camera arm, the same way the left-arm mapping check does
        const chain = ARM[side];
        let sh = jointPoint(joints, chain.sh);
        let el = jointPoint(joints, chain.el);
        let wr = jointPoint(joints, chain.wr);
        const ls = jointPoint(joints, 'leftShoulder');
        const rs = jointPoint(joints, 'rightShoulder');
        const upperNode = this.bone(chain.upper);
        const lowerNode = this.bone(chain.lower);
        const handNode = this.bone(chain.hand);
        if (!sh || !el || !wr || !upperNode || !lowerNode || !handNode) return 'no-joints';
        // this [2026-10-08] | FIX | BodySolver.fitArm | Vision drops wrist/elbow confidence to ~0.1 when hands cross the face (occlusion), but the POSITIONS stay good.
        // Bail only on near-zero data, not low confidence; wild positions are rejected by the plausibility gates below.
        if ((sh.conf ?? 1) < 0.05 || (el.conf ?? 1) < 0.05) return 'low-confidence';
        const armMap = this.armMapMatrix(side, calibration);
        const rawCamera = {
            upper: [round3(el.x - sh.x), round3(el.y - sh.y)],
            lower: [round3(wr.x - el.x), round3(wr.y - el.y)],
        };
        if (armMap) {
            // this [2026-10-06] | INFO | BodySolver.fitArm | 3-pose armMap runs on camera-space shoulder deltas, the same space it was fitted in
            const rawSh = sh;
            const rawEl = el;
            const rawWr = wr;
            sh = this.applyArmMap(sh, armMap);
            el = this.applyArmMap(el, armMap);
            wr = this.applyArmMap(wr, armMap);
            sh.conf = rawSh.conf;
            el.conf = rawEl.conf;
            wr.conf = rawWr.conf;
        }
        const wristTrusted = (wr.conf ?? 1) >= 0.25;
        // this [2026-10-08] | FIX | BodySolver.fitArm | Plausibility: wrist can't be below hips or absurdly far from its shoulder (occluded-camera garbage)
        const span2 = ls && rs ? Math.hypot(ls.x - rs.x, ls.y - rs.y) : 0.35;
        const wristPlausible = Math.hypot(wr.x - sh.x, wr.y - sh.y, wr.z - sh.z) < span2 * 3
            && wr.y > -0.05;
        const elbowPlausible = Math.hypot(el.x - sh.x, el.y - sh.y, el.z - sh.z) < span2 * 2.5
            && el.y > -0.05;
        if (!elbowPlausible) return 'low-confidence';
        const span = span2;
        const upperLen = this.learnLength('upper', Math.hypot(el.x - sh.x, el.y - sh.y), span * 0.7);
        const lowerLen = wristTrusted
            ? this.learnLength('lower', Math.hypot(wr.x - el.x, wr.y - el.y), span * 0.6)
            : (this.lengths.lower || span * 0.6);
        const upperDir = this.smoothDir(`${side}Upper`, this.liftDir(sh, el, upperLen), this.alphaFor('arms', dt));
        // this [2026-10-01] | FIX | BodySolver.fitArm | A wrist pinned to the frame border is garbage, not data. Hold the last trusted forearm direction instead of aiming at the pin.
        const heldKey = `${side}LowerHeld`;
        // this [2026-10-08] | FIX | BodySolver.fitArm | Accept low-confidence wrists when position is plausible: hands at the face read conf~0.1 but track fine
        if (wristTrusted || wristPlausible) this.dirs[heldKey] = this.liftDir(el, wr, lowerLen);
        const rawLower = this.dirs[heldKey] || new THREE.Vector3(0.15, -0.98, 0.05).normalize();
        const lowerDir = this.smoothDir(`${side}Lower`, rawLower.clone(), this.alphaFor('arms', dt));
        const L1 = dist(this.standing[chain.upper], this.standing[chain.lower]) || 0.25;
        const L2 = dist(this.standing[chain.lower], this.standing[chain.hand]) || 0.22;
        const origin = upperNode.getWorldPosition(new THREE.Vector3());
        const elbowTarget = origin.clone().addScaledVector(upperDir, L1);
        const upperQ = this.aimBone(chain.upper, chain.lower, elbowTarget);
        if (!upperQ) return 'aim-failed';
        upperNode.quaternion.copy(upperQ);
        upperNode.updateWorldMatrix(true, true);
        const elbowAt = lowerNode.getWorldPosition(new THREE.Vector3());
        const wristTarget = elbowAt.clone().addScaledVector(lowerDir, L2);
        const lowerQ = this.aimBone(chain.lower, chain.hand, wristTarget);
        if (!lowerQ) return 'aim-failed';
        lowerNode.quaternion.copy(lowerQ);
        lowerNode.updateWorldMatrix(true, true);
        // this [2026-10-01] | INFO | BodySolver.fitArm | Trim sliders: a world-space nudge after aiming, upper first so the forearm aim follows the adjusted elbow
        const upperTrim = this.armOffsetQuat(side, 'upper');
        if (upperTrim) {
            this.applyWorldOffset(upperNode, upperTrim);
            upperNode.updateWorldMatrix(true, true);
        }
        const trimmedElbow = lowerNode.getWorldPosition(new THREE.Vector3());
        const trimmedWrist = trimmedElbow.clone().addScaledVector(lowerDir, L2);
        const trimmedLowerQ = this.aimBone(chain.lower, chain.hand, trimmedWrist);
        if (trimmedLowerQ) lowerNode.quaternion.copy(trimmedLowerQ);
        const lowerTrim = this.armOffsetQuat(side, 'lower');
        if (lowerTrim) this.applyWorldOffset(lowerNode, lowerTrim);
        upperNode.updateWorldMatrix(true, true);
        lowerNode.updateWorldMatrix(true, true);
        info.shoulder = [round3(origin.x), round3(origin.y), round3(origin.z)];
        info.elbow = [round3(elbowTarget.x), round3(elbowTarget.y), round3(elbowTarget.z)];
        info.target = [round3(wristTarget.x), round3(wristTarget.y), round3(wristTarget.z)];
        info.camera = {
            upper: rawCamera.upper,
            lower: rawCamera.lower,
            ...(armMap ? { mapped: true } : {}),
        };
        info.lengths = { upper: round3(upperLen), lower: round3(lowerLen) };
        info.upperDir = [round3(upperDir.x), round3(upperDir.y), round3(upperDir.z)];
        info.lowerDir = [round3(lowerDir.x), round3(lowerDir.y), round3(lowerDir.z)];
        return { upper: upperNode.quaternion.clone(), lower: lowerNode.quaternion.clone() };
    }

    solveTorso(joints, rest, scale, out) {
        const ls = jointPoint(joints, 'leftShoulder');
        const rs = jointPoint(joints, 'rightShoulder');
        const head = jointPoint(joints, 'head') || jointPoint(joints, 'nose');
        if (!ls || !rs) return;
        // this [2026-10-01] | FIX | BodySolver.solveTorso | One shoulder half out of frame twists the torso. Hold the last pose instead.
        if ((ls.conf ?? 1) < 0.3 || (rs.conf ?? 1) < 0.3) return;
        const liveAcross = sub(ls, rs);
        const yaw = clamp(Math.atan2(liveAcross.z, liveAcross.x || 0.001), -0.7, 0.7);
        const roll = clamp(Math.atan2(liveAcross.y, Math.abs(liveAcross.x) || 0.001), -0.4, 0.4);
        // this [2026-10-06] | FIX | BodySolver.solveTorso | True lean: hips->head axis vs gravity (hips-centered joints)
        let pitch = 0;
        const hipL = jointPoint(joints, 'leftHip');
        const hipR = jointPoint(joints, 'rightHip');
        if (head && hipL && hipR) {
            const spineLen = Math.hypot(head.x - (hipL.x + hipR.x) / 2, head.y - (hipL.y + hipR.y) / 2, head.z - (hipL.z + hipR.z) / 2);
            if (spineLen > 0.2) {
                // this [2026-10-06] | FIX | BodySolver.solveTorso | Lean toward camera = +z = positive pitch = lean back; sign was inverted
                pitch = clamp(Math.asin(clamp((head.z - (hipL.z + hipR.z) / 2) / spineLen, -1, 1)) * 0.8, -0.45, 0.45);
            }
        }
        const spread = [
            ['hips', 0.45, 0.2, 0.55],
            ['spine', 0.7, 0.45, 0.7],
            ['chest', 0.85, 0.7, 0.85],
            ['upperChest', 0.55, 0.4, 0.5],
        ];
        // this [2026-10-06] | FIX | BodySolver.solveTorso | Weights distribute the bend; normalized they sum to 1 so movements are 1:1, not 2.5x
        const active = spread.filter(([name]) => this.boneEnabled(name));
        const total = { yaw: 0, pitch: 0, roll: 0 };
        for (const [, yw, pw, rw] of active) {
            total.yaw += yw;
            total.pitch += pw;
            total.roll += rw;
        }
        for (const [name, yw, pw, rw] of active) {
            const weight = this.weight(name);
            _q.setFromEuler(new THREE.Euler(
                pitch * (pw / (total.pitch || 1)) * weight,
                yaw * (yw / (total.yaw || 1)) * weight,
                roll * (rw / (total.roll || 1)) * weight,
                'YXZ'));
            out[name] = _q.clone();
        }
        if (head && this.boneEnabled('neck') && !out.neck) {
            // this [2026-10-06] | FIX | BodySolver.solveTorso | Neck adds a small follow on top of the now-1:1 torso
            _q.setFromEuler(new THREE.Euler(pitch * 0.15, yaw * 0.15, roll * 0.1, 'YXZ'));
            out.neck = _q.clone();
        }
    }

    solve(frame, calibration, out) {
        const joints = frame?.body?.joints;
        if (!joints) return out;
        const rest = calibration?.rest || null;
        const scale = this.scaleFor(joints, calibration);
        const trace = { scale: round3(scale), arms: {} };
        this.trace = trace;
        const nowS = (frame?.t || Date.now()) / 1000;
        const dt = this.lastSolveT ? clamp(nowS - this.lastSolveT, 1 / 120, 0.25) : 1 / 30;
        this.lastSolveT = nowS;
        const toward = this.alphaFor('body', dt);
        this.smoothed = new Set();
        this.solveTorso(joints, rest, scale, out);
        for (const name of ['hips', 'spine', 'chest', 'upperChest']) {
            const node = this.bone(name);
            if (!node || !out[name]) continue;
            node.quaternion.slerp(out[name], toward);
            out[name] = node.quaternion.clone();
            this.smoothed.add(name);
        }
        this.bone('hips')?.updateWorldMatrix(true, true);
        const quality = frame.quality || {};
        for (const side of ['left', 'right']) {
            const chain = ARM[side];
            const armQ = Number(quality[`${side}Arm`] ?? quality.body ?? 1);
            const info = { quality: round3(armQ) };
            trace.arms[side] = info;
            if (armQ < 0.05) {
                info.reason = 'low-quality';
                this.armMissing[side] = this.armMissing[side] || nowS;
                this.easeMissing(chain, this.armMissing, side, nowS, out, 0.5);
                continue;
            }
            this.armMissing[side] = 0;
            if (!this.boneEnabled(chain.upper)) {
                info.reason = 'bone-off';
                continue;
            }
            const shoulderNode = this.bone(chain.shoulder);
            if (shoulderNode) {
                shoulderNode.quaternion.identity();
                shoulderNode.updateWorldMatrix(true, true);
                out[chain.shoulder] = shoulderNode.quaternion.clone();
                this.smoothed.add(chain.shoulder);
            }
            const solved = this.fitArm(side, joints, dt, info, calibration);
            if (typeof solved === 'string') {
                info.reason = solved;
                this.armMissing[side] = this.armMissing[side] || nowS;
                this.easeMissing(chain, this.armMissing, side, nowS, out, 0.5);
                continue;
            }
            info.reason = 'ok';
            out[chain.upper] = solved.upper;
            out[chain.lower] = solved.lower;
            this.smoothed.add(chain.upper);
            this.smoothed.add(chain.lower);
        }
        if (this.profile?.seated) return out;
        for (const side of ['left', 'right']) {
            const chain = LEG[side];
            if (!this.boneEnabled(chain.upper)) continue;
            const ankle = this.worldForBone(chain.foot, chain.ankle, joints, rest, scale)
                || this.worldForBone(chain.lower, chain.knee, joints, rest, scale);
            if (!ankle) {
                // this [2026-10-01] | FIX | BodySolver.solve | A leg out of frame froze mid-air. Hold, then ease back to standing.
                this.legMissing[side] = this.legMissing[side] || nowS;
                this.easeMissing(chain, this.legMissing, side, nowS, out, 0.25);
                continue;
            }
            this.legMissing[side] = 0;
            const knee = this.worldForBone(chain.lower, chain.knee, joints, rest, scale);
            const legAlpha = this.alphaFor('legs', dt);
            const smoothTarget = (target) => target ? this.smoothVec(`leg${side}`, target, legAlpha) : target;
            const solved = this.solveTwoBone(
                { upper: chain.upper, lower: chain.lower, hand: chain.foot },
                smoothTarget(ankle),
                smoothTarget(knee),
            );
            if (!solved) continue;
            if (solved.upper) {
                const node = this.bone(chain.upper);
                if (node) {
                    node.quaternion.slerp(solved.upper, legAlpha);
                    out[chain.upper] = node.quaternion.clone();
                    this.smoothed.add(chain.upper);
                }
            }
            if (solved.lower) {
                const node = this.bone(chain.lower);
                if (node) {
                    node.quaternion.slerp(solved.lower, legAlpha);
                    out[chain.lower] = node.quaternion.clone();
                    this.smoothed.add(chain.lower);
                }
            }
        }
        return out;
    }

    smoothVec(key, target, alpha) {
        if (!this.dirs) this.dirs = {};
        const prev = this.dirs[key];
        const next = prev ? prev.lerp(target, alpha).clone() : target.clone();
        this.dirs[key] = next;
        return next;
    }

    easeMissing(chain, missingMap, side, nowS, out, holdSeconds, restTarget = null) {
        // this [2026-10-01] | INFO | BodySolver.easeMissing | Limb left the frame: hold the last pose briefly, then drift toward neutral
        // this [2026-10-08] | FIX | BodySolver.easeMissing | Slower (2.5s) smoothstep drift to the arms-out neutral; snap-back on return is handled by normal arm smoothing
        const gone = nowS - (missingMap[side] || nowS);
        if (gone < holdSeconds) return;
        const linear = clamp((gone - holdSeconds) / 2.5, 0, 1);
        const blend = linear * linear * (3 - 2 * linear);
        const parts = chain === LEG[side] ? ['upper', 'lower'] : ['upper', 'lower'];
        for (const part of parts) {
            const name = chain[part];
            const node = this.bone(name);
            if (!node) continue;
            const rest = restTarget || this.restPose(chain, part, side);
            node.quaternion.slerp(rest, blend);
            out[name] = node.quaternion.clone();
            this.smoothed.add(name);
        }
    }

    restT() {
        // this [2026-10-01] | FIX | BodySolver.restT | VRM normalized rest IS T-pose. Aim the missing arm at a natural lowered direction instead.
        return null;
    }

    restPose(chain, part, side) {
        if (chain === LEG[side]) return new THREE.Quaternion();
        // this [2026-10-08] | FIX | BodySolver.restPose | Off-screen arms drift to "out, mostly straight" (~20° below T-pose) instead of hanging at the sides
        const outTarget = new THREE.Vector3(
            (side === 'left' ? 1 : -1) * 0.94,
            -0.34,
            0,
        ).normalize();
        const upperQuat = this.aimDirQuaternion(chain.upper, chain.lower, outTarget);
        if (part === 'upper') return upperQuat;
        const foreTarget = new THREE.Vector3(
            (side === 'left' ? 1 : -1) * 0.92,
            -0.39,
            0.04,
        ).normalize();
        return this.aimDirQuaternion(chain.lower, chain.hand, foreTarget);
    }

    aimDirQuaternion(boneName, childName, dirWorld) {
        const node = this.bone(boneName);
        if (!node || !node.parent) return new THREE.Quaternion();
        node.parent.updateWorldMatrix(true, false);
        const parentQ = node.parent.getWorldQuaternion(new THREE.Quaternion());
        const desiredLocal = dirWorld.clone().normalize().applyQuaternion(parentQ.invert());
        const restAxis = this.restAxis(boneName, childName);
        if (desiredLocal.lengthSq() < 1e-8) return node.quaternion.clone();
        _q.identity();
        if (restAxis.dot(desiredLocal) < -0.999) {
            const ortho = Math.abs(restAxis.x) < 0.9 ? _v1.set(1, 0, 0) : _v1.set(0, 1, 0);
            const twist = new THREE.Vector3().crossVectors(restAxis, ortho).normalize();
            _q.setFromAxisAngle(twist, Math.PI);
        } else {
            _q.setFromUnitVectors(restAxis, desiredLocal);
        }
        return _q.clone();
    }
}
