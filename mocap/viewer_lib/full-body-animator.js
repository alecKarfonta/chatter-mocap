/**
 * Full Body Animator - Client-side VRM bone manipulation for all humanoid bones
 * Extends the ArmAnimator pattern to support the complete VRM 1.0 skeleton
 */

import * as THREE from 'three';

// Complete VRM 1.0 Humanoid Bone List organized by region
export const VRM_BONE_STRUCTURE = {
    spine: {
        label: '🦴 Spine',
        bones: ['hips', 'spine', 'chest', 'upperChest']
    },
    head: {
        label: '👤 Head',
        bones: ['neck', 'head', 'leftEye', 'rightEye', 'jaw']
    },
    leftArm: {
        label: '💪 Left Arm',
        bones: ['leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand']
    },
    rightArm: {
        label: '💪 Right Arm',
        bones: ['rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand']
    },
    leftHand: {
        label: '✋ Left Hand',
        bones: [
            'leftThumbProximal', 'leftThumbIntermediate', 'leftThumbDistal',
            'leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal',
            'leftMiddleProximal', 'leftMiddleIntermediate', 'leftMiddleDistal',
            'leftRingProximal', 'leftRingIntermediate', 'leftRingDistal',
            'leftLittleProximal', 'leftLittleIntermediate', 'leftLittleDistal'
        ]
    },
    rightHand: {
        label: '✋ Right Hand',
        bones: [
            'rightThumbProximal', 'rightThumbIntermediate', 'rightThumbDistal',
            'rightIndexProximal', 'rightIndexIntermediate', 'rightIndexDistal',
            'rightMiddleProximal', 'rightMiddleIntermediate', 'rightMiddleDistal',
            'rightRingProximal', 'rightRingIntermediate', 'rightRingDistal',
            'rightLittleProximal', 'rightLittleIntermediate', 'rightLittleDistal'
        ]
    },
    leftLeg: {
        label: '🦵 Left Leg',
        bones: ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes']
    },
    rightLeg: {
        label: '🦵 Right Leg',
        bones: ['rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes']
    }
};

// Human-readable bone labels
export const BONE_LABELS = {
    hips: 'Hips',
    spine: 'Spine',
    chest: 'Chest',
    upperChest: 'Upper Chest',
    neck: 'Neck',
    head: 'Head',
    leftEye: 'Left Eye',
    rightEye: 'Right Eye',
    jaw: 'Jaw',
    leftShoulder: 'Left Shoulder',
    leftUpperArm: 'Left Upper Arm',
    leftLowerArm: 'Left Lower Arm',
    leftHand: 'Left Hand',
    rightShoulder: 'Right Shoulder',
    rightUpperArm: 'Right Upper Arm',
    rightLowerArm: 'Right Lower Arm',
    rightHand: 'Right Hand',
    leftThumbProximal: 'L Thumb Base',
    leftThumbIntermediate: 'L Thumb Mid',
    leftThumbDistal: 'L Thumb Tip',
    leftIndexProximal: 'L Index Base',
    leftIndexIntermediate: 'L Index Mid',
    leftIndexDistal: 'L Index Tip',
    leftMiddleProximal: 'L Middle Base',
    leftMiddleIntermediate: 'L Middle Mid',
    leftMiddleDistal: 'L Middle Tip',
    leftRingProximal: 'L Ring Base',
    leftRingIntermediate: 'L Ring Mid',
    leftRingDistal: 'L Ring Tip',
    leftLittleProximal: 'L Little Base',
    leftLittleIntermediate: 'L Little Mid',
    leftLittleDistal: 'L Little Tip',
    rightThumbProximal: 'R Thumb Base',
    rightThumbIntermediate: 'R Thumb Mid',
    rightThumbDistal: 'R Thumb Tip',
    rightIndexProximal: 'R Index Base',
    rightIndexIntermediate: 'R Index Mid',
    rightIndexDistal: 'R Index Tip',
    rightMiddleProximal: 'R Middle Base',
    rightMiddleIntermediate: 'R Middle Mid',
    rightMiddleDistal: 'R Middle Tip',
    rightRingProximal: 'R Ring Base',
    rightRingIntermediate: 'R Ring Mid',
    rightRingDistal: 'R Ring Tip',
    rightLittleProximal: 'R Little Base',
    rightLittleIntermediate: 'R Little Mid',
    rightLittleDistal: 'R Little Tip',
    leftUpperLeg: 'Left Upper Leg',
    leftLowerLeg: 'Left Lower Leg',
    leftFoot: 'Left Foot',
    leftToes: 'Left Toes',
    rightUpperLeg: 'Right Upper Leg',
    rightLowerLeg: 'Right Lower Leg',
    rightFoot: 'Right Foot',
    rightToes: 'Right Toes'
};

