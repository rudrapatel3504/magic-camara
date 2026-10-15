/**
 * MAGIC CAMERA PWA - PURE REAL-TIME COLOR TRANSPOSITION
 * ============================================================================
 * Completely normal camera feed. Zero floating objects.
 * Any RED card sliding into frame appears BLUE in real-time.
 * Finger SNAP instantly reverts the color to RED!
 */

const SETTINGS_STORAGE_KEY = 'magic_camera_settings_v3';

const DEFAULT_SETTINGS = {
  triggerMode: 'audio',       // 'audio' (Finger snap) or 'timer' (Auto countdown)
  timerDuration: 3.0,         // Seconds (2 to 10)
  snapSensitivity: 70,        // 30 to 95 (higher = easier to trigger)
  colorSensitivity: 3,        // 1 (strict) to 5 (lenient)
};

// Application State
const STATE = {
  ARMED: 'armed',             // Red turns to Blue
  REVEALED: 'revealed'        // Red color restored
};

let appState = STATE.ARMED;
let settings = loadSettings();

// DOM Elements
const videoEl = document.getElementById('camera-feed');
const arCanvas = document.getElementById('ar-canvas');
const revealFlash = document.getElementById('reveal-flash');
const secretZone = document.getElementById('secret-zone');
const gearBtn = document.getElementById('gear-btn');
const rearmOverlay = document.getElementById('rearm-overlay');

// Modals
const startOverlay = document.getElementById('start-overlay');
const btnStart = document.getElementById('btn-start');
const permError = document.getElementById('perm-error');
const settingsModal = document.getElementById('settings-modal');
const btnCloseSettingsX = document.getElementById('btn-close-settings-x');
const btnSaveSettings = document.getElementById('btn-save-settings');
const btnRearmTrick = document.getElementById('btn-rearm-trick');

// Settings Controls
const radioPills = document.querySelectorAll('input[name="triggerMode"]');
const timerSettingsGroup = document.getElementById('timer-settings-group');
const audioSettingsGroup = document.getElementById('audio-settings-group');
const timerSlider = document.getElementById('timer-slider');
const timerVal = document.getElementById('timer-val');
const snapSlider = document.getElementById('snap-slider');
const snapVal = document.getElementById('snap-val');
const micMeterFill = document.getElementById('mic-meter-fill');
const micThresholdMark = document.getElementById('mic-threshold-mark');
const colorSensSlider = document.getElementById('color-sens-slider');
const colorSensVal = document.getElementById('color-sens-val');

// Audio Processing Variables
let audioContext = null;
let analyserNode = null;
let micSource = null;
let micDataArray = null;
let recentAverageVolume = 0;
let lastSnapTime = 0;

// WebGL Engine Variables
let gl = null;
let shaderProgram = null;
let videoTexture = null;
let positionBuffer = null;
let texCoordBuffer = null;
let uRevealedLocation = null;
let uSensitivityLocation = null;
let uVideoAspectLocation = null;
let uScreenAspectLocation = null;
let isWebGLSupported = true;

// 2D Canvas Fallback Context
let ctx2d = null;

// Timers
let armedStartTime = 0;
let gearFadeTimer = null;

// ============================================================================
// 1. INITIALIZATION & LIFECYCLE
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {
  initUIListeners();
  applySettingsToUI();
  initRenderer();
  handleResize();
  window.addEventListener('resize', handleResize);
  window.addEventListener('orientationchange', handleResize);

  resetGearFade();

  // Register fresh service worker with cache bust
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js?v=3.0').then(reg => {
      reg.update();
    }).catch(err => {
      console.warn('SW registration skipped:', err);
    });
  }
});

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
    }
  } catch (e) {
    console.warn('Settings parse failed:', e);
  }
  return Object.assign({}, DEFAULT_SETTINGS);
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('Could not save settings:', e);
  }
}

function handleResize() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;

  arCanvas.width = w * dpr;
  arCanvas.height = h * dpr;

  if (gl) {
    gl.viewport(0, 0, arCanvas.width, arCanvas.height);
  }
}

