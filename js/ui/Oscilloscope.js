export class Oscilloscope {
  constructor(canvas, analyser) {
    this._canvas   = canvas;
    this._analyser = analyser;
    this._buf      = new Float32Array(analyser.fftSize);
    this._rafId    = null;
    this._running  = false;

    // Keep canvas pixel width in sync with its CSS layout width
    this._ro = new ResizeObserver(entries => {
      const w = Math.round(entries[0].contentRect.width);
      if (w > 0 && canvas.width !== w) canvas.width = w;
    });
    this._ro.observe(canvas);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._loop();
  }

  stop() {
    this._running = false;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  _loop() {
    if (!this._running) return;
    this._rafId = requestAnimationFrame(() => this._loop());
    this._draw();
  }

  _draw() {
    const canvas   = this._canvas;
    const analyser = this._analyser;
    const buf      = this._buf;
    const W        = canvas.width;
    const H        = canvas.height;
    const ctx      = canvas.getContext('2d');

    analyser.getFloatTimeDomainData(buf);

    // Zero-crossing trigger: find first upward zero crossing
    let start = 0;
    for (let i = 1; i < buf.length - W; i++) {
      if (buf[i - 1] < 0 && buf[i] >= 0) { start = i; break; }
    }

    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, W, H);

    // Centre line
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();

    // Waveform
    ctx.strokeStyle = '#e8a020';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const s = buf[start + x] ?? 0;
      const y = (1 - s) * H / 2;
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}