// Natural joint constraints (min/max radians for each axis)
const BONE_CONSTRAINTS = {
    // Spine
    hips: { x: [-0.5, 0.5], y: [-0.8, 0.8], z: [-0.3, 0.3] },
    spine: { x: [-0.4, 0.4], y: [-0.5, 0.5], z: [-0.3, 0.3] },
    chest: { x: [-0.3, 0.3], y: [-0.4, 0.4], z: [-0.2, 0.2] },
    upperChest: { x: [-0.2, 0.2], y: [-0.3, 0.3], z: [-0.2, 0.2] },

    // Head
    neck: { x: [-0.5, 0.5], y: [-0.8, 0.8], z: [-0.4, 0.4] },
    head: { x: [-0.5, 0.5], y: [-0.8, 0.8], z: [-0.4, 0.4] },
    leftEye: { x: [-0.3, 0.3], y: [-0.4, 0.4], z: [-0.1, 0.1] },
    rightEye: { x: [-0.3, 0.3], y: [-0.4, 0.4], z: [-0.1, 0.1] },
    jaw: { x: [-0.1, 0.4], y: [-0.1, 0.1], z: [-0.1, 0.1] },

    // Shoulders
    leftShoulder: { x: [-0.5, 0.5], y: [-0.3, 0.3], z: [-0.5, 0.5] },
    rightShoulder: { x: [-0.5, 0.5], y: [-0.3, 0.3], z: [-0.5, 0.5] },

    // Upper Arms
    leftUpperArm: { x: [-1.5, 1.5], y: [-0.8, 0.8], z: [-Math.PI, 1.5] },
    rightUpperArm: { x: [-1.5, 1.5], y: [-0.8, 0.8], z: [-1.5, Math.PI] },

    // Lower Arms (elbow)
    leftLowerArm: { x: [0, 2.5], y: [-1.5, 1.5], z: [-0.3, 0.3] },
    rightLowerArm: { x: [0, 2.5], y: [-1.5, 1.5], z: [-0.3, 0.3] },

    // Hands (wrist)
    leftHand: { x: [-0.8, 0.8], y: [-0.5, 0.5], z: [-0.4, 0.4] },
    rightHand: { x: [-0.8, 0.8], y: [-0.5, 0.5], z: [-0.4, 0.4] },

    // Fingers (shared constraints)
    _fingerProximal: { x: [-0.2, 1.5], y: [-0.3, 0.3], z: [-0.2, 0.2] },
    _fingerIntermediate: { x: [0, 1.8], y: [-0.1, 0.1], z: [-0.1, 0.1] },
    _fingerDistal: { x: [0, 1.5], y: [-0.1, 0.1], z: [-0.1, 0.1] },

    // Legs
    leftUpperLeg: { x: [-1.5, 1.5], y: [-0.5, 0.5], z: [-0.8, 0.5] },
    rightUpperLeg: { x: [-1.5, 1.5], y: [-0.5, 0.5], z: [-0.5, 0.8] },
    leftLowerLeg: { x: [-2.5, 0], y: [-0.2, 0.2], z: [-0.1, 0.1] },
    rightLowerLeg: { x: [-2.5, 0], y: [-0.2, 0.2], z: [-0.1, 0.1] },
    leftFoot: { x: [-0.8, 0.8], y: [-0.3, 0.3], z: [-0.5, 0.5] },
    rightFoot: { x: [-0.8, 0.8], y: [-0.3, 0.3], z: [-0.5, 0.5] },
    leftToes: { x: [-0.3, 0.8], y: [-0.1, 0.1], z: [-0.1, 0.1] },
    rightToes: { x: [-0.3, 0.8], y: [-0.1, 0.1], z: [-0.1, 0.1] }
};

/**
 * Catalog / editor intent space (what authors and sliders mean):
 *   +X = pitch down, bow forward, arm swing forward, elbow flex
 *   +Y = yaw / twist
 *   +Z = roll / arm raise (right +, left − is already in the data)
 *
 * This VRM's local X is the opposite pitch, and legacy lower-arm poses
 * stored elbow flex on Y (the Arm tab uses X). Convert at write time
 * instead of rewriting every pose.
 */
