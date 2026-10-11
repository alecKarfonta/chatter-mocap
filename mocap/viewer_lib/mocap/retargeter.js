/**
 * Facade that drives a VRM from MocapFrame v1.
 * this [2026-09-25] | INFO | retargeter | Writes normalized bones, then humanoid.update so the raw rig follows.
 */

import * as THREE from 'three';
import { normalizeFrame } from './protocol.js';
// this [2026-10-01] | FIX | retargeter.imports | Root-absolute path 404s when avatar is mounted under /avatar/ (mlapi.us)
import { BodySolver } from './body-solver.js?v=trim2';
import { FilterBank } from './filters.js?v=fit1';
import { HandSolver } from './hand-solver.js';
import { FaceMapper } from './face-mapper.js';
import { defaultProfile, mergeProfile } from './mapping-profile.js';

const LOST_MS = 450;

export class MocapRetargeter {
    constructor(vrm, profile) {
        this.vrm = vrm;
        this.profile = mergeProfile(defaultProfile(vrm), profile);
        this.body = new BodySolver(vrm, this.profile);
        this.hands = new HandSolver(vrm, this.profile);
        this.face = new FaceMapper(vrm, this.profile);
        this.filters = new FilterBank();
        this.calibration = null;
        this.restQuats = {};
        this.live = {};
        this.lastFrame = null;
        this.lastAt = 0;
        this.faceKeys = [];
        this._capture = null;
        this.snapshotRest();
    }

    setProfile(profile) {
        this.profile = mergeProfile(defaultProfile(this.vrm, this.profile?.vrm), profile);
        this.body.setProfile(this.profile);
        this.hands.setProfile(this.profile);
        this.face.setProfile(this.profile);
    }

    setCalibration(calibration) {
        if (!calibration || (!calibration.rest && !calibration.armMap)) {
            this.calibration = null;
            return;
        }
        // this [2026-10-06] | INFO | MocapRetargeter.setCalibration | A new armMap changes the space fitArm aims in, so learned lengths and held dirs must restart
        const before = this.calibration?.armMap;
        const after = calibration.armMap;
        this.calibration = calibration;
        if (JSON.stringify(before) !== JSON.stringify(after)) {
            this.body.resetFit();
        }
    }

    snapshotRest() {
        this.restQuats = {};
        const humanoid = this.vrm?.humanoid;
        if (!humanoid?.humanBones) return;
        for (const name of Object.keys(humanoid.humanBones)) {
            const node = humanoid.getNormalizedBoneNode?.(name);
            if (node) this.restQuats[name] = node.quaternion.clone();
        }
    }

    beginNeutralCapture() {
        // this [2026-09-25] | INFO | MocapRetargeter.beginNeutralCapture | Average a still stance into rest offsets
        this._capture = { count: 0, sums: {} };
    }

    feedNeutral(frame) {
        if (!this._capture) this.beginNeutralCapture();
        const joints = frame?.body?.joints;
        if (!joints) return this._capture;
        for (const [name, point] of Object.entries(joints)) {
            if (!Array.isArray(point)) continue;
            const bucket = this._capture.sums[name] || { x: 0, y: 0, z: 0, n: 0 };
            bucket.x += point[0];
            bucket.y += point[1];
            bucket.z += point[2];
            bucket.n += 1;
            this._capture.sums[name] = bucket;
        }
        this._capture.count += 1;
        return this._capture;
    }

    finishNeutralCapture() {
        const capture = this._capture;
        this._capture = null;
        if (!capture || capture.count < 8) return null;
        const rest = {};
        for (const [name, bucket] of Object.entries(capture.sums)) {
            rest[name] = {
                x: bucket.x / bucket.n,
                y: bucket.y / bucket.n,
                z: bucket.z / bucket.n,
            };
        }
        const span = rest.leftShoulder && rest.rightShoulder
            ? Math.hypot(
                rest.leftShoulder.x - rest.rightShoulder.x,
                rest.leftShoulder.y - rest.rightShoulder.y,
                rest.leftShoulder.z - rest.rightShoulder.z,
            )
            : 0;
        this.calibration = { rest, bodyScale: span > 0.05 ? span : 1, neutral: true };
        return this.calibration;
    }

