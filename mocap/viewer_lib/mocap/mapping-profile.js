/**
 * Per-VRM mapping profile. Defaults come from the loaded humanoid.
 * this [2026-09-25] | INFO | mapping-profile | Seated models lock the legs. Perfect-sync faces skip the preset table.
 */

import { expressionNames, hasPerfectSync } from './face-mapper.js';

const GROUPS = {
    torso: ['hips', 'spine', 'chest', 'upperChest'],
    head: ['neck', 'head'],
    leftArm: ['leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand'],
    rightArm: ['rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand'],
    leftLeg: ['leftUpperLeg', 'leftLowerLeg', 'leftFoot'],
    rightLeg: ['rightUpperLeg', 'rightLowerLeg', 'rightFoot'],
};

export function boneExists(vrm, name) {
    return Boolean(vrm?.humanoid?.getNormalizedBoneNode?.(name) || vrm?.humanoid?.humanBones?.[name]?.node);
}

export function inspectVrm(vrm) {
    const bones = {};
    for (const names of Object.values(GROUPS)) {
        for (const name of names) bones[name] = boneExists(vrm, name);
    }
    const fingers = [];
    for (const side of ['left', 'right']) {
        for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
            const name = `${side}${finger}Proximal`;
            if (boneExists(vrm, name)) fingers.push(name);
        }
    }
    return {
        specVersion: vrm?.meta?.metaVersion || (vrm?.meta ? '1' : '0'),
        bones,
        fingers,
        expressions: expressionNames(vrm),
        perfectSync: hasPerfectSync(vrm),
    };
}

export function defaultProfile(vrm, name = '') {
    const info = vrm ? inspectVrm(vrm) : { bones: {}, fingers: [], perfectSync: false };
    const seated = /chair|wheel|sit/i.test(name);
    const bones = {};
    for (const [group, names] of Object.entries(GROUPS)) {
        const legs = group.endsWith('Leg');
        for (const bone of names) {
            if (info.bones && info.bones[bone] === false) continue;
            bones[bone] = { enabled: !(seated && legs), weight: 1 };
        }
    }
    return {
        v: 1,
        vrm: name,
        mirror: false,
        seated,
        scale: 0,
        smoothing: { body: 0.35, arms: 0.55, legs: 0.45, hands: 0.28, face: 0.22 },
        armOffsets: {
            leftUpper: [0, 0, 0], leftLower: [0, 0, 0],
            rightUpper: [0, 0, 0], rightLower: [0, 0, 0],
        },
        bones,
        fingers: {
            enabled: info.fingers.length > 0,
            curlGain: 1,
            splayGain: 0.65,
            thumbOpposition: 1,
        },
        expressions: {},
        gaze: { enabled: true, yaw: 0.6, pitch: 0.4 },
    };
}

export function mergeProfile(base, override) {
    const next = {
        ...base,
        ...(override || {}),
        smoothing: { ...(base?.smoothing || {}), ...(override?.smoothing || {}) },
        bones: { ...(base?.bones || {}) },
        fingers: { ...(base?.fingers || {}), ...(override?.fingers || {}) },
        expressions: { ...(base?.expressions || {}), ...(override?.expressions || {}) },
        gaze: { ...(base?.gaze || {}), ...(override?.gaze || {}) },
        armOffsets: { ...(base?.armOffsets || {}), ...(override?.armOffsets || {}) },
    };
    if (override?.bones) {
        for (const [name, spec] of Object.entries(override.bones)) {
            next.bones[name] = { ...(base?.bones?.[name] || {}), ...spec };
        }
    }
    next.v = 1;
    return next;
}
