// Loads the SO-101 URDF, applies studio materials + smooth normals, and indexes joints/servos.
import * as THREE from 'three'
import { buildURDF } from './urdf.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { NOODLE } from './layout.js'
import { computeGrasp } from './grasp.js'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'

export const JOINT_NAMES = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper']
export const JOINT_LABELS = ['Shoulder pan', 'Shoulder lift', 'Elbow flex', 'Wrist flex', 'Wrist roll', 'Gripper']
// Link that carries each joint's servo (the STS3215 sitting in that link drives the named joint).
const SERVO_LINK_TO_JOINT = {
  base_link: 'shoulder_pan',
  shoulder_link: 'shoulder_lift',
  upper_arm_link: 'elbow_flex',
  lower_arm_link: 'wrist_flex',
  wrist_link: 'wrist_roll',
  gripper_link: 'gripper',
}
const URDF_URL = new URL('../../assets/so101/so101_new_calib.urdf', import.meta.url).href

function makeMaterials() {
  const ivory = new THREE.MeshPhysicalMaterial({
    color: 0xd9cdb0, roughness: 0.45, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.5,
  })
  const servo = new THREE.MeshPhysicalMaterial({
    color: 0x1b1d1f, roughness: 0.38, metalness: 0.05, clearcoat: 0.35, clearcoatRoughness: 0.4,
    emissive: new THREE.Color(0x000000),
  })
  return { ivory, servo }
}

async function fetchWithProgress(url, onBytes) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  if (!res.body) return { buf: await res.arrayBuffer(), total }
  const reader = res.body.getReader()
  const chunks = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    onBytes(got, total)
  }
  const out = new Uint8Array(got)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return { buf: out.buffer, total: total || got }
}

/** @returns {Promise<{root:THREE.Group, robot:any, joints:Record<string,any>, tcp:THREE.Object3D, ...}>} */
export async function loadRobot(onProgress = () => {}) {
  const mats = makeMaterials()
  const stl = new STLLoader()
  const geoCache = new Map()
  const pending = []
  const bytes = new Map() // url -> [loaded,total]
  const report = () => {
    let l = 0, t = 0
    for (const [a, b] of bytes.values()) { l += a; t += b || a * 1.3 + 1 }
    onProgress(t ? Math.min(1, l / t) : 0)
  }

  const urdfText = await (await fetch(URDF_URL)).text()
  loadRobot.lastUrdf = urdfText
  const base = URDF_URL.slice(0, URDF_URL.lastIndexOf('/') + 1)
  const robot = buildURDF(urdfText, (file, done) => {
    const path = base + file
    let p = geoCache.get(path)
    if (!p) {
      bytes.set(path, [0, 0])
      p = fetchWithProgress(path, (g, t) => { bytes.set(path, [g, t]); report() }).then(({ buf }) => {
        const raw = stl.parse(buf)
        raw.deleteAttribute('normal')
        const geo = toCreasedNormals(raw, THREE.MathUtils.degToRad(32))
        geo.computeBoundingBox()
        return geo
      })
      geoCache.set(path, p)
    }
    pending.push(p.then((geo) => {
      const mesh = new THREE.Mesh(geo, mats.ivory)
      mesh.userData.file = file.split('/').pop()
      done(mesh)
    }))
  })
  await Promise.all(pending)
  onProgress(1)

  // Y-up world: URDF is Z-up. Wrapping group carries the rotation.
  const root = new THREE.Group()
  root.name = 'so101'
  robot.rotation.x = -Math.PI / 2
  root.add(robot)

  // Materials per mesh + shadow flags; per-joint servo materials (for heat glow).
  const servoMeshes = Object.fromEntries(JOINT_NAMES.map((j) => [j, []]))
  const servoMats = {}
  for (const j of JOINT_NAMES) {
    const m = mats.servo.clone()
    // heat glows along silhouettes (fresnel) instead of a flat wash, so the servo keeps its shape
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float heatFr = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 2.0);
        totalEmissiveRadiance *= (0.2 + 2.0 * heatFr);`)
    }
    servoMats[j] = m
  }
  const visualsByLink = {}
  robot.traverse((o) => {
    if (o.isURDFLink) {
      visualsByLink[o.name] = []
    }
  })
  robot.traverse((o) => {
    if (!o.isMesh) return
    o.castShadow = true
    o.receiveShadow = true
    let link = o.parent
    while (link && !link.isURDFLink) link = link.parent
    if (o.userData.file.startsWith('sts3215')) {
      const j = SERVO_LINK_TO_JOINT[link.name]
      o.material = servoMats[j]
      o.userData.joint = j
      servoMeshes[j].push(o)
      o.userData.servo = true
    } else {
      o.material = mats.ivory
    }
    if (link) visualsByLink[link.name].push(o.parent) // URDFVisual group
  })

  const joints = {}
  for (const n of JOINT_NAMES) joints[n] = robot.joints[n]
  const tcpFrame = robot.links.gripper_frame_link
  // The point BETWEEN the jaws (see grasp.js) becomes the TCP for planning, attachment, trail and framing.
  const limits = Object.fromEntries(JOINT_NAMES.map((n) => [n, [joints[n].limit.lower, joints[n].limit.upper]]))
  const grasp = computeGrasp({ robot, joints, limits }, NOODLE.r)
  const tcp = new THREE.Object3D()
  tcp.name = 'grasp_point'
  tcp.quaternion.copy(robot.joints.gripper_frame_joint.quaternion) // same axes as gripper_frame_link: +z approach, -x toward the moving jaw
  tcp.position.set(...grasp.local)
  robot.links.gripper_link.add(tcp)

  return { root, robot, joints, tcp, tcpFrame, grasp, limits, servoMeshes, servoMats, mats, visualsByLink }
}

export function setQ(rig, q) {
  for (let i = 0; i < JOINT_NAMES.length; i++) rig.joints[JOINT_NAMES[i]].setJointValue(q[i])
}

export function getQ(rig) {
  return JOINT_NAMES.map((n) => rig.joints[n].angle)
}

export function disposeRig(rig) {
  const seen = new Set()
  rig.root.traverse((o) => {
    if (o.isMesh && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose() }
  })
  Object.values(rig.servoMats).forEach((m) => m.dispose())
  rig.mats.ivory.dispose(); rig.mats.servo.dispose()
}
