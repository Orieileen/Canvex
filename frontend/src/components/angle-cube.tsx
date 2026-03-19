import { useEffect, useRef, useCallback } from 'react'
import * as THREE from 'three'
import type { CameraAngles } from '@/utils/angle-prompt'
import { snapAngles, anglesToDisplayLabel } from '@/utils/angle-prompt'

// ── Constants ───────────────────────────────────────────────────────────

const CENTER = new THREE.Vector3(0, 0.75, 0)
const BASE_DISTANCE = 1.6
const AZIMUTH_RADIUS = 2.4
const ELEVATION_RADIUS = 1.8
const HANDLE_RADIUS = 0.12

const COLOR_AZIMUTH = 0x00ffaa
const COLOR_ELEVATION = 0xff69b4
const COLOR_DISTANCE = 0xffaa00
const COLOR_BG = 0x1a1a2e

const SNAP_DURATION = 200 // ms

// Pre-allocated objects reused every frame / pointer-move to avoid GC pressure
const _camPosVec = new THREE.Vector3()
const _hitPlaneH = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.05)
const _hitPlaneV = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0.8)
const _hitPoint = new THREE.Vector3()

// ── Helpers ─────────────────────────────────────────────────────────────

function degToRad(d: number) { return d * Math.PI / 180 }
function radToDeg(r: number) { return r * 180 / Math.PI }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }
function easeOutCubic(t: number) { return 1 - Math.pow(1 - t, 3) }
function normalizeAngle360(deg: number) { return ((deg % 360) + 360) % 360 }

function cameraPosition(azimuth: number, elevation: number, distance: number): THREE.Vector3 {
  const d = BASE_DISTANCE * distance
  const azRad = degToRad(azimuth)
  const elRad = degToRad(elevation)
  // Mirror azimuth in the viewport so dragging the handle to screen-left
  // increases the orbit offset relative to the current source view.
  return _camPosVec.set(
    -d * Math.sin(azRad) * Math.cos(elRad),
    d * Math.sin(elRad) + CENTER.y,
    d * Math.cos(azRad) * Math.cos(elRad),
  )
}

// ── Component ───────────────────────────────────────────────────────────

interface CameraOrbitControlProps {
  imageUrl: string | null
  angles: CameraAngles
  onAnglesChange: (angles: CameraAngles) => void
  width?: number
  height?: number
}