// ============================================================================
// 2. WEBGL REAL-TIME COLOR TRANSPOSITION SHADER
// ============================================================================
function initRenderer() {
  try {
    gl = arCanvas.getContext('webgl', { alpha: false, depth: false, antialias: false, preserveDrawingBuffer: false }) ||
         arCanvas.getContext('experimental-webgl');
  } catch (e) {
    gl = null;
  }

  if (!gl) {
    console.warn('WebGL unavailable, using 2D canvas');
    isWebGLSupported = false;
    ctx2d = arCanvas.getContext('2d');
    return;
  }

  const vsSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    varying vec2 v_texCoord;
    uniform float u_videoAspect;
    uniform float u_screenAspect;

    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      
      // Maintain object-fit: cover aspect ratio
      vec2 coord = a_texCoord;
      if (u_screenAspect > u_videoAspect) {
        float scale = u_videoAspect / u_screenAspect;
        coord.y = (coord.y - 0.5) * scale + 0.5;
      } else {
        float scale = u_screenAspect / u_videoAspect;
        coord.x = (coord.x - 0.5) * scale + 0.5;
      }
      
      v_texCoord = coord;
    }
  `;

  const fsSource = `
    precision mediump float;
    varying vec2 v_texCoord;
    uniform sampler2D u_image;
    uniform bool u_revealed;
    uniform float u_sensitivity;

    vec3 rgb2hsv(vec3 c) {
      vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
      vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
      vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));

      float d = q.x - min(q.w, q.y);
      float e = 1.0e-10;
      return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
    }

    void main() {
      if (v_texCoord.x < 0.0 || v_texCoord.x > 1.0 || v_texCoord.y < 0.0 || v_texCoord.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }

      vec4 color = texture2D(u_image, v_texCoord);

      // Only shift color when ARMED (before reveal)
      if (!u_revealed) {
        vec3 hsv = rgb2hsv(color.rgb);
        float h = hsv.x * 360.0;
        float s = hsv.y;
        float v = hsv.z;

        // Dynamic sensitivity tuning
        float satThreshold = 0.44 - (u_sensitivity * 0.04);
        float diffThreshold = 0.13 - (u_sensitivity * 0.02);

        // Strict Red Playing Card criteria:
        // Excludes human skin (skin hue is 18°-45°, sat is 0.15-0.38)
        bool isRedHue = (h >= 342.0 || h <= 18.0);
        bool hasHighSat = (s >= satThreshold);
        bool redDominates = (color.r > color.g * 1.35) && 
                            (color.r > color.b * 1.35) && 
                            ((color.r - max(color.g, color.b)) > diffThreshold);

        if (isRedHue && hasHighSat && redDominates && v > 0.12) {
          // Transform Red into Deep Royal / Sapphire Blue
          // Preserves card pattern, shading, and texture details
          float r = color.r;
          float g = color.g;
          float b = color.b;

          color.r = r * 0.06;
          color.g = g * 0.35 + (r * 0.08);
          color.b = clamp(r * 1.10 + b * 0.20, 0.0, 1.0);
        }
      }

      gl_FragColor = color;
    }
  `;

  shaderProgram = createShaderProgram(gl, vsSource, fsSource);
  if (!shaderProgram) {
    isWebGLSupported = false;
    ctx2d = arCanvas.getContext('2d');
    return;
  }

  gl.useProgram(shaderProgram);

  positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1.0, -1.0,
     1.0, -1.0,
    -1.0,  1.0,
    -1.0,  1.0,
     1.0, -1.0,
     1.0,  1.0,
  ]), gl.STATIC_DRAW);

  texCoordBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0.0, 1.0,
    1.0, 1.0,
    0.0, 0.0,
    0.0, 0.0,
    1.0, 1.0,
    1.0, 0.0,
  ]), gl.STATIC_DRAW);

  videoTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, videoTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  uRevealedLocation = gl.getUniformLocation(shaderProgram, 'u_revealed');
  uSensitivityLocation = gl.getUniformLocation(shaderProgram, 'u_sensitivity');
  uVideoAspectLocation = gl.getUniformLocation(shaderProgram, 'u_videoAspect');
  uScreenAspectLocation = gl.getUniformLocation(shaderProgram, 'u_screenAspect');
}

function createShaderProgram(gl, vsSource, fsSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) return null;

  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('Shader link error:', gl.getProgramInfoLog(prog));
    return null;
  }
  return prog;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

// ============================================================================
// 3. CAMERA & MICROPHONE ACCESS
// ============================================================================
btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  btnStart.textContent = 'Opening Camera...';
  permError.classList.add('hidden');

  try {
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: true
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (combinedErr) {
      console.warn('Fallback to separate camera/mic request');
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }
      });
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioStream.getAudioTracks().forEach(track => stream.addTrack(track));
      } catch (micErr) {
        settings.triggerMode = 'timer';
        saveSettings();
        applySettingsToUI();
      }
    }

    videoEl.srcObject = stream;
    await videoEl.play();

    if (stream.getAudioTracks().length > 0) {
      setupAudioAnalyzer(stream);
    }

    startOverlay.classList.add('hidden');
    appState = STATE.ARMED;
    armedStartTime = performance.now();

    requestAnimationFrame(renderLoop);

  } catch (err) {
    console.error('Camera startup error:', err);
    permError.textContent = `Error: ${err.message || 'Camera permission denied.'}`;
    permError.classList.remove('hidden');
    btnStart.disabled = false;
    btnStart.textContent = 'Retry Opening Camera';
  }
});

// ============================================================================
// 4. AUDIO SNAP DETECTION ENGINE (WEB AUDIO API)
// ============================================================================
function setupAudioAnalyzer(stream) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    audioContext = new AudioContextClass();
    micSource = audioContext.createMediaStreamSource(stream);

    const highpass = audioContext.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 1400;

    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 512;
    analyserNode.smoothingTimeConstant = 0.2;

    micSource.connect(highpass);
    highpass.connect(analyserNode);

    micDataArray = new Uint8Array(analyserNode.frequencyBinCount);
  } catch (err) {
    console.warn('Web Audio setup error:', err);
  }
}

function checkAudioSnapTrigger() {
  if (!analyserNode || !micDataArray) return;

  analyserNode.getByteFrequencyData(micDataArray);

  let sum = 0;
  for (let i = 0; i < micDataArray.length; i++) {
    sum += micDataArray[i];
  }
  const currentLevel = sum / micDataArray.length;

  if (!settingsModal.classList.contains('hidden') && micMeterFill) {
    const percent = Math.min(100, Math.round((currentLevel / 120) * 100));
    micMeterFill.style.width = `${percent}%`;
  }

  recentAverageVolume = (recentAverageVolume * 0.92) + (currentLevel * 0.08);

  const now = performance.now();
  const dynamicThreshold = 25 + (100 - settings.snapSensitivity) * 0.7;
  const spikeDelta = currentLevel - recentAverageVolume;

  if (settings.triggerMode === 'audio' && appState === STATE.ARMED) {
    if (currentLevel > dynamicThreshold && spikeDelta > 18 && (now - lastSnapTime > 800)) {
      lastSnapTime = now;
      triggerInstantReveal('🎙️ Finger Snap Detected');
    }
  }
}

// ============================================================================
// 5. 60FPS REAL-TIME LOOP
// ============================================================================
function renderLoop() {
  requestAnimationFrame(renderLoop);

  checkAudioSnapTrigger();

  if (videoEl.readyState < videoEl.HAVE_CURRENT_DATA) return;

  const now = performance.now();

  // Timer trigger handler
  if (settings.triggerMode === 'timer' && appState === STATE.ARMED) {
    if (!armedStartTime) armedStartTime = now;
    const elapsed = (now - armedStartTime) / 1000;
    if (elapsed >= settings.timerDuration) {
      triggerInstantReveal(`⏱️ Timer Finished (${settings.timerDuration}s)`);
    }
  }

  if (isWebGLSupported && gl && shaderProgram) {
    renderWebGLFrame();
  } else if (ctx2d) {
    render2DFallbackFrame();
  }
}

function renderWebGLFrame() {
  gl.useProgram(shaderProgram);

  gl.bindTexture(gl.TEXTURE_2D, videoTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);

  const isRevealed = (appState === STATE.REVEALED);
  gl.uniform1i(uRevealedLocation, isRevealed ? 1 : 0);
  gl.uniform1f(uSensitivityLocation, settings.colorSensitivity);

  const videoAspect = (videoEl.videoWidth || 1280) / (videoEl.videoHeight || 720);
  const screenAspect = window.innerWidth / window.innerHeight;
  gl.uniform1f(uVideoAspectLocation, videoAspect);
  gl.uniform1f(uScreenAspectLocation, screenAspect);

  const aPositionLocation = gl.getAttribLocation(shaderProgram, 'a_position');
  gl.enableVertexAttribArray(aPositionLocation);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.vertexAttribPointer(aPositionLocation, 2, gl.FLOAT, false, 0, 0);

  const aTexCoordLocation = gl.getAttribLocation(shaderProgram, 'a_texCoord');
  gl.enableVertexAttribArray(aTexCoordLocation);
  gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
  gl.vertexAttribPointer(aTexCoordLocation, 2, gl.FLOAT, false, 0, 0);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function render2DFallbackFrame() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx2d.drawImage(videoEl, 0, 0, w, h);

  // 2D pixel color shift fallback
  if (appState === STATE.ARMED) {
    const frame = ctx2d.getImageData(0, 0, w, h);
    const d = frame.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i+1];
      const b = d[i+2];
      if (r > 110 && r > g * 1.4 && r > b * 1.4 && (r - Math.max(g, b)) > 30) {
        d[i] = r * 0.08;
        d[i+1] = g * 0.35 + r * 0.08;
        d[i+2] = Math.min(255, r * 1.1 + b * 0.2);
      }
    }
    ctx2d.putImageData(frame, 0, 0);
  }
}

// ============================================================================
// 6. INSTANT REVEAL & SILENT RE-ARM
// ============================================================================
function triggerInstantReveal(reason) {
  if (appState === STATE.REVEALED) return;

  console.log(`✨ COLOR REVERTED TO RED: ${reason}`);
  appState = STATE.REVEALED;

  // Optical micro-flash
  revealFlash.classList.add('active');
  setTimeout(() => {
    revealFlash.classList.remove('active');
  }, 65);

  rearmOverlay.classList.remove('hidden');
}

function rearmTrick() {
  appState = STATE.ARMED;
  armedStartTime = performance.now();
  rearmOverlay.classList.add('hidden');
}

// ============================================================================
// 7. HIDDEN SETTINGS & CONTROLS
// ============================================================================
function initUIListeners() {
  let secretPressTimer = null;

  secretZone.addEventListener('touchstart', () => {
    secretPressTimer = setTimeout(() => {
      openSettingsModal();
      if (navigator.vibrate) navigator.vibrate(50);
    }, 900);
  }, { passive: true });

  secretZone.addEventListener('touchend', () => clearTimeout(secretPressTimer));
  secretZone.addEventListener('touchcancel', () => clearTimeout(secretPressTimer));
  secretZone.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openSettingsModal();
  });

  gearBtn.addEventListener('click', openSettingsModal);

  document.addEventListener('pointerdown', (e) => {
    if (e.clientX > window.innerWidth - 80 && e.clientY < 80) {
      resetGearFade();
    }
    if (appState === STATE.REVEALED && !e.target.closest('#settings-modal')) {
      rearmTrick();
    }
  });

  rearmOverlay.addEventListener('click', rearmTrick);
  btnCloseSettingsX.addEventListener('click', closeSettingsModal);
  btnSaveSettings.addEventListener('click', saveAndApplySettings);
  btnRearmTrick.addEventListener('click', () => {
    rearmTrick();
    closeSettingsModal();
  });

  radioPills.forEach(radio => {
    radio.addEventListener('change', (e) => updateTriggerModeUI(e.target.value));
  });

  timerSlider.addEventListener('input', (e) => {
    timerVal.textContent = `${parseFloat(e.target.value).toFixed(1)} s`;
  });

  snapSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    snapVal.textContent = val > 80 ? `High (${val})` : (val < 50 ? `Low (${val})` : `Medium (${val})`);
    if (micThresholdMark) {
      micThresholdMark.style.left = `${100 - val}%`;
    }
  });

  colorSensSlider.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    const labels = ['Strict', 'Medium-Strict', 'Balanced', 'Medium-Lenient', 'Lenient'];
    colorSensVal.textContent = labels[v - 1] || 'Balanced';
  });
}

function resetGearFade() {
  gearBtn.classList.remove('fade-out');
  clearTimeout(gearFadeTimer);
  gearFadeTimer = setTimeout(() => {
    gearBtn.classList.add('fade-out');
  }, 3000);
}

function openSettingsModal() {
  applySettingsToUI();
  settingsModal.classList.remove('hidden');
}

function closeSettingsModal() {
  settingsModal.classList.add('hidden');
  resetGearFade();
}

function updateTriggerModeUI(mode) {
  if (mode === 'timer') {
    timerSettingsGroup.classList.remove('hidden');
    audioSettingsGroup.classList.add('hidden');
  } else {
    timerSettingsGroup.classList.add('hidden');
    audioSettingsGroup.classList.remove('hidden');
  }
}

function applySettingsToUI() {
  radioPills.forEach(r => {
    r.checked = (r.value === settings.triggerMode);
  });
  updateTriggerModeUI(settings.triggerMode);

  timerSlider.value = settings.timerDuration;
  timerVal.textContent = `${parseFloat(settings.timerDuration).toFixed(1)} s`;

  snapSlider.value = settings.snapSensitivity;
  const sVal = settings.snapSensitivity;
  snapVal.textContent = sVal > 80 ? `High (${sVal})` : (sVal < 50 ? `Low (${sVal})` : `Medium (${sVal})`);
  if (micThresholdMark) {
    micThresholdMark.style.left = `${100 - sVal}%`;
  }

  colorSensSlider.value = settings.colorSensitivity;
  const labels = ['Strict', 'Medium-Strict', 'Balanced', 'Medium-Lenient', 'Lenient'];
  colorSensVal.textContent = labels[settings.colorSensitivity - 1] || 'Balanced';
}

function saveAndApplySettings() {
  const selectedMode = document.querySelector('input[name="triggerMode"]:checked')?.value || 'audio';
  settings.triggerMode = selectedMode;
  settings.timerDuration = parseFloat(timerSlider.value) || 3.0;
  settings.snapSensitivity = parseInt(snapSlider.value, 10) || 70;
  settings.colorSensitivity = parseInt(colorSensSlider.value, 10) || 3;

  saveSettings();
  closeSettingsModal();
}