export const VRM_INTENT_SPACE = {
    pitchSign: -1,
    yawSign: 1,
    rollSign: 1,
    remapLegacyLowerArmElbow: false,
};

function isLowerArmBone(boneName) {
    return /LowerArm$/i.test(String(boneName || ''));
}

function usesFlippedPitch(boneName) {
    // this | INFO | usesFlippedPitch | Only torso/head +X is look-up / lean-back on this VRM
    return /^(head|neck|spine|chest|upperChest|hips)$/i.test(String(boneName || ''));
}

/**
 * this | INFO | intentToVrmRotation | Map authored intent eulers into this VRM's local bone space
 */
export function intentToVrmRotation(boneName, intent = {}) {
    let x = Number(intent.x) || 0;
    let y = Number(intent.y) || 0;
    let z = Number(intent.z) || 0;

    if (VRM_INTENT_SPACE.remapLegacyLowerArmElbow && isLowerArmBone(boneName) && Math.abs(y) > Math.abs(x) + 0.05) {
        // this | INFO | intentToVrmRotation | Legacy elbow flex was authored on Y; Arm tab flex is X
        x = Math.abs(y);
        y = Number(intent.x) || 0;
    }

    const pitchSign = usesFlippedPitch(boneName) ? VRM_INTENT_SPACE.pitchSign : 1;
    return {
        x: x * pitchSign,
        y: y * VRM_INTENT_SPACE.yawSign,
        z: z * VRM_INTENT_SPACE.rollSign,
    };
}

/**
 * this | INFO | resolveStandingRest | Arm-tab standing eulers; other bones rest at 0
 */
export function resolveStandingRest(armAnimator, boneName) {
    const match = /^(left|right)(Shoulder|UpperArm|LowerArm|Hand)$/.exec(String(boneName || ''));
    if (!match) return { x: 0, y: 0, z: 0 };
    const side = match[1];
    const joint = match[2].charAt(0).toLowerCase() + match[2].slice(1);
    const rest = armAnimator?.basePose?.[side]?.[joint];
    if (!rest) return { x: 0, y: 0, z: 0 };
    return {
        x: Number(rest.x) || 0,
        y: Number(rest.y) || 0,
        z: Number(rest.z) || 0,
    };
}

/**
 * this | INFO | vrmToIntentRotation | Read a live VRM euler back into catalog / editor intent space
 */
export function vrmToIntentRotation(boneName, vrmEuler = {}) {
    const pitchSign = usesFlippedPitch(boneName) ? VRM_INTENT_SPACE.pitchSign : 1;
    return {
        x: (Number(vrmEuler.x) || 0) / pitchSign,
        y: (Number(vrmEuler.y) || 0) / VRM_INTENT_SPACE.yawSign,
        z: (Number(vrmEuler.z) || 0) / VRM_INTENT_SPACE.rollSign,
    };
}

if (typeof window !== 'undefined') {
    window.VRM_INTENT_SPACE = VRM_INTENT_SPACE;
}

// Get constraints for a bone, handling finger naming patterns
function getConstraints(boneName) {
    if (BONE_CONSTRAINTS[boneName]) {
        return BONE_CONSTRAINTS[boneName];
    }
    // Handle finger bones
    if (boneName.includes('Proximal')) return BONE_CONSTRAINTS._fingerProximal;
    if (boneName.includes('Intermediate')) return BONE_CONSTRAINTS._fingerIntermediate;
    if (boneName.includes('Distal')) return BONE_CONSTRAINTS._fingerDistal;
    // Default fallback
    return { x: [-Math.PI, Math.PI], y: [-Math.PI, Math.PI], z: [-Math.PI, Math.PI] };
}

export class FullBodyAnimator {
    constructor(vrm) {
        this.vrm = vrm;
        this.bones = {};
        this.restPose = {};
        this.targetPoses = {};
        this.isAnimating = false;

        this.initializeBones();
    }

