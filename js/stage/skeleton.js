// A mesh-free copy of the arm's kinematic chain, used for planning. Forward kinematics on the visual rig has to update
// every mesh in the scene graph; on this skeleton it touches ~15 nodes, so IK is an order of magnitude cheaper and can
// run live (place-anywhere) without hitching the page.
import * as THREE from 'three'
import { buildURDF } from './urdf.js'
import { JOINT_NAMES } from './robot.js'

export function makeSkeleton(urdfText, grasp, limits) {
  const robot = buildURDF(urdfText, () => {}) // no meshes
  const root = new THREE.Group()
  robot.rotation.x = -Math.PI / 2 // same Z-up -> Y-up wrapper as the visual rig
  root.add(robot)
  const joints = {}
  for (const n of JOINT_NAMES) joints[n] = robot.joints[n]
  const tcp = new THREE.Object3D()
  tcp.quaternion.copy(robot.joints.gripper_frame_joint.quaternion)
  tcp.position.set(...grasp.local)
  robot.links.gripper_link.add(tcp)
  root.updateMatrixWorld(true)
  return { root, robot, joints, tcp, limits, grasp }
}
