'use strict';
// ── Market Bias Engine — Visual Identity & Ambient Animation Layer ────────────
// Three independent systems: RadarScope logo, ParticleField background,
// periodic screen scanline. All pure canvas / CSS — no dependencies.
// Designed for deep-space terminal aesthetic: surgical precision, not spectacle.

(function () {

  const PAL = {
    BULL:   '#2dd4a0',
    ACCENT: '#22d3ee',
    BEAR:   '#f7647a',
    MUTED:  '#1f1f23',
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. RADAR SCOPE — nav brand logo canvas
  //    Sweeping arm + fading blip contacts + concentric rings + crosshairs.
  //    Full rotation every ~6 seconds at 60 fps.
  // ═══════════════════════════════════════════════════════════════════════════
  class RadarScope {
    constructor(canvas) {
      this.c       = canvas;
      this.ctx     = canvas.getContext('2d');
      this.angle   = -Math.PI / 2;   // 12-o'clock start
      this.blips   = [];
      this.dpr     = Math.min(window.devicePixelRatio || 1, 2);
      this.running = true;
      this._setup();
      this._frame = this._frame.bind(this);
      requestAnimationFrame(this._frame);
    }

    _setup() {
      const px = this.c.offsetWidth  || 28;
      const py = this.c.offsetHeight || 28;
      this.c.width  = px * this.dpr;
      this.c.height = py * this.dpr;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.S  = px;
      this.cx = px / 2;
      this.cy = py / 2;
      this.R  = px / 2 - 1.5;
    }

    _spawnBlip() {
      if (Math.random() > 0.028) return;
      const dist   = this.R * (0.22 + Math.random() * 0.68);
      const jitter = (Math.random() - 0.5) * 0.45;
      this.blips.push({
        x: this.cx + Math.cos(this.angle + jitter) * dist,
        y: this.cy + Math.sin(this.angle + jitter) * dist,
        a: 0.85 + Math.random() * 0.15,
        r: 0.9 + Math.random() * 1.3,
      });
    }

    _draw() {
      const { ctx, cx, cy, R, S, angle } = this;
      ctx.clearRect(0, 0, S, S);

      // Outer boundary ring
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(34,211,238,0.20)';
      ctx.lineWidth   = 0.5;
      ctx.stroke();

      // Inner range rings ×2
      for (const f of [0.34, 0.67]) {
        ctx.beginPath();
        ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(34,211,238,0.07)';
        ctx.lineWidth   = 0.5;
        ctx.stroke();
      }

      // Crosshair lines
      ctx.strokeStyle = 'rgba(34,211,238,0.07)';
      ctx.lineWidth   = 0.5;
      ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();

      // Sweep trail — N pie wedges with quadratic opacity falloff
      const TRAIL = Math.PI * 0.70;
      const STEPS = 36;
      for (let i = 0; i < STEPS; i++) {
        const t  = (i + 1) / STEPS;               // 0 → 1 toward current angle
        const a0 = angle - TRAIL * (1 - i / STEPS);
        const a1 = angle - TRAIL * (1 - t);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R * 0.97, a0, a1);
        ctx.closePath();
        ctx.fillStyle = `rgba(45,212,160,${t * t * 0.19})`;
        ctx.fill();
      }

      // Sweep arm — gradient from centre to tip
      const armX = cx + Math.cos(angle) * R * 0.97;
      const armY = cy + Math.sin(angle) * R * 0.97;
      const grad = ctx.createLinearGradient(cx, cy, armX, armY);
      grad.addColorStop(0,   'rgba(45,212,160,0.0)');
      grad.addColorStop(0.4, 'rgba(45,212,160,0.5)');
      grad.addColorStop(1,   'rgba(45,212,160,1.0)');
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(armX, armY);
      ctx.strokeStyle = grad;
      ctx.lineWidth   = 1.2;
      ctx.stroke();

      // Blip contacts
      for (const b of this.blips) {
        // Solid core
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(45,212,160,${b.a})`;
        ctx.fill();
        // Soft halo
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r * 4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(45,212,160,${b.a * 0.15})`;
        ctx.fill();
      }

      // Centre origin dot
      ctx.beginPath();
      ctx.arc(cx, cy, 1.6, 0, Math.PI * 2);
      ctx.fillStyle = PAL.ACCENT;
      ctx.shadowColor  = PAL.ACCENT;
      ctx.shadowBlur   = 4;
      ctx.fill();
      ctx.shadowBlur   = 0;
    }

    _frame() {
      if (!this.running) return;
      this.angle += 0.019;
      if (this.angle > Math.PI * 1.5) this.angle -= Math.PI * 2;   // keep in [-π/2, 3π/2]
      this._spawnBlip();
      this.blips = this.blips.map(b => ({ ...b, a: b.a - 0.007 })).filter(b => b.a > 0);
      this._draw();
      requestAnimationFrame(this._frame);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. AMBIENT PARTICLE FIELD — full-screen background
  //    60-80 drifting nodes. Lines drawn between neighbours < 150 px.
  //    Very low opacity — textural, never distracting.
  //    Replaces the static CSS dot-grid.
  // ═══════════════════════════════════════════════════════════════════════════
  class ParticleField {
    constructor(canvas) {
      this.c    = canvas;
      this.ctx  = canvas.getContext('2d');
      this.dpr  = Math.min(window.devicePixelRatio || 1, 2);
      this.nodes = [];
      this._onResize = this._onResize.bind(this);
      this._frame    = this._frame.bind(this);
      window.addEventListener('resize', this._onResize, { passive: true });
      this._onResize();
      requestAnimationFrame(this._frame);
    }

    _onResize() {
      const W = window.innerWidth;
      const H = window.innerHeight;
      this.c.width  = W * this.dpr;
      this.c.height = H * this.dpr;
      this.c.style.width  = W + 'px';
      this.c.style.height = H + 'px';
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.W = W;
      this.H = H;
      this._populate();
    }

    _populate() {
      const COUNT = Math.min(Math.floor((this.W * this.H) / 18000), 75);
      this.nodes = Array.from({ length: COUNT }, () => ({
        x:  Math.random() * this.W,
        y:  Math.random() * this.H,
        vx: (Math.random() - 0.5) * 0.14,
        vy: (Math.random() - 0.5) * 0.14,
        r:  0.55 + Math.random() * 0.75,
        ph: Math.random() * Math.PI * 2,
        ps: 0.007 + Math.random() * 0.011,
      }));
    }

    _frame() {
      const { ctx, W, H, nodes } = this;
      ctx.clearRect(0, 0, W, H);

      const LINK  = 145;
      const LINK2 = LINK * LINK;

      // Update positions
      for (const n of nodes) {
        n.x  += n.vx;
        n.y  += n.vy;
        n.ph += n.ps;
        if (n.x < -5)    n.x = W + 5;
        if (n.x > W + 5) n.x = -5;
        if (n.y < -5)    n.y = H + 5;
        if (n.y > H + 5) n.y = -5;
      }

      // Draw edges
      ctx.lineWidth = 0.35;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b  = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          if (dx * dx + dy * dy > LINK2) continue;
          const dist  = Math.sqrt(dx * dx + dy * dy);
          const alpha = (1 - dist / LINK) * 0.065;
          ctx.strokeStyle = `rgba(34,211,238,${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      // Draw nodes
      for (const n of nodes) {
        const pulse = 0.5 + 0.5 * Math.sin(n.ph);
        const alpha = (0.07 + pulse * 0.12).toFixed(3);
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(34,211,238,${alpha})`;
        ctx.fill();
      }

      requestAnimationFrame(this._frame);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. FULL-SCREEN PERIODIC SCANLINE
  //    A single 1px horizontal beam sweeps the entire viewport every ~10-18s.
  //    Pure CSS animation — injected element only.
  // ═══════════════════════════════════════════════════════════════════════════
  function initScanline() {
    const el = document.createElement('div');
    el.id = 'scanBeam';
    document.body.appendChild(el);

    function sweep() {
      el.style.animation = 'none';
      void el.offsetWidth;                       // force reflow to restart
      el.style.animation = 'scan-sweep 2.8s cubic-bezier(0.25,0,0.75,1) forwards';
      setTimeout(sweep, 10000 + Math.random() * 8000);
    }
    setTimeout(sweep, 3500 + Math.random() * 3000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. BRAND TEXT CHROMATIC GLITCH
  //    Triggers .is-glitching on .brand-text every 15-30s.
  //    CSS handles the clip-path RGB-split effect.
  // ═══════════════════════════════════════════════════════════════════════════
  function initBrandGlitch() {
    const el = document.querySelector('.brand-text');
    if (!el) return;

    function glitch() {
      el.classList.add('is-glitching');
      // Second micro-glitch 60ms later for double-pulse feel
      setTimeout(() => {
        el.classList.remove('is-glitching');
        setTimeout(() => {
          el.classList.add('is-glitching');
          setTimeout(() => el.classList.remove('is-glitching'), 90);
        }, 60);
      }, 100);
      setTimeout(glitch, 15000 + Math.random() * 20000);
    }
    setTimeout(glitch, 8000 + Math.random() * 8000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. BOOT — wire everything up after DOM is ready
  // ═══════════════════════════════════════════════════════════════════════════
  function boot() {
    // Radar scope logo
    const rc = document.getElementById('radarLogo');
    if (rc) new RadarScope(rc);

    // Ambient particle field
    const bg = document.getElementById('ambientCanvas');
    if (bg) new ParticleField(bg);

    // Scanline + glitch (apply to all pages)
    initScanline();
    initBrandGlitch();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
