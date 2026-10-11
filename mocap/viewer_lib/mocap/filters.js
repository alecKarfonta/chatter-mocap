/**
 * One Euro filters for points and quaternions.
 * this [2026-09-25] | INFO | filters | Replaces the Python JointFilter and Euler slerp on the retarget path.
 */

import * as THREE from 'three';

function alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / Math.max(dt, 1e-6));
}

export class OneEuro {
    constructor(minCutoff = 1.2, beta = 0.04, dCutoff = 1) {
        this.minCutoff = minCutoff;
        this.beta = beta;
        this.dCutoff = dCutoff;
        this.xPrev = null;
        this.dxPrev = 0;
        this.tPrev = null;
    }

    filter(value, timestamp) {
        const sample = Number(value);
        if (!Number.isFinite(sample)) return this.xPrev ?? 0;
        if (this.tPrev == null) {
            this.tPrev = timestamp;
            this.xPrev = sample;
            return sample;
        }
        const dt = Math.max(1e-4, timestamp - this.tPrev);
        const dx = (sample - this.xPrev) / dt;
        const aD = alpha(this.dCutoff, dt);
        const dxHat = aD * dx + (1 - aD) * this.dxPrev;
        const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
        const a = alpha(cutoff, dt);
        const xHat = a * sample + (1 - a) * this.xPrev;
        this.tPrev = timestamp;
        this.xPrev = xHat;
        this.dxPrev = dxHat;
        return xHat;
    }

    reset() {
        this.xPrev = null;
        this.dxPrev = 0;
        this.tPrev = null;
    }
}

export class Vec3Filter {
    constructor(minCutoff = 1.2, beta = 0.04) {
        this.axes = {
            x: new OneEuro(minCutoff, beta),
            y: new OneEuro(minCutoff, beta),
            z: new OneEuro(minCutoff, beta),
        };
    }

    filter(point, timestamp) {
        if (!point) return null;
        return {
            x: this.axes.x.filter(point.x, timestamp),
            y: this.axes.y.filter(point.y, timestamp),
            z: this.axes.z.filter(point.z, timestamp),
        };
    }

    reset() {
        for (const axis of Object.values(this.axes)) axis.reset();
    }
}

const _from = new THREE.Quaternion();
const _to = new THREE.Quaternion();

export function slerpQuat(prev, next, towardNext) {
    if (!next) return prev || null;
    if (!prev) return next.clone();
    _from.copy(prev);
    _to.copy(next);
    if (_from.dot(_to) < 0) _to.set(-_to.x, -_to.y, -_to.z, -_to.w);
    _from.slerp(_to, Math.min(1, Math.max(0, towardNext)));
    return _from.clone();
}

export class QuatFilter {
    constructor(minCutoff = 1.4, beta = 0.05) {
        this.euro = new OneEuro(minCutoff, beta);
        this.prev = null;
    }

    filter(quat, timestamp, smooth = 0.35) {
        if (!quat) return this.prev ? this.prev.clone() : null;
        const speed = this.euro.filter(1, timestamp);
        const toward = Math.min(1, Math.max(0.05, (1 - smooth) * Math.max(0.4, speed)));
        this.prev = slerpQuat(this.prev, quat, toward);
        return this.prev.clone();
    }

    reset() {
        this.euro.reset();
        this.prev = null;
    }
}

export class FilterBank {
    constructor() {
        this.vecs = new Map();
        this.quats = new Map();
    }

    vec(key, point, timestamp, minCutoff = 1.1, beta = 0.03) {
        let filter = this.vecs.get(key);
        if (!filter) {
            filter = new Vec3Filter(minCutoff, beta);
            this.vecs.set(key, filter);
        }
        return filter.filter(point, timestamp);
    }

    quat(key, quat, timestamp, smooth) {
        let filter = this.quats.get(key);
        if (!filter) {
            filter = new QuatFilter();
            this.quats.set(key, filter);
        }
        return filter.filter(quat, timestamp, smooth);
    }

    seedQuat(key, quat) {
        let filter = this.quats.get(key);
        if (!filter) {
            filter = new QuatFilter();
            this.quats.set(key, filter);
        }
        filter.prev = quat ? quat.clone() : null;
    }

    reset() {
        this.vecs.clear();
        this.quats.clear();
    }
}
