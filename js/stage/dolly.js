// In-chapter camera moves, layered on top of the chapter shot: scrub-driven dollies and the sandbox lean.
import * as THREE from 'three'
import { cellCenter } from './layout.js'

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const B2 = cellCenter('B2')

export function createDollies(camRig) {
  const st = { scale: 1, fov: 0, look: 0, lean: 0 }
  const tcp = new THREE.Vector3()
  return {
    get lean() { return st.lean },
    /** @param running whether the arm is mid-task in the sandbox; tcpObj the gripper frame */
    update(dt, { chapter, progress, running, tcpObj, reduced }) {
      const k = reduced ? 1 : 1 - Math.exp(-dt * 8)
      let scale = 1, fov = 0, look = 0
      if (chapter === 'arm') scale = 1 - 0.08 * smooth(0, 1, progress.arm ?? 0) // slow push-in across the pin
      if (chapter === 'data') { // the closing beat: tighten onto the empty middle
        const s = smooth(0.75, 1, progress.data ?? 0)
        fov = -5 * s * (camRig.aspect < 1 ? 0.4 : 1); look = s * (camRig.aspect < 1 ? 0.5 : 1)
      }
      st.scale += (scale - st.scale) * k
      st.fov += (fov - st.fov) * k
      st.look += (look - st.look) * k
      st.lean += (((chapter === 'sandbox' && running) ? 1 : 0) - st.lean) * (reduced ? 1 : 1 - Math.exp(-dt * 3))
      tcp.setFromMatrixPosition(tcpObj.matrixWorld)
      const m = camRig.mods
      m.scale = st.scale
      m.fov = st.fov - 3 * st.lean
      if (st.look > 0.001) { m.lookTo.copy(B2); m.lookK = st.look } // data: centre B2
      else if (st.lean > 0.001) { m.lookTo.copy(tcp); m.lookK = 0.3 * st.lean } // sandbox: lean toward the gripper
      else m.lookK = 0
    },
    leanTarget(out, base) { return out.copy(base).lerp(tcp, 0.3 * st.lean) },
  }
}
