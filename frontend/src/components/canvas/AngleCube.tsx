import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";

import {
  anglesToDisplayLabel,
  normalizeAzimuth,
  snapAngles,
  type CameraAngles,
} from "@/lib/angle";

/**
 * 3D camera-orbit control: a WebGL viewport showing the source image floating
 * in 3D with three draggable handles — azimuth ring (ember) for horizontal
 * rotation, elevation arc (sky) for tilt, distance line (amber) for zoom.
 * Dropping a handle snaps to the nearest discrete step and fires
 * `onAnglesChange` with the snapped pose.
 *
 * **Render cadence**: RAF loop only runs while `dragging || snapAnim` is
 * truthy; otherwise a single `renderOnce()` is issued on prop / texture
 * change. A static cube sitting in a tab doesn't burn 60fps CPU+GPU.
 */

// ── Geometry constants ─────────────────────────────────────────────────

const CENTER = new THREE.Vector3(0, 0.75, 0);
const BASE_DISTANCE = 1.6;
const AZIMUTH_RADIUS = 2.4;
const ELEVATION_RADIUS = 1.8;
const HANDLE_RADIUS = 0.12;

const COLOR_AZIMUTH = 0xf97316;   // orange-500
const COLOR_ELEVATION = 0x38bdf8; // sky-400
const COLOR_DISTANCE = 0xfbbf24;  // amber-400
const COLOR_BG = 0x0f172a;        // slate-900
const COLOR_GRID_MAIN = 0x334155; // slate-700
const COLOR_GRID_SUB = 0x1e293b;  // slate-800

const SNAP_DURATION = 200; // ms

// Module-level scratch Vector3/Plane objects — safe *only* because this
// component is mounted in a single tab slot at a time (two concurrent cubes
// would corrupt each other's math). Keeps GC quiet during drag + snap
// animation, which is where fresh allocations would hurt.
const _camPosVec = new THREE.Vector3();
const _hitPlaneH = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.05);
const _hitPlaneV = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0.8);
const _hitPoint = new THREE.Vector3();

// ── Helpers ────────────────────────────────────────────────────────────

function degToRad(d: number) { return (d * Math.PI) / 180; }
function radToDeg(r: number) { return (r * 180) / Math.PI; }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function easeOutCubic(t: number) { return 1 - Math.pow(1 - t, 3); }

function cameraPosition(
  azimuth: number,
  elevation: number,
  distance: number,
): THREE.Vector3 {
  const d = BASE_DISTANCE * distance;
  const azRad = degToRad(azimuth);
  const elRad = degToRad(elevation);
  // Convention: azimuth=0 → camera on +Z (front), azimuth=90 → camera on +X
  // (object's right side). Matches fal.ai LoRA: horizontal_angle=90°=right
  // side. Dragging the handle clockwise around the ring (screen-right at
  // az=0) moves the camera to the object's right → user sees right side.
  return _camPosVec.set(
    d * Math.sin(azRad) * Math.cos(elRad),
    d * Math.sin(elRad) + CENTER.y,
    d * Math.cos(azRad) * Math.cos(elRad),
  );
}

// ── Component ──────────────────────────────────────────────────────────

interface AngleCubeProps {
  imageUrl: string | null;
  angles: CameraAngles;
  onAnglesChange: (angles: CameraAngles) => void;
  width?: number;
  height?: number;
}

type DragAxis = "azimuth" | "elevation" | "distance";