    /**
     * Initialize bone references from VRM humanoid
     */
    initializeBones() {
        if (!this.vrm?.humanoid?.humanBones) {
            console.warn('[FullBodyAnimator] No humanoid bones found in VRM');
            return;
        }

        const humanBones = this.vrm.humanoid.humanBones;

        // Initialize all bones from structure
        for (const region of Object.values(VRM_BONE_STRUCTURE)) {
            for (const boneName of region.bones) {
                const boneNode = humanBones[boneName]?.node;
                if (boneNode) {
                    this.bones[boneName] = boneNode;
                    this.restPose[boneName] = boneNode.quaternion.clone();
                    this.targetPoses[boneName] = boneNode.quaternion.clone();
                } else {
                    // console.warn(`[FullBodyAnimator] Missing bone: ${boneName}`);
                }
            }
        }

        console.log(`[FullBodyAnimator] Initialized ${Object.keys(this.bones).length} bones`);
    }

    /**
     * Get all available bones (that exist in the model)
     */
    getAvailableBones() {
        return Object.keys(this.bones);
    }

    /**
     * Get the bone structure with availability info
     */
    getBoneStructure() {
        const result = {};
        for (const [regionKey, region] of Object.entries(VRM_BONE_STRUCTURE)) {
            result[regionKey] = {
                label: region.label,
                bones: region.bones.map(boneName => ({
                    name: boneName,
                    label: BONE_LABELS[boneName] || boneName,
                    available: !!this.bones[boneName],
                    constraints: getConstraints(boneName)
                }))
            };
        }
        return result;
    }

    /**
     * Get current rotation of a bone
     */
    getBoneRotation(boneName) {
        const bone = this.bones[boneName];
        if (!bone) return { x: 0, y: 0, z: 0 };

        const euler = new THREE.Euler().setFromQuaternion(bone.quaternion);
        return { x: euler.x, y: euler.y, z: euler.z };
    }

    /**
     * Set rotation for a single bone with optional animation
     */
    setBoneRotation(boneName, rotation, duration = 0.3) {
        const bone = this.bones[boneName];
        if (!bone) {
            console.warn(`[FullBodyAnimator] Bone not found: ${boneName}`);
            return;
        }

        // Apply constraints
        const constraints = getConstraints(boneName);
        const constrained = {
            x: THREE.MathUtils.clamp(rotation.x || 0, constraints.x[0], constraints.x[1]),
            y: THREE.MathUtils.clamp(rotation.y || 0, constraints.y[0], constraints.y[1]),
            z: THREE.MathUtils.clamp(rotation.z || 0, constraints.z[0], constraints.z[1])
        };

        const euler = new THREE.Euler(constrained.x, constrained.y, constrained.z, 'XYZ');
        const targetQuat = new THREE.Quaternion().setFromEuler(euler);

        if (duration <= 0) {
            // Immediate application
            bone.quaternion.copy(targetQuat);
        } else {
            // Animated transition
            this.targetPoses[boneName] = targetQuat;
            this.animateBoneToTarget(boneName, duration);
        }
    }

    /**
     * Apply a full body pose (object mapping bone names to rotations)
     */
    applyPose(pose, duration = 0.5) {
        if (!pose || typeof pose !== 'object') return;

        for (const [boneName, rotation] of Object.entries(pose)) {
            if (this.bones[boneName] && rotation) {
                this.setBoneRotation(boneName, rotation, duration);
            }
        }
    }

    /**
     * Capture current pose as an object
     */
    capturePose() {
        const pose = {};
        for (const boneName of Object.keys(this.bones)) {
            pose[boneName] = this.getBoneRotation(boneName);
        }
        return pose;
    }

    /**
     * Reset all bones to rest pose
     */
    resetToRest(duration = 0.5) {
        for (const [boneName, restQuat] of Object.entries(this.restPose)) {
            const bone = this.bones[boneName];
            if (bone) {
                this.targetPoses[boneName] = restQuat.clone();
                this.animateBoneToTarget(boneName, duration);
            }
        }
    }

    /**
     * Animate a bone to its target rotation
     */
    animateBoneToTarget(boneName, duration) {
        const bone = this.bones[boneName];
        const targetQuat = this.targetPoses[boneName];

        if (!bone || !targetQuat) return;

        const startQuat = bone.quaternion.clone();
        const startTime = performance.now();
        const durationMs = duration * 1000;

        const animate = () => {
            const elapsed = performance.now() - startTime;
            const progress = Math.min(elapsed / durationMs, 1.0);

            // Ease-in-out cubic
            const eased = progress < 0.5
                ? 4 * progress * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 3) / 2;

            bone.quaternion.slerpQuaternions(startQuat, targetQuat, eased);

            if (progress < 1.0) {
                requestAnimationFrame(animate);
            }
        };

        requestAnimationFrame(animate);
    }
}

export default FullBodyAnimator;
