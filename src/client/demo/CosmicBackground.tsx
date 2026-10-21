import { useEffect, useRef } from 'react';
import { createCosmicRenderer, createStaticCosmicRenderer, type CosmicRenderer } from './cosmic-renderer.js';
import './cosmic-background.css';

interface CosmicBackgroundProps { paused: boolean }

export default function CosmicBackground({ paused }: CosmicBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fallbackRef = useRef<HTMLCanvasElement>(null);
  const controls = useRef<{ pause(value: boolean): void } | null>(null);
  const initialPaused = useRef(paused);

  useEffect(() => {
    const canvasNode = canvasRef.current;
    const fallbackNode = fallbackRef.current;
    if (!canvasNode || !fallbackNode) return;
    const canvas: HTMLCanvasElement = canvasNode;
    const fallback: HTMLCanvasElement = fallbackNode;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let renderer: CosmicRenderer;
    let frame = 0;
    let elapsed = 0;
    let lastTime: number | null = null;
    let lastDraw = -Infinity;
    let userPaused = initialPaused.current;
    let disposed = false;
    let contextLost = false;

    function installRenderer() {
      try {
        renderer = createCosmicRenderer(canvas);
        canvas.hidden = false;
        fallback.hidden = true;
      } catch {
        renderer = createStaticCosmicRenderer(fallback);
        canvas.hidden = true;
        fallback.hidden = false;
      }
    }
    const active = () => !disposed && renderer.animated && !contextLost && !userPaused && !document.hidden && !motion.matches;
    function draw() { renderer.draw(elapsed); }
    function tick(now: number) {
      frame = 0;
      if (!active()) { lastTime = null; return; }
      if (lastTime !== null) elapsed += Math.min((now - lastTime) / 1000, .1);
      lastTime = now;
      if (now - lastDraw >= 1000 / 30 - 1) { draw(); lastDraw = now; }
      frame = requestAnimationFrame(tick);
    }
    function reconcile() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      lastTime = null;
      lastDraw = -Infinity;
      if (active()) frame = requestAnimationFrame(tick);
    }
    function resize() {
      const width = Math.max(1, window.innerWidth);
      const height = Math.max(1, window.innerHeight);
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(2_200_000 / (width * height)));
      renderer.resize(width, height, dpr);
      draw();
    }
    function lost(event: Event) {
      event.preventDefault();
      contextLost = true;
      reconcile();
      renderer.dispose();
      renderer = createStaticCosmicRenderer(fallback);
      canvas.hidden = true;
      fallback.hidden = false;
      resize();
    }
    function restored() {
      if (disposed) return;
      renderer.dispose();
      contextLost = false;
      installRenderer();
      resize();
      reconcile();
    }

    installRenderer();
    resize();
    controls.current = { pause(value) { userPaused = value; reconcile(); } };
    document.addEventListener('visibilitychange', reconcile);
    motion.addEventListener('change', reconcile);
    window.addEventListener('resize', resize);
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    reconcile();
    return () => {
      disposed = true;
      controls.current = null;
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', reconcile);
      motion.removeEventListener('change', reconcile);
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
      renderer.dispose();
    };
  }, []);

  useEffect(() => { controls.current?.pause(paused); }, [paused]);

  return <div className="cosmic-background" aria-hidden="true">
    <canvas ref={fallbackRef} className="cosmic-background-canvas" />
    <canvas ref={canvasRef} className="cosmic-background-canvas" />
  </div>;
}