export function AngleCube({
  imageUrl,
  angles,
  onAnglesChange,
  width = 320,
  height = 240,
}: AngleCubeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
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
    // Label overlay
    promptLabel: null as HTMLDivElement | null,
    textureLoadId: 0,
    // Drag
    dragging: null as DragAxis | null,
    dragStartY: 0,
    dragStartDist: 1,
    // Animation
    animFrame: 0,
    snapAnim: null as { start: number; from: CameraAngles; to: CameraAngles } | null,
    // Live continuous values (may differ from snapped prop during drag)
    liveAzimuth: 0,
    liveElevation: 0,
    liveDistance: 1,
    mounted: false,
  });

  // Stable ref to the latest callback so the render/drag loops can fire it
  // without listing onAnglesChange in their own dep arrays.
  const onAnglesChangeRef = useRef(onAnglesChange);
  onAnglesChangeRef.current = onAnglesChange;

  // ── Build scene ─────────────────────────────────────────────────────

  const initScene = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const s = stateRef.current;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(COLOR_BG);
    container.appendChild(renderer.domElement);
    s.renderer = renderer;

    const scene = new THREE.Scene();
    s.scene = scene;

    const cam = new THREE.PerspectiveCamera(35, width / height, 0.1, 100);
    cam.position.set(4.5, 3, 4.5);
    cam.lookAt(CENTER);
    s.camera = cam;

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(3, 5, 3);
    scene.add(dirLight);

    const grid = new THREE.GridHelper(6, 12, COLOR_GRID_MAIN, COLOR_GRID_SUB);
    scene.add(grid);

    // ── Image plane (textured with source image, or muted solid if absent) ──
    const planeGeo = new THREE.PlaneGeometry(1.2, 1.2);
    const planeMat = new THREE.MeshBasicMaterial({
      color: 0x475569, // slate-600 placeholder tint
      side: THREE.DoubleSide,
    });
    const plane = new THREE.Mesh(planeGeo, planeMat);
    plane.position.copy(CENTER);
    scene.add(plane);
    s.imagePlane = plane;

    // ── Camera icon that orbits around CENTER ──
    const camGroup = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 0.18, 0.15),
      new THREE.MeshPhongMaterial({ color: 0x334155 }),
    );
    camGroup.add(body);
    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.06, 0.12, 8),
      new THREE.MeshPhongMaterial({ color: 0x64748b }),
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.z = 0.12;
    camGroup.add(lens);
    scene.add(camGroup);
    s.cameraModel = camGroup;

    // ── Azimuth ring (orange torus) ──
    const torusGeo = new THREE.TorusGeometry(AZIMUTH_RADIUS, 0.025, 8, 64);
    const torusMat = new THREE.MeshBasicMaterial({
      color: COLOR_AZIMUTH, transparent: true, opacity: 0.7,
    });
    const torus = new THREE.Mesh(torusGeo, torusMat);
    torus.rotation.x = Math.PI / 2;
    torus.position.y = 0.05;
    scene.add(torus);
    s.azimuthRing = torus;

    const azHandle = new THREE.Mesh(
      new THREE.SphereGeometry(HANDLE_RADIUS, 16, 16),
      new THREE.MeshPhongMaterial({
        color: COLOR_AZIMUTH, emissive: COLOR_AZIMUTH, emissiveIntensity: 0.3,
      }),
    );
    scene.add(azHandle);
    s.azimuthHandle = azHandle;

    // ── Elevation arc (sky-blue curve) ──
    const arcPoints: THREE.Vector3[] = [];
    for (let deg = -30; deg <= 60; deg += 2) {
      const r = degToRad(deg);
      arcPoints.push(new THREE.Vector3(
        -0.8,
        ELEVATION_RADIUS * Math.sin(r) + CENTER.y,
        ELEVATION_RADIUS * Math.cos(r),
      ));
    }
    const arcCurve = new THREE.CatmullRomCurve3(arcPoints);
    const arcGeo = new THREE.BufferGeometry().setFromPoints(arcCurve.getPoints(60));
    const arcMat = new THREE.LineBasicMaterial({ color: COLOR_ELEVATION, linewidth: 2 });
    const arcLine = new THREE.Line(arcGeo, arcMat);
    scene.add(arcLine);
    s.elevationArc = arcLine;

    const elHandle = new THREE.Mesh(
      new THREE.SphereGeometry(HANDLE_RADIUS, 16, 16),
      new THREE.MeshPhongMaterial({
        color: COLOR_ELEVATION, emissive: COLOR_ELEVATION, emissiveIntensity: 0.3,
      }),
    );
    scene.add(elHandle);
    s.elevationHandle = elHandle;

    // ── Distance line + handle (amber) ──
    const distGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(), CENTER.clone(),
    ]);
    const distMat = new THREE.LineBasicMaterial({ color: COLOR_DISTANCE });
    const distLine = new THREE.Line(distGeo, distMat);
    scene.add(distLine);
    s.distanceLine = distLine;

    const dstHandle = new THREE.Mesh(
      new THREE.SphereGeometry(HANDLE_RADIUS * 0.9, 16, 16),
      new THREE.MeshPhongMaterial({
        color: COLOR_DISTANCE, emissive: COLOR_DISTANCE, emissiveIntensity: 0.3,
      }),
    );
    scene.add(dstHandle);
    s.distanceHandle = dstHandle;

    s.mounted = true;
  }, [width, height]);

  // ── Per-frame position update ───────────────────────────────────────

  const updatePositions = useCallback(() => {
    const s = stateRef.current;
    if (!s.mounted) return;

    const az = s.liveAzimuth;
    const el = s.liveElevation;
    const dist = s.liveDistance;

    const camPos = cameraPosition(az, el, dist);
    if (s.cameraModel) {
      s.cameraModel.position.copy(camPos);
      s.cameraModel.lookAt(CENTER);
    }

    if (s.azimuthHandle) {
      const azRad = degToRad(az);
      s.azimuthHandle.position.set(
        AZIMUTH_RADIUS * Math.sin(azRad),
        0.05,
        AZIMUTH_RADIUS * Math.cos(azRad),
      );
    }

    if (s.elevationHandle) {
      const elRad = degToRad(el);
      s.elevationHandle.position.set(
        -0.8,
        ELEVATION_RADIUS * Math.sin(elRad) + CENTER.y,
        ELEVATION_RADIUS * Math.cos(elRad),
      );
    }

    if (s.distanceLine) {
      const positions = s.distanceLine.geometry.attributes.position as THREE.BufferAttribute;
      positions.setXYZ(0, camPos.x, camPos.y, camPos.z);
      positions.setXYZ(1, CENTER.x, CENTER.y, CENTER.z);
      positions.needsUpdate = true;
    }
    if (s.distanceHandle) {
      s.distanceHandle.position.lerpVectors(CENTER, camPos, 0.5);
    }

    if (s.promptLabel) {
      s.promptLabel.textContent = anglesToDisplayLabel({
        azimuth: az, elevation: el, distance: dist,
      });
    }
  }, []);

  // ── Render cadence ─────────────────────────────────────────────────
  //
  // `renderOnce` pushes one frame without touching RAF — used for any
  // event-driven redraw (prop change, texture swap, pointer move). `tickLoop`
  // is only scheduled while the scene is in motion (drag or snap animation)
  // and auto-terminates when both are idle.

  const renderOnce = useCallback(() => {
    const s = stateRef.current;
    if (!s.mounted || !s.renderer || !s.scene || !s.camera) return;
    updatePositions();
    s.renderer.render(s.scene, s.camera);
  }, [updatePositions]);

  const tickLoop = useCallback(() => {
    const s = stateRef.current;
    if (!s.mounted) return;

    if (s.snapAnim) {
      const elapsed = performance.now() - s.snapAnim.start;
      const t = Math.min(elapsed / SNAP_DURATION, 1);
      const e = easeOutCubic(t);

      // Follow the shortest path around the azimuth ring (crossing the seam
      // should not spin the long way); HF's angle controls do the same.
      let azimuthDiff = s.snapAnim.to.azimuth - s.snapAnim.from.azimuth;
      if (azimuthDiff > 180) azimuthDiff -= 360;
      if (azimuthDiff < -180) azimuthDiff += 360;

      s.liveAzimuth = normalizeAzimuth(s.snapAnim.from.azimuth + azimuthDiff * e);
      s.liveElevation = s.snapAnim.from.elevation +
        (s.snapAnim.to.elevation - s.snapAnim.from.elevation) * e;
      s.liveDistance = s.snapAnim.from.distance +
        (s.snapAnim.to.distance - s.snapAnim.from.distance) * e;
      if (t >= 1) {
        s.liveAzimuth = s.snapAnim.to.azimuth;
        s.liveElevation = s.snapAnim.to.elevation;
        s.liveDistance = s.snapAnim.to.distance;
        s.snapAnim = null;
        onAnglesChangeRef.current({
          azimuth: s.liveAzimuth,
          elevation: s.liveElevation,
          distance: s.liveDistance,
        });
      }
    }

    renderOnce();

    if (s.dragging || s.snapAnim) {
      s.animFrame = requestAnimationFrame(tickLoop);
    } else {
      s.animFrame = 0;
    }
  }, [renderOnce]);

  const ensureLoopRunning = useCallback(() => {
    const s = stateRef.current;
    if (s.animFrame === 0 && (s.dragging || s.snapAnim)) {
      s.animFrame = requestAnimationFrame(tickLoop);
    }
  }, [tickLoop]);

  // Prop → live sync. Drag wins while in progress (external setAngles during
  // drag is discarded by design — user's gesture is modal); otherwise mirror
  // prop into live and repaint once. The guard is the modal-drag invariant,
  // NOT a bug — the eventual snap fires onAnglesChange which round-trips the
  // final pose back to the parent, so no external change can actually drift.
  useEffect(() => {
    const s = stateRef.current;
    if (s.dragging || s.snapAnim) return;
    s.liveAzimuth = angles.azimuth;
    s.liveElevation = angles.elevation;
    s.liveDistance = angles.distance;
    renderOnce();
  }, [angles, renderOnce]);

  // ── Pointer events ──────────────────────────────────────────────────

  const getCanvasCoords = useCallback((e: PointerEvent) => {
    const s = stateRef.current;
    if (!s.renderer) return;
    const rect = s.renderer.domElement.getBoundingClientRect();
    s.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    s.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }, []);

  const onPointerDown = useCallback((e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const s = stateRef.current;
    if (!s.renderer || !s.camera) return;
    getCanvasCoords(e);
    s.raycaster.setFromCamera(s.mouse, s.camera);

    const handles: { obj: THREE.Mesh; name: DragAxis }[] = [];
    if (s.azimuthHandle) handles.push({ obj: s.azimuthHandle, name: "azimuth" });
    if (s.elevationHandle) handles.push({ obj: s.elevationHandle, name: "elevation" });
    if (s.distanceHandle) handles.push({ obj: s.distanceHandle, name: "distance" });

    for (const h of handles) {
      const hits = s.raycaster.intersectObject(h.obj);
      if (hits.length) {
        s.dragging = h.name;
        s.dragStartY = e.clientY;
        s.dragStartDist = s.liveDistance;
        s.snapAnim = null;
        (s.renderer.domElement as HTMLElement).setPointerCapture(e.pointerId);
        ensureLoopRunning();
        return;
      }
    }
  }, [getCanvasCoords, ensureLoopRunning]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const s = stateRef.current;
    if (!s.dragging || !s.renderer || !s.camera) return;
    getCanvasCoords(e);
    s.raycaster.setFromCamera(s.mouse, s.camera);

    if (s.dragging === "azimuth") {
      s.raycaster.ray.intersectPlane(_hitPlaneH, _hitPoint);
      if (_hitPoint) {
        // atan2(x, z) matches cameraPosition / azimuthHandle (see comment
        // on cameraPosition). No sign flip — drag right → az increases.
        s.liveAzimuth = normalizeAzimuth(radToDeg(Math.atan2(_hitPoint.x, _hitPoint.z)));
      }
    } else if (s.dragging === "elevation") {
      s.raycaster.ray.intersectPlane(_hitPlaneV, _hitPoint);
      if (_hitPoint) {
        const relY = _hitPoint.y - CENTER.y;
        const relZ = _hitPoint.z;
        s.liveElevation = clamp(radToDeg(Math.atan2(relY, relZ)), -30, 60);
      }
    } else if (s.dragging === "distance") {
      const deltaY = (e.clientY - s.dragStartY) / 100;
      s.liveDistance = clamp(s.dragStartDist + deltaY * 1.5, 0.6, 1.4);
    }
  }, [getCanvasCoords]);

  const onPointerUp = useCallback((e: PointerEvent) => {
    const s = stateRef.current;
    if (!s.dragging) return;
    s.dragging = null;
    if (s.renderer) {
      (s.renderer.domElement as HTMLElement).releasePointerCapture(e.pointerId);
    }
    const from: CameraAngles = {
      azimuth: s.liveAzimuth,
      elevation: s.liveElevation,
      distance: s.liveDistance,
    };
    const to = snapAngles(from);
    s.snapAnim = { start: performance.now(), from, to };
    ensureLoopRunning();
  }, [ensureLoopRunning]);

  // ── Image texture (swap in source image) ────────────────────────────

  const loadImageTexture = useCallback((nextImageUrl: string | null) => {
    const s = stateRef.current;
    if (!s.imagePlane) return;

    // Invalidate in-flight loads so a stale callback can't overwrite a newer
    // texture (happens when props flip rapidly between images).
    const textureLoadId = ++s.textureLoadId;
    const mat = s.imagePlane.material as THREE.MeshBasicMaterial;

    if (!nextImageUrl) {
      const previous = mat.map;
      mat.map = null;
      mat.color.set(0x475569);
      mat.needsUpdate = true;
      previous?.dispose();
      return;
    }

    const loader = new THREE.TextureLoader();
    loader.load(nextImageUrl, (tex) => {
      if (textureLoadId !== stateRef.current.textureLoadId || !s.imagePlane) {
        tex.dispose();
        return;
      }
      const previous = mat.map;
      mat.map = tex;
      mat.color.set(0xffffff);
      mat.needsUpdate = true;
      if (previous !== tex) previous?.dispose();
      // Rescale plane to match image aspect; cap long side at 1.5 world units.
      const img = tex.image as HTMLImageElement;
      if (img && img.width && img.height) {
        const aspect = img.width / img.height;
        const maxSize = 1.5;
        const [w, h] = aspect >= 1
          ? [maxSize, maxSize / aspect]
          : [maxSize * aspect, maxSize];
        s.imagePlane.scale.set(w / 1.2, h / 1.2, 1);
      }
      // Texture settled — kick one repaint so the plane shows the image
      // without waiting for the next RAF that may never come (loop is idle).
      renderOnce();
    });
  }, [renderOnce]);

  useEffect(() => {
    loadImageTexture(imageUrl);
  }, [imageUrl, loadImageTexture]);

  // ── Mount / unmount ─────────────────────────────────────────────────

  useEffect(() => {
    initScene();
    const s = stateRef.current;
    s.liveAzimuth = angles.azimuth;
    s.liveElevation = angles.elevation;
    s.liveDistance = angles.distance;
    // The [imageUrl] effect above fires BEFORE this mount effect (React runs
    // effects in declaration order), so imagePlane was null when it ran.
    // Kick the initial texture load here after the scene exists.
    loadImageTexture(imageUrl);

    const canvas = s.renderer?.domElement;
    if (canvas) {
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerUp);
      canvas.style.borderRadius = "10px";
      canvas.style.cursor = "grab";
    }

    // Initial paint — no RAF scheduled because the scene is static until
    // the user drags a handle (pointerdown → ensureLoopRunning).
    renderOnce();

    return () => {
      s.mounted = false;
      cancelAnimationFrame(s.animFrame);
      if (canvas) {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerUp);
      }
      // Invalidate any in-flight texture loads so late callbacks become no-ops.
      ++s.textureLoadId;
      s.imagePlane = null;
      // Walk the scene graph releasing all GPU resources (Three.js doesn't
      // auto-free on scene.dispose; each geometry/material/texture is owned).
      if (s.scene) {
        s.scene.traverse((obj) => {
          if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
            obj.geometry?.dispose();
            const mat = obj.material;
            if (Array.isArray(mat)) {
              mat.forEach((m) => { (m as THREE.MeshBasicMaterial).map?.dispose(); m.dispose(); });
            } else if (mat) {
              (mat as THREE.MeshBasicMaterial).map?.dispose();
              mat.dispose();
            }
          }
        });
      }
      s.renderer?.dispose();
      s.renderer?.domElement.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{ position: "relative", width, height }}
      // Stop pointerdown at the border so dragging inside the cube doesn't
      // bleed to Excalidraw / toolbar parents underneath.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div ref={containerRef} style={{ width, height }} />
      {/* Snapped-pose HUD */}
      <div
        ref={(el) => { stateRef.current.promptLabel = el; }}
        style={{
          position: "absolute",
          bottom: 8,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(15, 23, 42, 0.8)",
          color: "#f97316",
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 11,
          padding: "3px 10px",
          borderRadius: 4,
          whiteSpace: "nowrap",
          pointerEvents: "none",
        }}
      >
        {anglesToDisplayLabel(angles)}
      </div>
      {/* Axis legend */}
      <div
        style={{
          position: "absolute",
          top: 6, left: 8,
          display: "flex", gap: 10,
          fontSize: 10,
          color: "#cbd5e1",
          pointerEvents: "none",
        }}
      >
        <span><span style={{ color: "#f97316" }}>●</span> Azimuth</span>
        <span><span style={{ color: "#38bdf8" }}>●</span> Elevation</span>
        <span><span style={{ color: "#fbbf24" }}>●</span> Zoom</span>
      </div>
    </div>
  );
}
