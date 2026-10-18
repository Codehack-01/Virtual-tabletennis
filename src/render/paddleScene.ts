import * as THREE from 'three';
import type { PaddlePose } from '../control/paddleController';
import { BALL_RADIUS, BLADE_RADIUS, GRIP_TO_BLADE, TABLE_PHYSICS, type BallState, type OpponentPaddlePose } from '../physics/ballPhysics';
import type { RallySnapshot } from '../game/rallyController';
import type { Vec3 } from '../motion/vector';

const TABLE = { ...TABLE_PHYSICS, thickness: 0.03 };
const TRAIL_POINTS = 24;
const BALL_TRAIL_POINTS = 42;
// Established gameplay framing: close enough for paddle control while keeping
// the full playable table in view.
const CAMERA = { position: { x: 0, y: 1.4, z: 2.62 }, target: { x: 0, y: 0.8, z: -0.02 }, fov: 44 };
const ARM_VISUAL_HOLD_MS = 180;

/**
 * Minimal Three.js view: table, net, the reachable paddle volume, and the paddle.
 * Plain Three.js (not react-three-fiber) so per-frame updates never touch React.
 */
export class PaddleScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(58, 1, 0.05, 50);
  private paddle = new THREE.Group();
  private opponentPaddle = new THREE.Group();
  private playerArm = new THREE.Group();
  private upperArm!: THREE.Mesh;
  private forearm!: THREE.Mesh;
  private shoulderJoint!: THREE.Mesh;
  private elbowJoint!: THREE.Mesh;
  private handMesh!: THREE.Mesh;
  private lastArmVisualAt = -Infinity;
  private bladeMaterials: THREE.MeshStandardMaterial[] = [];
  private trail: THREE.Line;
  private trailPositions = new Float32Array(TRAIL_POINTS * 3);
  private trailFilled = 0;
  private arrow: THREE.ArrowHelper;
  private ball: THREE.Mesh;
  private ballShadow: THREE.Mesh;
  private ballTrail: THREE.Line;
  private ballTrailPositions = new Float32Array(BALL_TRAIL_POINTS * 3);
  private ballTrailFilled = 0;
  private resizeObserver: ResizeObserver;

  constructor(private container: HTMLElement) {
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch {
      throw new Error('WebGL is not available in this browser, so the 3D view cannot be shown. Enable hardware acceleration or try another browser.');
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x0b1018);
    this.camera.fov = CAMERA.fov;
    this.camera.position.set(CAMERA.position.x, CAMERA.position.y, CAMERA.position.z);
    this.camera.lookAt(CAMERA.target.x, CAMERA.target.y, CAMERA.target.z);
    this.camera.updateProjectionMatrix();

    this.scene.add(new THREE.HemisphereLight(0xcfe5ff, 0x17202c, 1.35));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-2.4, 4.5, 2.8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -3;
    sun.shadow.camera.right = 3;
    sun.shadow.camera.top = 4;
    sun.shadow.camera.bottom = -2;
    this.scene.add(sun);

    this.buildTable();
    this.buildPaddle();
    this.buildPlayerArm();
    this.buildOpponentPaddle();
    this.ball = new THREE.Mesh(
      // Slightly oversized visually for webcam play; physics still uses a 40 mm ball.
      new THREE.SphereGeometry(BALL_RADIUS * 1.3, 24, 16),
      new THREE.MeshStandardMaterial({ color: 0xfff4d6, emissive: 0x332200, roughness: 0.35 }),
    );
    this.ball.castShadow = true;
    this.scene.add(this.ball);

    this.ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_RADIUS * 1.55, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.38, depthWrite: false }),
    );
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.ballShadow);

    const ballTrailGeom = new THREE.BufferGeometry();
    ballTrailGeom.setAttribute('position', new THREE.BufferAttribute(this.ballTrailPositions, 3));
    this.ballTrail = new THREE.Line(
      ballTrailGeom,
      new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.62 }),
    );
    this.ballTrail.frustumCulled = false;
    this.scene.add(this.ballTrail);

    const trailGeom = new THREE.BufferGeometry();
    trailGeom.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    this.trail = new THREE.Line(trailGeom, new THREE.LineBasicMaterial({ color: 0x4fd1c5, transparent: true, opacity: 0.6 }));
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);

    this.arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.1, 0xffd166, 0.05, 0.03);
    this.scene.add(this.arrow);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  private buildTable() {
    const blue = new THREE.MeshStandardMaterial({ color: 0x0b5f91, roughness: 0.48, metalness: 0.05 });
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE.width, TABLE.thickness, TABLE.length),
      blue,
    );
    top.position.y = TABLE.height - TABLE.thickness / 2;
    top.receiveShadow = true;
    top.castShadow = true;
    this.scene.add(top);

    const frameMat = new THREE.MeshStandardMaterial({ color: 0x202832, roughness: 0.55, metalness: 0.65 });
    const apronLong = new THREE.BoxGeometry(0.045, 0.11, TABLE.length);
    for (const x of [-TABLE.width / 2 + 0.025, TABLE.width / 2 - 0.025]) {
      const apron = new THREE.Mesh(apronLong, frameMat);
      apron.position.set(x, TABLE.height - 0.085, 0);
      apron.castShadow = true;
      this.scene.add(apron);
    }
    const apronShort = new THREE.BoxGeometry(TABLE.width, 0.11, 0.045);
    for (const z of [-TABLE.length / 2 + 0.025, TABLE.length / 2 - 0.025]) {
      const apron = new THREE.Mesh(apronShort, frameMat);
      apron.position.set(0, TABLE.height - 0.085, z);
      apron.castShadow = true;
      this.scene.add(apron);
    }

    const legGeom = new THREE.BoxGeometry(0.075, TABLE.height - 0.08, 0.075);
    for (const x of [-0.62, 0.62]) for (const z of [-1.05, 1.05]) {
      const leg = new THREE.Mesh(legGeom, frameMat);
      leg.position.set(x, (TABLE.height - 0.08) / 2, z);
      leg.castShadow = true;
      this.scene.add(leg);
    }

    const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff });
    const y = TABLE.height + 0.001;
    const hw = TABLE.width / 2;
    const hl = TABLE.length / 2;
    const border = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-hw, y, -hl), new THREE.Vector3(hw, y, -hl), new THREE.Vector3(hw, y, hl),
      new THREE.Vector3(-hw, y, hl), new THREE.Vector3(-hw, y, -hl),
    ]);
    this.scene.add(new THREE.Line(border, lineMat));
    const centre = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, y, -hl), new THREE.Vector3(0, y, hl)]);
    this.scene.add(new THREE.Line(centre, lineMat));

    const net = new THREE.Mesh(
      new THREE.PlaneGeometry(TABLE.width + 0.24, TABLE.netHeight, 20, 5),
      new THREE.MeshStandardMaterial({ color: 0x8290a0, wireframe: true, transparent: true, opacity: 0.62, side: THREE.DoubleSide }),
    );
    net.position.set(0, TABLE.height + TABLE.netHeight / 2, 0);
    this.scene.add(net);

    const postGeom = new THREE.CylinderGeometry(0.018, 0.018, TABLE.netHeight + 0.08, 12);
    for (const x of [-(TABLE.width / 2 + 0.1), TABLE.width / 2 + 0.1]) {
      const post = new THREE.Mesh(postGeom, frameMat);
      post.position.set(x, TABLE.height + TABLE.netHeight / 2, 0);
      post.castShadow = true;
      this.scene.add(post);
    }
    const tape = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE.width + 0.24, 0.018, 0.016),
      new THREE.MeshStandardMaterial({ color: 0xf3f5f7, roughness: 0.8 }),
    );
    tape.position.set(0, TABLE.height + TABLE.netHeight, 0);
    this.scene.add(tape);

    const floorSurface = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 12),
      new THREE.MeshStandardMaterial({ color: 0x472c2a, roughness: 0.88 }),
    );
    floorSurface.rotation.x = -Math.PI / 2;
    floorSurface.position.y = -0.004;
    floorSurface.receiveShadow = true;
    this.scene.add(floorSurface);
    // A regulation-sized visual playing zone and low perimeter barriers make the
    // table read as a court rather than an object floating on a grid.
    const courtLineMat = new THREE.LineBasicMaterial({ color: 0xd9cbc1, transparent: true, opacity: 0.72 });
    const courtWidth = 5.2;
    const courtLength = 8.2;
    const court = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-courtWidth / 2, 0.006, -courtLength / 2),
      new THREE.Vector3(courtWidth / 2, 0.006, -courtLength / 2),
      new THREE.Vector3(courtWidth / 2, 0.006, courtLength / 2),
      new THREE.Vector3(-courtWidth / 2, 0.006, courtLength / 2),
      new THREE.Vector3(-courtWidth / 2, 0.006, -courtLength / 2),
    ]);
    this.scene.add(new THREE.Line(court, courtLineMat));

    const barrierMat = new THREE.MeshStandardMaterial({ color: 0x173c63, roughness: 0.72 });
    const barrierLong = new THREE.BoxGeometry(0.05, 0.55, courtLength);
    for (const x of [-courtWidth / 2, courtWidth / 2]) {
      const barrier = new THREE.Mesh(barrierLong, barrierMat);
      barrier.position.set(x, 0.275, 0);
      barrier.receiveShadow = true;
      this.scene.add(barrier);
    }
    const barrierBack = new THREE.Mesh(new THREE.BoxGeometry(courtWidth, 0.55, 0.05), barrierMat);
    barrierBack.position.set(0, 0.275, -courtLength / 2);
    this.scene.add(barrierBack);
  }

  private buildPaddle() {
    const red = new THREE.MeshStandardMaterial({ color: 0xef3340, roughness: 0.5, transparent: true });
    const black = new THREE.MeshStandardMaterial({ color: 0x243447, roughness: 0.5, transparent: true });
    const wood = new THREE.MeshStandardMaterial({ color: 0xc8a165, roughness: 0.7, transparent: true });
    this.bladeMaterials = [red, black, wood];

    const core = new THREE.Mesh(new THREE.CylinderGeometry(BLADE_RADIUS, BLADE_RADIUS, 0.012, 48), wood);
    core.rotation.x = Math.PI / 2;
    core.position.set(0, GRIP_TO_BLADE, 0);
    this.paddle.add(core);

    // Cylinder axis along z so the rubber faces the table (red) and the player (black).
    const face = (mat: THREE.Material, z: number) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(BLADE_RADIUS, BLADE_RADIUS, 0.005, 40), mat);
      m.rotation.x = Math.PI / 2;
      m.position.set(0, GRIP_TO_BLADE, z);
      return m;
    };
    // Bright rubber faces the player/camera so the blade remains readable.
    this.paddle.add(face(black, -0.004), face(red, 0.004));
    const handle = new THREE.Mesh(new THREE.CapsuleGeometry(0.019, 0.072, 6, 12), wood);
    handle.position.y = GRIP_TO_BLADE - BLADE_RADIUS - 0.045;
    handle.scale.z = 0.7;
    this.paddle.add(handle);
    this.paddle.traverse((child) => {
      if (child instanceof THREE.Mesh) child.castShadow = true;
    });
    this.scene.add(this.paddle);
  }

  private buildOpponentPaddle() {
    const rubber = new THREE.MeshStandardMaterial({ color: 0xf2b632, roughness: 0.46 });
    const edge = new THREE.MeshStandardMaterial({ color: 0x17202b, roughness: 0.5 });
    const wood = new THREE.MeshStandardMaterial({ color: 0xc89a5b, roughness: 0.72 });
    const blade = new THREE.Mesh(new THREE.CylinderGeometry(BLADE_RADIUS, BLADE_RADIUS, 0.014, 40), edge);
    blade.rotation.x = Math.PI / 2;
    blade.position.y = GRIP_TO_BLADE;
    this.opponentPaddle.add(blade);
    const face = new THREE.Mesh(new THREE.CylinderGeometry(BLADE_RADIUS * 0.96, BLADE_RADIUS * 0.96, 0.005, 40), rubber);
    face.rotation.x = Math.PI / 2;
    face.position.set(0, GRIP_TO_BLADE, 0.009);
    this.opponentPaddle.add(face);
    const handle = new THREE.Mesh(new THREE.CapsuleGeometry(0.019, 0.072, 6, 12), wood);
    handle.position.y = GRIP_TO_BLADE - BLADE_RADIUS - 0.045;
    handle.scale.z = 0.7;
    this.opponentPaddle.add(handle);
    this.opponentPaddle.traverse((child) => {
      if (child instanceof THREE.Mesh) child.castShadow = true;
    });
    this.opponentPaddle.position.set(0, 0.92, -1.08);
    this.opponentPaddle.rotation.y = Math.PI;
    this.scene.add(this.opponentPaddle);
  }

  private buildPlayerArm() {
    const skin = new THREE.MeshStandardMaterial({ color: 0x9a6245, roughness: 0.82 });
    const shirt = new THREE.MeshStandardMaterial({ color: 0x263a5a, roughness: 0.75 });
    const limb = (radius: number, material: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.05, 1, 18), material);
      mesh.castShadow = true;
      this.playerArm.add(mesh);
      return mesh;
    };
    this.upperArm = limb(0.029, shirt);
    this.forearm = limb(0.026, skin);
    this.shoulderJoint = new THREE.Mesh(new THREE.SphereGeometry(0.034, 18, 12), shirt);
    this.elbowJoint = new THREE.Mesh(new THREE.SphereGeometry(0.029, 18, 12), skin);
    this.handMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.025, 0.045, 6, 12), skin);
    this.handMesh.rotation.z = Math.PI / 2;
    for (const mesh of [this.shoulderJoint, this.elbowJoint, this.handMesh]) {
      mesh.castShadow = true;
      this.playerArm.add(mesh);
    }
    this.playerArm.visible = false;
    this.scene.add(this.playerArm);
  }

  private placeLimb(mesh: THREE.Mesh, a: Vec3, b: Vec3) {
    const start = new THREE.Vector3(a.x, a.y, a.z);
    const end = new THREE.Vector3(b.x, b.y, b.z);
    const direction = end.clone().sub(start);
    const length = Math.max(0.001, direction.length());
    mesh.position.copy(start.add(end).multiplyScalar(0.5));
    mesh.scale.set(1, length, 1);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(pose: PaddlePose, ball?: BallState, rally?: RallySnapshot, cpuPose?: OpponentPaddlePose) {
    // Keep the court view fixed. Body-driven zoom is disabled until a reliable
    // depth signal can distinguish real footwork from swing-induced pose noise.
    this.camera.position.set(CAMERA.position.x, CAMERA.position.y, CAMERA.position.z);
    this.camera.lookAt(CAMERA.target.x, CAMERA.target.y, CAMERA.target.z);
    const now = performance.now();
    const { position: p, roll } = pose;
    this.paddle.position.set(p.x, p.y, p.z);
    this.paddle.rotation.set(pose.pitch, pose.yaw, roll, 'XYZ');
    this.paddle.visible = pose.tracked;
    // Player motion diagnostics made the paddle harder to read in actual play.
    this.trail.visible = false;
    for (const m of this.bladeMaterials) m.opacity = 1;

    const freshArm = pose.tracked && pose.arm !== null;
    if (freshArm && pose.arm) {
      this.lastArmVisualAt = now;
      this.placeLimb(this.upperArm, pose.arm.shoulder, pose.arm.elbow);
      this.placeLimb(this.forearm, pose.arm.elbow, pose.arm.hand);
      this.shoulderJoint.position.set(pose.arm.shoulder.x, pose.arm.shoulder.y, pose.arm.shoulder.z);
      this.elbowJoint.position.set(pose.arm.elbow.x, pose.arm.elbow.y, pose.arm.elbow.z);
      this.handMesh.position.set(pose.arm.hand.x, pose.arm.hand.y, pose.arm.hand.z);
      this.handMesh.rotation.z = pose.roll;
    }
    // Render-only dropout masking. The controller and collision system still
    // receive the original live tracking state with no grace period.
    this.playerArm.visible = freshArm || now - this.lastArmVisualAt <= ARM_VISUAL_HOLD_MS;

    const cpuActive = rally && rally.phase !== 'idle' && rally.phase !== 'point-over' && rally.phase !== 'game-over';
    this.opponentPaddle.visible = Boolean(cpuActive);
    if (cpuActive && rally && cpuPose) {
      this.opponentPaddle.position.set(cpuPose.position.x, cpuPose.position.y, cpuPose.position.z);
      if (rally.phase === 'pre-serve') {
        const remaining = Math.max(0, (rally.serveAt ?? now) - now);
        const preparation = 1 - Math.min(1, remaining / 1400);
        this.opponentPaddle.position.y += Math.sin(preparation * Math.PI) * 0.07;
        this.opponentPaddle.rotation.set(
          cpuPose.pitch - preparation * 0.28,
          Math.PI + cpuPose.yaw,
          -cpuPose.roll,
          'XYZ',
        );
      } else {
        // The pose used here also supplies the blade centre used by physics.
        // Swing is only the post-contact follow-through and therefore cannot
        // create a hidden collision outside the visible racket path.
        const strokeDirection = cpuPose.stroke === 'forehand' ? 1 : -1;
        this.opponentPaddle.rotation.set(
          cpuPose.pitch + cpuPose.swing * 0.3,
          Math.PI + cpuPose.yaw + strokeDirection * cpuPose.swing * 0.14,
          -cpuPose.roll - strokeDirection * cpuPose.swing * 0.24,
          'XYZ',
        );
      }
    }

    // Trail of the blade centre
    const bladeCentre = new THREE.Vector3(0, GRIP_TO_BLADE, 0).applyEuler(this.paddle.rotation).add(this.paddle.position);
    if (pose.tracked) {
      this.trailPositions.copyWithin(3, 0, (TRAIL_POINTS - 1) * 3);
      this.trailPositions.set([bladeCentre.x, bladeCentre.y, bladeCentre.z], 0);
      this.trailFilled = Math.min(TRAIL_POINTS, this.trailFilled + 1);
    } else {
      this.trailFilled = 0;
    }
    const geom = this.trail.geometry;
    (geom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    geom.setDrawRange(0, this.trailFilled);

    this.arrow.visible = false;

    if (ball) {
      const showBall = ball.status === 'held' || ball.status === 'in-play';
      this.ball.visible = showBall;
      this.ball.position.set(ball.position.x, ball.position.y, ball.position.z);
      const aboveTable = Math.abs(ball.position.x) <= TABLE.width / 2 && Math.abs(ball.position.z) <= TABLE.length / 2;
      const shadowY = aboveTable ? TABLE.height + 0.002 : 0.002;
      const height = Math.max(0, ball.position.y - shadowY);
      this.ballShadow.visible = showBall;
      this.ballShadow.position.set(ball.position.x, shadowY, ball.position.z);
      const shadowScale = Math.min(2.8, 1 + height * 0.9);
      this.ballShadow.scale.setScalar(shadowScale);
      (this.ballShadow.material as THREE.MeshBasicMaterial).opacity = 0.42 / (1 + height * 1.6);

      if (ball.status === 'in-play') {
        this.ballTrailPositions.copyWithin(3, 0, (BALL_TRAIL_POINTS - 1) * 3);
        this.ballTrailPositions.set([ball.position.x, ball.position.y, ball.position.z], 0);
        this.ballTrailFilled = Math.min(BALL_TRAIL_POINTS, this.ballTrailFilled + 1);
        const trailGeometry = this.ballTrail.geometry;
        (trailGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        trailGeometry.setDrawRange(0, this.ballTrailFilled);
      } else {
        this.ballTrailFilled = 0;
        this.ballTrail.geometry.setDrawRange(0, 0);
      }
    } else {
      this.ball.visible = false;
      this.ballShadow.visible = false;
    }

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
