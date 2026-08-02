import * as THREE from 'three';
import { QUALITY, TIME_OF_DAY } from '../config/ArtDirection.js';

/**
 * Engine — owns the WebGL context, the frame loop, and the top-level scene graph.
 *
 * Deterministic mode: when `engine.deterministic` is true the loop does not run
 * on rAF. Instead the harness calls `engine.step(dt)` + `engine.render()` so that
 * screenshots are byte-reproducible regardless of machine speed.
 */
export class Engine {
  constructor(container) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // TAA/FXAA handled in the post stack
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Tonemapping happens in our own post stack; keep the HDR buffer linear.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.autoClear = true;
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      0.15,
      QUALITY.viewDistance,
    );
    this.camera.position.set(0, 4, 12);

    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.frame = 0;
    this.deterministic = false;
    this.paused = false;

    /** @type {Array<{update:(dt:number, e:Engine)=>void, order?:number}>} */
    this.systems = [];
    this.pipeline = null;
    this.timeOfDay = { ...TIME_OF_DAY.afternoon };

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
    this._loop = this._loop.bind(this);
  }

  addSystem(system) {
    this.systems.push(system);
    this.systems.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return system;
  }

  get size() {
    return {
      width: this.container.clientWidth,
      height: this.container.clientHeight,
      dpr: this.renderer.getPixelRatio(),
    };
  }

  _onResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (this.pipeline) this.pipeline.setSize(w, h, this.renderer.getPixelRatio());
  }

  start() {
    this.clock.start();
    if (!this.deterministic) this._raf = requestAnimationFrame(this._loop);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _loop() {
    this._raf = requestAnimationFrame(this._loop);
    const dt = Math.min(this.clock.getDelta(), 1 / 15);
    if (!this.paused) this.step(dt);
    this.render();
  }

  step(dt) {
    this.elapsed += dt;
    this.pipeline?.setDelta?.(dt);
    for (const s of this.systems) s.update(dt, this);
  }

  render() {
    this.frame++;
    this.renderer.info.reset();
    if (this.pipeline) this.pipeline.render(this.renderer, this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
  }
}
