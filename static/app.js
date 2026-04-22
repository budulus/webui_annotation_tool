(() => {
  'use strict';

  const UNDO_LIMIT = 20;
  const PREFETCH_AHEAD = 2;
  const SPINNER_DELAY_MS = 150;
  const SAVED_TOAST_MS = 800;
  const MASK_THRESHOLD = 128;

  const imageCanvas = document.getElementById('image-canvas');
  const overlayCanvas = document.getElementById('overlay-canvas');
  const wrap = document.getElementById('canvas-wrap');
  const cursor = document.getElementById('cursor-preview');
  const spinner = document.getElementById('spinner');
  const toast = document.getElementById('toast');
  const positionEl = document.getElementById('position');
  const prevBtn = document.getElementById('prev');
  const nextBtn = document.getElementById('next');
  const toolBtn = document.getElementById('tool');
  const undoBtn = document.getElementById('undo');
  const sizeInput = document.getElementById('size');
  const sizeLabel = document.getElementById('size-label');
  const opacityInput = document.getElementById('opacity');
  const opacityLabel = document.getElementById('opacity-label');
  const invertInput = document.getElementById('invert');
  const excludeInput = document.getElementById('exclude');

  const EXCLUDE_SUFFIX = '_exclude';

  const imageCtx = imageCanvas.getContext('2d');
  const overlayCtx = overlayCanvas.getContext('2d');

  let files = [];
  let idx = 0;
  let nativeW = 0, nativeH = 0;
  let cssW = 0, cssH = 0;

  // authoritative mask (offscreen); overlay canvas is just a presentation of this
  let maskSource = document.createElement('canvas');
  let maskCtx = maskSource.getContext('2d', { willReadFrequently: true });

  let brushSize = Number(sizeInput.value);
  let eraser = false;
  let overlayOpacity = Number(opacityInput.value);
  let invert = false;

  let drawing = false;
  let activePointerId = null;
  let lastX = 0, lastY = 0;

  let undoStack = [];
  let navigating = false;

  // prefetch cache: filename -> { image: {blob, objectUrl}, mask: {blob, objectUrl} }
  const cache = new Map();
  const inflight = new Map();

  // ── helpers ────────────────────────────────────────────────────────────

  function setOpacity(v) {
    overlayOpacity = Math.min(1, Math.max(0, v));
    document.documentElement.style.setProperty('--mask-opacity', String(overlayOpacity));
    opacityLabel.textContent = `Opacity ${overlayOpacity.toFixed(2)}`;
    opacityInput.value = String(overlayOpacity);
  }

  function setBrushSize(v) {
    brushSize = Math.min(200, Math.max(2, Math.round(v)));
    sizeLabel.textContent = `Size ${brushSize}`;
    sizeInput.value = String(brushSize);
    updateCursorSize();
  }

  function setTool(which) {
    eraser = which === 'eraser';
    toolBtn.dataset.mode = eraser ? 'eraser' : 'brush';
    toolBtn.textContent = eraser ? 'Eraser' : 'Brush';
  }

  function setInvert(v) {
    invert = !!v;
    invertInput.checked = invert;
    recomposite();
  }

  function showToast() {
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), SAVED_TOAST_MS);
  }

  function showSpinner(show) {
    spinner.hidden = !show;
  }

  function isExcludedName(name) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    return stem.endsWith(EXCLUDE_SUFFIX);
  }

  // ── layout ─────────────────────────────────────────────────────────────

  function layoutCanvases() {
    if (!nativeW || !nativeH) return;
    const stage = document.getElementById('stage');
    const availW = stage.clientWidth - 16;
    const availH = stage.clientHeight - 16;
    const scale = Math.min(availW / nativeW, availH / nativeH);
    cssW = Math.max(1, Math.floor(nativeW * scale));
    cssH = Math.max(1, Math.floor(nativeH * scale));
    wrap.style.width = cssW + 'px';
    wrap.style.height = cssH + 'px';
  }

  function updateCursorSize() {
    if (!cssW || !nativeW) return;
    const px = brushSize * (cssW / nativeW);
    cursor.style.width = px + 'px';
    cursor.style.height = px + 'px';
  }

  // ── compositing ────────────────────────────────────────────────────────

  function recomposite() {
    if (!nativeW || !nativeH) return;
    overlayCtx.save();
    overlayCtx.globalCompositeOperation = 'source-over';
    overlayCtx.clearRect(0, 0, nativeW, nativeH);
    if (!invert) {
      overlayCtx.drawImage(maskSource, 0, 0);
    } else {
      overlayCtx.fillStyle = 'rgba(255,0,0,1)';
      overlayCtx.fillRect(0, 0, nativeW, nativeH);
      overlayCtx.globalCompositeOperation = 'destination-out';
      overlayCtx.drawImage(maskSource, 0, 0);
    }
    overlayCtx.restore();
  }

  // ── fetching / prefetch ────────────────────────────────────────────────

  async function fetchBlob(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    return await r.blob();
  }

  function entryFor(name) {
    if (!cache.has(name)) cache.set(name, {});
    return cache.get(name);
  }

  async function ensureLoaded(name) {
    const e = entryFor(name);
    if (e.image && e.mask) return e;

    if (!inflight.has(name)) {
      const p = Promise.all([
        fetchBlob(`/api/image/${encodeURIComponent(name)}`),
        fetchBlob(`/api/mask/${encodeURIComponent(name)}`),
      ]).then(([imageBlob, maskBlob]) => {
        e.image = { blob: imageBlob, url: URL.createObjectURL(imageBlob) };
        e.mask = { blob: maskBlob, url: URL.createObjectURL(maskBlob) };
        return e;
      }).finally(() => inflight.delete(name));
      inflight.set(name, p);
    }
    return await inflight.get(name);
  }

  function evictFar() {
    // keep current ± PREFETCH_AHEAD + 1
    const keep = new Set();
    const n = files.length;
    for (let d = -1; d <= PREFETCH_AHEAD + 1; d++) {
      keep.add(files[((idx + d) % n + n) % n]);
    }
    for (const [name, e] of cache) {
      if (keep.has(name)) continue;
      if (e.image) URL.revokeObjectURL(e.image.url);
      if (e.mask) URL.revokeObjectURL(e.mask.url);
      cache.delete(name);
    }
  }

  function prefetchNext() {
    const n = files.length;
    if (!n) return;
    for (let d = 1; d <= PREFETCH_AHEAD; d++) {
      const name = files[(idx + d) % n];
      ensureLoaded(name).catch(() => {});
    }
    evictFar();
  }

  // ── mask conversion ────────────────────────────────────────────────────

  function decodeBlobToImage(blob) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
      img.decoding = 'async';
      img.src = url;
    });
  }

  function loadMaskIntoSource(img) {
    maskSource.width = nativeW;
    maskSource.height = nativeH;
    // draw into a temp canvas to read pixels
    const tmp = document.createElement('canvas');
    tmp.width = nativeW;
    tmp.height = nativeH;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(img, 0, 0, nativeW, nativeH);
    const src = tctx.getImageData(0, 0, nativeW, nativeH);
    const data = src.data;
    // Replace with red where luminance ≥ threshold (use green channel as proxy for grayscale)
    for (let i = 0; i < data.length; i += 4) {
      const v = data[i]; // mask is grayscale; R=G=B
      if (v >= MASK_THRESHOLD) {
        data[i] = 255; data[i+1] = 0; data[i+2] = 0; data[i+3] = 255;
      } else {
        data[i] = 0; data[i+1] = 0; data[i+2] = 0; data[i+3] = 0;
      }
    }
    maskCtx.putImageData(src, 0, 0);
  }

  function exportMaskBlob() {
    const out = document.createElement('canvas');
    out.width = nativeW;
    out.height = nativeH;
    const octx = out.getContext('2d');
    const src = maskCtx.getImageData(0, 0, nativeW, nativeH);
    const data = src.data;
    const img = octx.createImageData(nativeW, nativeH);
    const o = img.data;
    for (let i = 0; i < data.length; i += 4) {
      const on = data[i + 3] >= MASK_THRESHOLD ? 255 : 0;
      o[i] = on; o[i+1] = on; o[i+2] = on; o[i+3] = 255;
    }
    octx.putImageData(img, 0, 0);
    return new Promise(resolve => out.toBlob(b => resolve(b), 'image/png'));
  }

  // ── loading a slide ────────────────────────────────────────────────────

  async function loadAt(newIdx) {
    idx = ((newIdx % files.length) + files.length) % files.length;
    const name = files[idx];
    positionEl.textContent = `${idx + 1} / ${files.length} — ${name}`;
    excludeInput.checked = isExcludedName(name);

    const entry = await ensureLoaded(name);
    const [imgEl, maskEl] = await Promise.all([
      decodeBlobToImage(entry.image.blob),
      decodeBlobToImage(entry.mask.blob),
    ]);

    nativeW = imgEl.naturalWidth;
    nativeH = imgEl.naturalHeight;

    imageCanvas.width = nativeW;
    imageCanvas.height = nativeH;
    overlayCanvas.width = nativeW;
    overlayCanvas.height = nativeH;

    imageCtx.clearRect(0, 0, nativeW, nativeH);
    imageCtx.drawImage(imgEl, 0, 0);

    loadMaskIntoSource(maskEl);
    recomposite();

    layoutCanvases();
    updateCursorSize();
    undoStack = [];
    prefetchNext();
  }

  // ── saving + navigation ────────────────────────────────────────────────

  async function saveCurrent() {
    const name = files[idx];
    const blob = await exportMaskBlob();
    const spinnerTimer = setTimeout(() => showSpinner(true), SPINNER_DELAY_MS);
    try {
      const r = await fetch(`/api/mask/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: blob,
      });
      if (!r.ok) throw new Error(`save failed: ${r.status}`);
      // refresh cached mask so prev navigation sees the new version
      const entry = entryFor(name);
      if (entry.mask) URL.revokeObjectURL(entry.mask.url);
      entry.mask = { blob, url: URL.createObjectURL(blob) };
      showToast();
    } finally {
      clearTimeout(spinnerTimer);
      showSpinner(false);
    }
  }

  async function navigate(delta) {
    if (navigating || !files.length) return;
    navigating = true;
    try {
      await saveCurrent();
      await loadAt(idx + delta);
    } catch (err) {
      console.error(err);
      alert('Save failed — not navigating. Check console.');
    } finally {
      navigating = false;
    }
  }

  async function toggleExclude(nextState) {
    if (!files.length) return;
    const oldName = files[idx];
    const wasChecked = isExcludedName(oldName);
    if (drawing || navigating) {
      excludeInput.checked = wasChecked;
      return;
    }
    if (nextState === wasChecked) return;
    navigating = true;
    try {
      await saveCurrent();
      const r = await fetch(`/api/exclude/${encodeURIComponent(oldName)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exclude: nextState }),
      });
      if (!r.ok) {
        let detail = `${r.status}`;
        try { detail = (await r.json()).detail || detail; } catch {}
        throw new Error(detail);
      }
      const { filename: newName } = await r.json();
      if (newName !== oldName) {
        const entry = cache.get(oldName);
        if (entry) {
          cache.set(newName, entry);
          cache.delete(oldName);
        }
        files[idx] = newName;
        positionEl.textContent = `${idx + 1} / ${files.length} — ${newName}`;
      }
      excludeInput.checked = isExcludedName(files[idx]);
    } catch (err) {
      console.error(err);
      excludeInput.checked = wasChecked;
      alert(`Exclude toggle failed: ${err.message || err}`);
    } finally {
      navigating = false;
    }
  }

  // ── drawing ────────────────────────────────────────────────────────────

  function toNative(e) {
    const r = overlayCanvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * (nativeW / r.width);
    const y = (e.clientY - r.top) * (nativeH / r.height);
    return { x, y };
  }

  function paintSegment(x0, y0, x1, y1) {
    maskCtx.save();
    maskCtx.lineCap = 'round';
    maskCtx.lineJoin = 'round';
    maskCtx.lineWidth = brushSize;
    maskCtx.globalCompositeOperation = eraser ? 'destination-out' : 'source-over';
    maskCtx.strokeStyle = 'rgba(255,0,0,1)';
    maskCtx.beginPath();
    maskCtx.moveTo(x0, y0);
    maskCtx.lineTo(x1, y1);
    maskCtx.stroke();
    maskCtx.restore();
  }

  function pushUndo() {
    try {
      const snap = maskCtx.getImageData(0, 0, nativeW, nativeH);
      undoStack.push(snap);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    } catch {
      // ignore
    }
  }

  function doUndo() {
    const snap = undoStack.pop();
    if (!snap) return;
    maskCtx.putImageData(snap, 0, 0);
    recomposite();
  }

  overlayCanvas.addEventListener('pointerdown', (e) => {
    if (!nativeW) return;
    overlayCanvas.setPointerCapture(e.pointerId);
    activePointerId = e.pointerId;
    drawing = true;
    const { x, y } = toNative(e);
    lastX = x; lastY = y;
    pushUndo();
    paintSegment(x, y, x, y);
    recomposite();
    e.preventDefault();
  });

  overlayCanvas.addEventListener('pointermove', (e) => {
    updateCursorPosition(e);
    if (!drawing || e.pointerId !== activePointerId) return;
    const { x, y } = toNative(e);
    paintSegment(lastX, lastY, x, y);
    lastX = x; lastY = y;
    recomposite();
  });

  function endStroke(e) {
    if (e.pointerId !== activePointerId) return;
    try { overlayCanvas.releasePointerCapture(e.pointerId); } catch {}
    drawing = false;
    activePointerId = null;
  }

  overlayCanvas.addEventListener('pointerup', endStroke);
  overlayCanvas.addEventListener('pointercancel', endStroke);
  overlayCanvas.addEventListener('pointerleave', (e) => {
    cursor.style.transform = 'translate(-9999px, -9999px)';
    // do NOT end the stroke here — pointer capture continues the stroke off-canvas
  });

  function updateCursorPosition(e) {
    const r = overlayCanvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const px = brushSize * (cssW / nativeW);
    cursor.style.transform = `translate(${x - px/2}px, ${y - px/2}px)`;
  }

  overlayCanvas.addEventListener('pointerenter', updateCursorPosition);

  // ── controls ───────────────────────────────────────────────────────────

  prevBtn.addEventListener('click', () => navigate(-1));
  nextBtn.addEventListener('click', () => navigate(+1));
  toolBtn.addEventListener('click', () => setTool(eraser ? 'brush' : 'eraser'));
  undoBtn.addEventListener('click', doUndo);
  sizeInput.addEventListener('input', () => setBrushSize(Number(sizeInput.value)));
  opacityInput.addEventListener('input', () => setOpacity(Number(opacityInput.value)));
  invertInput.addEventListener('change', () => setInvert(invertInput.checked));
  excludeInput.addEventListener('change', () => toggleExclude(excludeInput.checked));

  // keybinds
  function isTypingTarget(t) {
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }
  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target) && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
    if (e.repeat && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    switch (e.key) {
      case 'ArrowLeft':  e.preventDefault(); navigate(-1); break;
      case 'ArrowRight': e.preventDefault(); navigate(+1); break;
      case 'e': case 'E': setTool(eraser ? 'brush' : 'eraser'); break;
      case '[': setBrushSize(brushSize - 2); break;
      case ']': setBrushSize(brushSize + 2); break;
      case 'z': case 'Z': doUndo(); break;
      case 'i': case 'I': setInvert(!invert); break;
      case '+': case '=': setOpacity(overlayOpacity + 0.1); break;
      case '-': case '_': setOpacity(overlayOpacity - 0.1); break;
    }
  });

  window.addEventListener('resize', () => {
    layoutCanvases();
    updateCursorSize();
  });

  // ── boot ───────────────────────────────────────────────────────────────

  (async function boot() {
    setOpacity(overlayOpacity);
    setBrushSize(brushSize);
    setTool('brush');
    try {
      const r = await fetch('/api/list');
      files = await r.json();
      if (!files.length) {
        positionEl.textContent = 'No files found in dataset';
        return;
      }
      await loadAt(0);
    } catch (err) {
      console.error(err);
      positionEl.textContent = 'Failed to load dataset';
    }
  })();
})();
