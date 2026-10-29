// The arm's meshes in one compact gzipped file (assets/so101/meshes.bin.gz), so the page fetches ~1/3 of the STL bytes and skips
// the crease-normal pass at load. Baked by tools/meshes.html from the same STLs with the same pipeline robot.js used to run
// (creased normals at 32 deg), then indexed and quantized: positions uint16 inside the mesh's box (~1 um on these parts),
// normals int16. The browser inflates it (DecompressionStream) because GitHub Pages
// only compresses text types. Missing entries fall back to the STL in robot.js, so a re-exported STL still loads, just slower.
//
// Layout after gunzip (little-endian): 'TVM1', u32 count, then per mesh:
//   u16 nameLen, name (utf-8), u32 vertexCount, u32 indexCount, f32[3] min, f32[3] max,
//   u16[3 * vertexCount] position, i16[3 * vertexCount] normal, (u16 | u32 if vertexCount > 65535)[indexCount] index,
//   padded to 4 bytes.
import * as THREE from 'three'

const MAGIC = 0x314d5654 // 'TVM1'
const pad4 = (n) => (n + 3) & ~3

/** @param {Map<string, THREE.BufferGeometry>} geos indexed geometries with position + normal */
export function encodeMeshPack(geos) {
  const enc = new TextEncoder()
  const parts = []
  let size = 8
  for (const [name, g] of geos) {
    const nameBytes = enc.encode(name)
    const pos = g.attributes.position, nor = g.attributes.normal, idx = g.index
    const wide = pos.count > 65535
    const body = pad4(2 + nameBytes.length + 8 + 24 + pos.count * 12 + idx.count * (wide ? 4 : 2))
    parts.push({ nameBytes, pos, nor, idx, wide, body })
    size += body
  }
  const buf = new ArrayBuffer(size)
  const dv = new DataView(buf)
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, parts.length, true)
  let o = 8
  for (const { nameBytes, pos, nor, idx, wide, body } of parts) {
    const start = o
    dv.setUint16(o, nameBytes.length, true); o += 2
    new Uint8Array(buf, o, nameBytes.length).set(nameBytes); o += nameBytes.length
    dv.setUint32(o, pos.count, true); dv.setUint32(o + 4, idx.count, true); o += 8
    const box = new THREE.Box3().setFromBufferAttribute(pos)
    const lo = box.min.toArray(), hi = box.max.toArray()
    for (const v of [...lo, ...hi]) { dv.setFloat32(o, v, true); o += 4 }
    for (let i = 0; i < pos.count; i++) for (let k = 0; k < 3; k++) {
      const span = hi[k] - lo[k] || 1
      dv.setUint16(o, Math.round(((pos.getComponent(i, k) - lo[k]) / span) * 65535), true); o += 2
    }
    for (let i = 0; i < nor.count; i++) for (let k = 0; k < 3; k++) {
      dv.setInt16(o, Math.round(Math.max(-1, Math.min(1, nor.getComponent(i, k))) * 32767), true); o += 2
    }
    for (let i = 0; i < idx.count; i++) { wide ? dv.setUint32(o, idx.getX(i), true) : dv.setUint16(o, idx.getX(i), true); o += wide ? 4 : 2 }
    o = start + body
  }
  return buf
}

/** @returns {Promise<Map<string, THREE.BufferGeometry>>} URDF filename (e.g. 'assets/base_so101_v2.stl') -> geometry */
export async function decodeMeshPack(gz) {
  const buf = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
  const dv = new DataView(buf)
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('meshes.bin: not a mesh pack')
  const dec = new TextDecoder()
  const out = new Map()
  let o = 8
  for (let m = dv.getUint32(4, true); m > 0; m--) {
    const start = o
    const nameLen = dv.getUint16(o, true); o += 2
    const name = dec.decode(new Uint8Array(buf, o, nameLen)); o += nameLen
    const vc = dv.getUint32(o, true), ic = dv.getUint32(o + 4, true); o += 8
    const lo = [], span = []
    for (let k = 0; k < 3; k++) lo.push(dv.getFloat32(o + k * 4, true))
    for (let k = 0; k < 3; k++) span.push((dv.getFloat32(o + 12 + k * 4, true) - lo[k]) / 65535)
    o += 24
    const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3)
    for (let i = 0; i < vc * 3; i++, o += 2) pos[i] = lo[i % 3] + dv.getUint16(o, true) * span[i % 3]
    for (let i = 0; i < vc * 3; i++, o += 2) nor[i] = dv.getInt16(o, true) / 32767
    const wide = vc > 65535
    const index = wide ? new Uint32Array(ic) : new Uint16Array(ic)
    for (let i = 0; i < ic; i++, o += wide ? 4 : 2) index[i] = wide ? dv.getUint32(o, true) : dv.getUint16(o, true)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
    g.setIndex(new THREE.BufferAttribute(index, 1))
    out.set(name, g)
    o = start + pad4(o - start)
  }
  return out
}