export function CameraOrbitControl({
  imageUrl,
  angles,
  onAnglesChange,
  width = 320,
  height = 280,
}: CameraOrbitControlProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef({
    renderer: null as THREE.WebGLRenderer | null,
    scene: null as THREE.Scene | null,
    camera: null as THREE.PerspectiveCamera | null,
    raycaster: new THREE.Raycaster(),
    mouse: new THREE.Vector2(),
    // Objects
    imagePlane: null as THREE.Mesh | null,
    cameraModel: null as THREE.Group | null,
    azimuthRing: null as THREE.Mesh | null,
    azimuthHandle: null as THREE.Mesh | null,
    elevationArc: null as THREE.Line | null,
    elevationHandle: null as THREE.Mesh | null,
    distanceLine: null as THREE.Line | null,
    distanceHandle: null as THREE.Mesh | null,
    // Prompt label
    promptLabel: null as HTMLDivElement | null,
    textureLoadId: 0,
    // Drag
    dragging: null as 'azimuth' | 'elevation' | 'distance' | null,
    dragStartY: 0,
    dragStartDist: 1,
    // Animation
    animFrame: 0,
    snapAnim: null as { start: number; from: CameraAngles; to: CameraAngles } | null,
    // Current continuous values (may differ from snapped props during drag)
    liveAzimuth: 0,
    liveElevation: 0,
    liveDistance: 1,
    mounted: false,
  })

  // Sync live values from props when not dragging
  useEffect(() => {
    const s = stateRef.current
    if (!s.dragging && !s.snapAnim) {
      s.liveAzimuth = angles.azimuth
      s.liveElevation = angles.elevation
      s.liveDistance = angles.distance
    }
  }, [angles])

  const onAnglesChangeRef = useRef(onAnglesChange)
  onAnglesChangeRef.current = onAnglesChange

  // ── Build scene ─────────────────────────────────────────────────────

  const initScene = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const s = stateRef.current

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(COLOR_BG)
    container.appendChild(renderer.domElement)
    s.renderer = renderer

    // Scene
    const scene = new THREE.Scene()
    s.scene = scene

    // Observer camera (fixed)
    const cam = new THREE.PerspectiveCamera(35, width / height, 0.1, 100)
    cam.position.set(4.5, 3, 4.5)
    cam.lookAt(CENTER)
    s.camera = cam

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
    dirLight.position.set(3, 5, 3)
    scene.add(dirLight)

    // Grid
    const grid = new THREE.GridHelper(6, 12, 0x333355, 0x222244)
    scene.add(grid)

    // ── Image plane ────────────────────────────────────────────────────
    const planeGeo = new THREE.PlaneGeometry(1.2, 1.2)
    const planeMat = new THREE.MeshBasicMaterial({ color: 0x666688, side: THREE.DoubleSide })
    const plane = new THREE.Mesh(planeGeo, planeMat)
    plane.position.copy(CENTER)
    scene.add(plane)
    s.imagePlane = plane

    // ── Camera model ───────────────────────────────────────────────────
    const camGroup = new THREE.Group()
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 0.18, 0.15),
      new THREE.MeshPhongMaterial({ color: 0x2a2a4a }),
    )
    camGroup.add(body)
    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.06, 0.12, 8),
      new THREE.MeshPhongMaterial({ color: 0x444466 }),
    )
    lens.rotation.x = Math.PI / 2
    lens.position.z = 0.12
    camGroup.add(lens)
    scene.add(camGroup)
    s.cameraModel = camGroup

    // ── Azimuth ring (green torus) ─────────────────────────────────────
    const torusGeo = new THREE.TorusGeometry(AZIMUTH_RADIUS, 0.025, 8, 64)
    const torusMat = new THREE.MeshBasicMaterial({ color: COLOR_AZIMUTH, transparent: true, opacity: 0.7 })
    const torus = new THREE.Mesh(torusGeo, torusMat)
    torus.rotation.x = Math.PI / 2
    torus.position.y = 0.05
    scene.add(torus)
    s.azimuthRing = torus

    // Azimuth handle
    const azHandle = new THREE.Mesh(
      new THREE.SphereGeometry(HANDLE_RADIUS, 16, 16),
      new THREE.MeshPhongMaterial({ color: COLOR_AZIMUTH, emissive: COLOR_AZIMUTH, emissiveIntensity: 0.3 }),
    )
    scene.add(azHandle)
    s.azimuthHandle = azHandle

    // ── Elevation arc (pink) ───────────────────────────────────────────
    const arcPoints: THREE.Vector3[] = []
    for (let deg = -30; deg <= 60; deg += 2) {
      const r = degToRad(deg)
      arcPoints.push(new THREE.Vector3(
        -0.8,
        ELEVATION_RADIUS * Math.sin(r) + CENTER.y,
        ELEVATION_RADIUS * Math.cos(r),
      ))
    }
    const arcCurve = new THREE.CatmullRomCurve3(arcPoints)
    const arcGeo = new THREE.BufferGeometry().setFromPoints(arcCurve.getPoints(60))
    const arcMat = new THREE.LineBasicMaterial({ color: COLOR_ELEVATION, linewidth: 2 })
    const arcLine = new THREE.Line(arcGeo, arcMat)
    scene.add(arcLine)
    s.elevationArc = arcLine

    // Elevation handle
    const elHandle = new THREE.Mesh(
      new THREE.SphereGeometry(HANDLE_RADIUS, 16, 16),
      new THREE.MeshPhongMaterial({ color: COLOR_ELEVATION, emissive: COLOR_ELEVATION, emissiveIntensity: 0.3 }),
    )
    scene.add(elHandle)
    s.elevationHandle = elHandle

    // ── Distance line + handle (orange) ────────────────────────────────
    const distGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), CENTER.clone()])
    const distMat = new THREE.LineBasicMaterial({ color: COLOR_DISTANCE })
    const distLine = new THREE.Line(distGeo, distMat)
    scene.add(distLine)
    s.distanceLine = distLine

    const dstHandle = new THREE.Mesh(
      new THREE.SphereGeometry(HANDLE_RADIUS * 0.9, 16, 16),
      new THREE.MeshPhongMaterial({ color: COLOR_DISTANCE, emissive: COLOR_DISTANCE, emissiveIntensity: 0.3 }),
    )
    scene.add(dstHandle)
    s.distanceHandle = dstHandle

    s.mounted = true
  }, [width, height])

  // ── Update positions ────────────────────────────────────────────────

  const updatePositions = useCallback(() => {
    const s = stateRef.current
    if (!s.mounted) return

    const az = s.liveAzimuth
    const el = s.liveElevation
    const dist = s.liveDistance

    // Camera model
    const camPos = cameraPosition(az, el, dist)
    if (s.cameraModel) {
      s.cameraModel.position.copy(camPos)
      s.cameraModel.lookAt(CENTER)
    }

    // Azimuth handle on ring
    if (s.azimuthHandle) {
      const azRad = degToRad(az)
      s.azimuthHandle.position.set(
        -AZIMUTH_RADIUS * Math.sin(azRad),
        0.05,
        AZIMUTH_RADIUS * Math.cos(azRad),
      )
    }

    // Elevation handle on arc
    if (s.elevationHandle) {
      const elRad = degToRad(el)
      s.elevationHandle.position.set(
        -0.8,
        ELEVATION_RADIUS * Math.sin(elRad) + CENTER.y,
        ELEVATION_RADIUS * Math.cos(elRad),
      )
    }

    // Distance line + handle
    if (s.distanceLine) {
      const positions = s.distanceLine.geometry.attributes.position as THREE.BufferAttribute
      positions.setXYZ(0, camPos.x, camPos.y, camPos.z)
      positions.setXYZ(1, CENTER.x, CENTER.y, CENTER.z)
      positions.needsUpdate = true
    }
    if (s.distanceHandle) {
      s.distanceHandle.position.lerpVectors(CENTER, camPos, 0.5)
    }

    // Angle label
    if (s.promptLabel) {
      s.promptLabel.textContent = anglesToDisplayLabel({ azimuth: az, elevation: el, distance: dist })
    }
  }, [])

  // ── Render loop ─────────────────────────────────────────────────────

  const renderLoop = useCallback(() => {
    const s = stateRef.current
    if (!s.mounted || !s.renderer || !s.scene || !s.camera) return

    // Snap animation
    if (s.snapAnim) {
      const elapsed = performance.now() - s.snapAnim.start
      const t = Math.min(elapsed / SNAP_DURATION, 1)
      const e = easeOutCubic(t)

      // Follow the shortest path around the ring, matching HF's seam behavior.
      let azimuthDiff = s.snapAnim.to.azimuth - s.snapAnim.from.azimuth
      if (azimuthDiff > 180) azimuthDiff -= 360
      if (azimuthDiff < -180) azimuthDiff += 360

      s.liveAzimuth = normalizeAngle360(s.snapAnim.from.azimuth + azimuthDiff * e)
      s.liveElevation = s.snapAnim.from.elevation + (s.snapAnim.to.elevation - s.snapAnim.from.elevation) * e
      s.liveDistance = s.snapAnim.from.distance + (s.snapAnim.to.distance - s.snapAnim.from.distance) * e
      if (t >= 1) {
        s.liveAzimuth = s.snapAnim.to.azimuth
        s.liveElevation = s.snapAnim.to.elevation
        s.liveDistance = s.snapAnim.to.distance
        s.snapAnim = null
        onAnglesChangeRef.current({
          azimuth: s.liveAzimuth,
          elevation: s.liveElevation,
          distance: s.liveDistance,
        })
      }
    }

    updatePositions()
    s.renderer.render(s.scene, s.camera)
    s.animFrame = requestAnimationFrame(renderLoop)
  }, [updatePositions])

  // ── Pointer events ──────────────────────────────────────────────────

  const getCanvasCoords = useCallback((e: PointerEvent) => {
    const s = stateRef.current
    if (!s.renderer) return
    const rect = s.renderer.domElement.getBoundingClientRect()
    s.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    s.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  }, [])

  const onPointerDown = useCallback((e: PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const s = stateRef.current
    if (!s.renderer || !s.camera) return
    getCanvasCoords(e)
    s.raycaster.setFromCamera(s.mouse, s.camera)

    // Test handles (prioritise larger hit areas)
    const handles: { obj: THREE.Mesh; name: 'azimuth' | 'elevation' | 'distance' }[] = []
    if (s.azimuthHandle) handles.push({ obj: s.azimuthHandle, name: 'azimuth' })
    if (s.elevationHandle) handles.push({ obj: s.elevationHandle, name: 'elevation' })
    if (s.distanceHandle) handles.push({ obj: s.distanceHandle, name: 'distance' })

    for (const h of handles) {
      const hits = s.raycaster.intersectObject(h.obj)
      if (hits.length) {
        s.dragging = h.name
        s.dragStartY = e.clientY
        s.dragStartDist = s.liveDistance
        s.snapAnim = null
        ;(s.renderer.domElement as HTMLElement).setPointerCapture(e.pointerId)
        return
      }
    }
  }, [getCanvasCoords])

  const onPointerMove = useCallback((e: PointerEvent) => {
    const s = stateRef.current
    if (!s.dragging || !s.renderer || !s.camera) return
    getCanvasCoords(e)
    s.raycaster.setFromCamera(s.mouse, s.camera)

    if (s.dragging === 'azimuth') {
      // Intersect horizontal plane at y=0.05
      s.raycaster.ray.intersectPlane(_hitPlaneH, _hitPoint)
      if (_hitPoint) {
        s.liveAzimuth = ((radToDeg(Math.atan2(-_hitPoint.x, _hitPoint.z)) % 360) + 360) % 360
      }
    } else if (s.dragging === 'elevation') {
      // Intersect vertical plane at x=-0.8
      s.raycaster.ray.intersectPlane(_hitPlaneV, _hitPoint)
      if (_hitPoint) {
        const relY = _hitPoint.y - CENTER.y
        const relZ = _hitPoint.z
        s.liveElevation = clamp(radToDeg(Math.atan2(relY, relZ)), -30, 60)
      }
    } else if (s.dragging === 'distance') {
      const deltaY = (e.clientY - s.dragStartY) / 100
      s.liveDistance = clamp(s.dragStartDist + deltaY * 1.5, 0.6, 1.4)
    }
  }, [getCanvasCoords])

  const onPointerUp = useCallback((e: PointerEvent) => {
    const s = stateRef.current
    if (!s.dragging) return
    s.dragging = null
    if (s.renderer) {
      ;(s.renderer.domElement as HTMLElement).releasePointerCapture(e.pointerId)
    }
    // Snap to nearest discrete step
    const from: CameraAngles = {
      azimuth: s.liveAzimuth,
      elevation: s.liveElevation,
      distance: s.liveDistance,
    }
    const to = snapAngles(from)
    s.snapAnim = { start: performance.now(), from, to }
  }, [])

  const loadImageTexture = useCallback((nextImageUrl: string | null) => {
    const s = stateRef.current
    if (!s.imagePlane) return

    const textureLoadId = ++s.textureLoadId
    const mat = s.imagePlane.material as THREE.MeshBasicMaterial

    if (!nextImageUrl) {
      const previousTexture = mat.map
      mat.map = null
      mat.color.set(0x666688)
      mat.needsUpdate = true
      previousTexture?.dispose()
      return
    }

    const loader = new THREE.TextureLoader()
    loader.load(nextImageUrl, (tex) => {
      if (textureLoadId !== stateRef.current.textureLoadId || !s.imagePlane) {
        tex.dispose()
        return
      }
      const previousTexture = mat.map
      mat.map = tex
      mat.color.set(0xffffff)
      mat.needsUpdate = true
      if (previousTexture !== tex) {
        previousTexture?.dispose()
      }
      // Adjust aspect ratio
      const img = tex.image as HTMLImageElement
      if (img && img.width && img.height) {
        const aspect = img.width / img.height
        const maxSize = 1.5
        let w: number, h: number
        if (aspect >= 1) {
          w = maxSize
          h = maxSize / aspect
        } else {
          h = maxSize
          w = maxSize * aspect
        }
        s.imagePlane.scale.set(w / 1.2, h / 1.2, 1)
      }
    })
  }, [])

  // ── Image texture ───────────────────────────────────────────────────

  useEffect(() => {
    loadImageTexture(imageUrl)
  }, [imageUrl, loadImageTexture])

  // ── Lifecycle ───────────────────────────────────────────────────────

  useEffect(() => {
    initScene()
    const s = stateRef.current
    s.liveAzimuth = angles.azimuth
    s.liveElevation = angles.elevation
    s.liveDistance = angles.distance
    updatePositions()
    // The [imageUrl] effect declared above runs *before* this one on mount
    // (React fires effects in declaration order), so imagePlane was still null
    // when it ran. We must kick the initial load here, after the scene exists.
    loadImageTexture(imageUrl)

    // Event listeners
    const canvas = s.renderer?.domElement
    if (canvas) {
      canvas.addEventListener('pointerdown', onPointerDown)
      canvas.addEventListener('pointermove', onPointerMove)
      canvas.addEventListener('pointerup', onPointerUp)
      canvas.addEventListener('pointercancel', onPointerUp)
      canvas.style.borderRadius = '8px'
      canvas.style.cursor = 'grab'
    }

    // Start render loop
    s.animFrame = requestAnimationFrame(renderLoop)

    return () => {
      s.mounted = false
      cancelAnimationFrame(s.animFrame)
      if (canvas) {
        canvas.removeEventListener('pointerdown', onPointerDown)
        canvas.removeEventListener('pointermove', onPointerMove)
        canvas.removeEventListener('pointerup', onPointerUp)
        canvas.removeEventListener('pointercancel', onPointerUp)
      }
      // Invalidate any in-flight texture loads so late callbacks become no-ops
      ++s.textureLoadId
      s.imagePlane = null
      // Dispose all GPU resources (geometries, materials, textures)
      if (s.scene) {
        s.scene.traverse((obj) => {
          if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
            obj.geometry?.dispose()
            const mat = obj.material
            if (Array.isArray(mat)) {
              mat.forEach((m) => { m.map?.dispose(); m.dispose() })
            } else if (mat) {
              ;(mat as THREE.MeshBasicMaterial).map?.dispose()
              mat.dispose()
            }
          }
        })
      }
      s.renderer?.dispose()
      s.renderer?.domElement.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      style={{ position: 'relative', width, height }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div ref={containerRef} style={{ width, height }} />
      {/* Angle label overlay */}
      <div
        ref={(el) => { stateRef.current.promptLabel = el }}
        style={{
          position: 'absolute',
          bottom: 8,
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.7)',
          color: '#00ffaa',
          fontFamily: 'monospace',
          fontSize: 11,
          padding: '3px 10px',
          borderRadius: 4,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
        }}
      >
        {anglesToDisplayLabel(angles)}
      </div>
      {/* Legend */}
      <div
        style={{
          position: 'absolute',
          top: 6,
          left: 8,
          display: 'flex',
          gap: 8,
          fontSize: 10,
          color: '#aaa',
          pointerEvents: 'none',
        }}
      >
        <span><span style={{ color: '#00ffaa' }}>●</span> Azimuth</span>
        <span><span style={{ color: '#ff69b4' }}>●</span> Elevation</span>
        <span><span style={{ color: '#ffaa00' }}>●</span> Distance</span>
      </div>
    </div>
  )
}