    ensureAutoRest(frame) {
        if (this.calibration) return;
        const joints = frame?.body?.joints;
        if (!joints?.leftShoulder || !joints?.rightShoulder || !joints?.leftWrist || !joints?.rightWrist) return;
        const rest = {};
        for (const [name, point] of Object.entries(joints)) {
            rest[name] = { x: point[0], y: point[1], z: point[2] };
        }
        this.calibration = { rest, autoRest: true, bodyScale: 1 };
    }

    applySolved(solved, timestamp, direct = null) {
        const smooth = Number(this.profile?.smoothing?.body);
        const toward = 1 - (Number.isFinite(smooth) ? smooth : 0.35);
        const humanoid = this.vrm?.humanoid;
        for (const [name, quat] of Object.entries(solved)) {
            const node = humanoid?.getNormalizedBoneNode?.(name);
            if (!node || !quat) continue;
            if (direct?.has(name)) {
                // this [2026-09-30] | INFO | MocapRetargeter.applySolved | Solver already smoothed this bone. Filtering again would shift the arm off the torso it was aimed from.
                this.filters.seedQuat(name, quat);
                node.quaternion.copy(quat);
                this.live[name] = quat.clone();
                continue;
            }
            const filtered = this.filters.quat(name, quat, timestamp / 1000, 1 - toward);
            if (!filtered) continue;
            node.quaternion.copy(filtered);
            this.live[name] = filtered.clone();
        }
        humanoid?.update?.();
    }

    fade(timestamp) {
        const toward = 0.12;
        const solved = {};
        for (const [name, rest] of Object.entries(this.restQuats)) {
            if (!this.live[name]) continue;
            solved[name] = rest.clone();
        }
        if (!Object.keys(solved).length) return;
        this.applySolved(solved, timestamp);
        if (toward > 0 && this.faceKeys.length) {
            this.face.clear(this.faceKeys);
            this.faceKeys = [];
        }
    }

    applyFrame(frame, dt = 1 / 60, options = {}) {
        if (!this.vrm?.humanoid) return;
        const normalized = normalizeFrame(frame);
        const now = normalized.t || Date.now();
        if (!normalized.body && !normalized.hands && !normalized.face) {
            if (now - this.lastAt > LOST_MS) this.fade(now);
            return;
        }
        this.lastFrame = normalized;
        this.lastAt = now;
        this.ensureAutoRest(normalized);
        if (this._capture) this.feedNeutral(normalized);
        const solved = {};
        this.body.solve(normalized, this.calibration, solved);
        this.hands.solve(normalized, solved);
        this.face.apply(normalized, this.calibration, {
            speaking: Boolean(options.speaking),
        }, solved);
        this.faceKeys = this.face.written.slice();
        this.applySolved(solved, now, this.body.smoothed);
    }

    lostFor(now = Date.now()) {
        return !this.lastAt || now - this.lastAt > LOST_MS;
    }

    tick(now = Date.now()) {
        if (this.lastFrame && this.lostFor(now)) this.fade(now);
    }

    reset() {
        const humanoid = this.vrm?.humanoid;
        for (const [name, rest] of Object.entries(this.restQuats)) {
            const node = humanoid?.getNormalizedBoneNode?.(name);
            if (node) node.quaternion.copy(rest);
            delete this.live[name];
        }
        humanoid?.update?.();
        this.face.clear(this.faceKeys);
        this.faceKeys = [];
        this.filters.reset();
        this.body.resetFit();
        this.lastFrame = null;
        this.lastAt = 0;
    }

    drivenBones() {
        return Object.keys(this.live);
    }
}

export function quatFromEuler(euler) {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(euler.x, euler.y, euler.z, 'XYZ'));
}
