/**
 * GOOGLE CAMERA (GCAM) PWA - CLEAN CARD TRANSPOSITION
 * ============================================================================
 * Disguised 100% as the native Google Pixel Camera app.
 * Red Playing Cards seamlessly appear Bicycle Blue in real-time.
 * Tap Shutter Button (or timer) to make blue layer fade away / disappear.
 * Zero flash animations. Zero microphone/audio permissions.
 */

const SETTINGS_STORAGE_KEY = 'gcam_camera_settings_v5';

const DEFAULT_SETTINGS = {
  triggerMode: 'tap',          // 'tap' (Tap shutter/screen) or 'timer' (Auto countdown)
  transitionStyle: 'fade',     // 'fade' (Smooth fade away) or 'direct' (Instant cut)
  timerDuration: 3.0,          // Seconds
  colorSensitivity: 3,         // 1 (strict) to 5 (lenient)
};

const STATE = {
  ARMED: 'armed',              // Red card appears blue
  REVEALED: 'revealed'         // Blue layer faded away (Red card visible)
};

let appState = STATE.ARMED;
let settings = loadSettings();

// Blue amount for smooth fade transition (1.0 = full blue, 0.0 = real red)
let currentBlueAmount = 1.0;
let targetBlueAmount = 1.0;
let lastFrameTime = performance.now();

// DOM Elements
const videoEl = document.getElementById('camera-feed');
const arCanvas = document.getElementById('ar-canvas');
const focusReticle = document.getElementById('focus-reticle');
const cameraStarter = document.getElementById('camera-tap-starter');

// GCam Controls
const shutterBtn = document.getElementById('shutter-btn');
const btnSettings = document.getElementById('btn-settings');
const btnDrawer = document.getElementById('btn-gcam-drawer');
const btnCloseSheet = document.getElementById('btn-close-sheet');
const btnSaveSheet = document.getElementById('btn-save-sheet');
const settingsSheet = document.getElementById('gcam-settings-modal');
const zoomBtns = document.querySelectorAll('.zoom-btn');

// Settings Elements
const triggerRadios = document.querySelectorAll('input[name="triggerMode"]');
const transitionRadios = document.querySelectorAll('input[name="transitionStyle"]');
const timerSettingsGroup = document.getElementById('timer-settings-group');
const timerSlider = document.getElementById('timer-slider');
const timerVal = document.getElementById('timer-val');
const colorSensSlider = document.getElementById('color-sens-slider');
const colorSensVal = document.getElementById('color-sens-val');

// WebGL Variables
let gl = null;
let shaderProgram = null;
let videoTexture = null;
let positionBuffer = null;
let texCoordBuffer = null;
let uBlueAmountLocation = null;
let uSensitivityLocation = null;
let uVideoAspectLocation = null;
let uScreenAspectLocation = null;
let isWebGLSupported = true;
let isCameraRunning = false;

// 2D Fallback Context
let ctx2d = null;
let armedStartTime = 0;

// ============================================================================
// 1. INITIALIZATION & LIFECYCLE
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {
  initGCamUI();
  applySettingsToUI();
  initRenderer();
  handleResize();
  window.addEventListener('resize', handleResize);
  window.addEventListener('orientationchange', handleResize);

  // Auto-start camera immediately (no audio needed)
  startCameraStream();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js?v=5.0').then(reg => reg.update()).catch(() => {});
  }
});

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
  } catch (e) {}
  return Object.assign({}, DEFAULT_SETTINGS);
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {}
}

function handleResize() {
  const dpr = window.devicePixelRatio || 1;
  arCanvas.width = window.innerWidth * dpr;
  arCanvas.height = window.innerHeight * dpr;

  if (gl) {
    gl.viewport(0, 0, arCanvas.width, arCanvas.height);
  }
}

// ============================================================================
// 2. WEBGL CHROMATIC SHADER (SMOOTH FADE, AUTHENTIC BICYCLE BLUE)
// ============================================================================
function initRenderer() {
  try {
    gl = arCanvas.getContext('webgl', { alpha: false, depth: false, antialias: false, preserveDrawingBuffer: false }) ||
         arCanvas.getContext('experimental-webgl');
  } catch (e) {
    gl = null;
  }

  if (!gl) {
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

  // Fragment Shader: Converts red ink into authentic Bicycle Rider Back Blue
  // Controlled by u_blueAmount (1.0 = blue, 0.0 = natural red) for smooth fade or direct cut
  const fsSource = `
    precision mediump float;
    varying vec2 v_texCoord;
    uniform sampler2D u_image;
    uniform float u_blueAmount;
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

      if (u_blueAmount > 0.001) {
        vec3 hsv = rgb2hsv(color.rgb);
        float h = hsv.x * 360.0;
        float s = hsv.y;
        float v = hsv.z;

        // Strict Skin Exclusion: Human skin has substantial green (G/R > 0.56)
        // Red card ink has very low green (G/R < 0.45)
        float greenRatio = color.g / max(0.01, color.r);
        bool isSkin = (greenRatio > 0.56) || (h >= 18.0 && h <= 45.0 && s < 0.55);

        // Red Playing Card criteria
        bool isRedHue = (h >= 342.0 || h <= 17.0);
        float minSat = 0.40 - (u_sensitivity * 0.03);
        bool hasCardSat = (s >= minSat);
        bool redDominates = (color.r > color.g * 1.35) && (color.r > color.b * 1.35);

        if (!isSkin && isRedHue && hasCardSat && redDominates && v > 0.12) {
          // Authentic Bicycle Rider Back Navy Blue target
          vec3 navyBlue = vec3(
            color.r * 0.02,
            color.g * 0.22,
            max(color.r * 0.85, 0.45)
          );

          float redness = clamp((color.r - max(color.g, color.b) - 0.10) / 0.20, 0.0, 1.0);
          vec3 finalColor = mix(color.rgb, navyBlue, redness);

          // Blend with u_blueAmount for fade or direct cut
          color.rgb = mix(color.rgb, finalColor, u_blueAmount);
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
    -1.0, -1.0,  1.0, -1.0, -1.0,  1.0,
    -1.0,  1.0,  1.0, -1.0,  1.0,  1.0,
  ]), gl.STATIC_DRAW);

  texCoordBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0.0, 1.0,  1.0, 1.0,  0.0, 0.0,
    0.0, 0.0,  1.0, 1.0,  1.0, 0.0,
  ]), gl.STATIC_DRAW);

  videoTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, videoTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  uBlueAmountLocation = gl.getUniformLocation(shaderProgram, 'u_blueAmount');
  uSensitivityLocation = gl.getUniformLocation(shaderProgram, 'u_sensitivity');
  uVideoAspectLocation = gl.getUniformLocation(shaderProgram, 'u_videoAspect');
  uScreenAspectLocation = gl.getUniformLocation(shaderProgram, 'u_screenAspect');
}

function createShaderProgram(gl, vs, fs) {
  const p = gl.createProgram();
  const v = gl.createShader(gl.VERTEX_SHADER);
  const f = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(v, vs); gl.compileShader(v);
  gl.shaderSource(f, fs); gl.compileShader(f);
  gl.attachShader(p, v); gl.attachShader(p, f);
  gl.linkProgram(p);
  return p;
}

// ============================================================================
// 3. CAMERA ONLY (ZERO MICROPHONE PERMISSION)
// ============================================================================
async function startCameraStream() {
  if (isCameraRunning) return;

  try {
    // Only video is requested; no microphone permission needed!
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
    });

    videoEl.srcObject = stream;
    await videoEl.play();

    cameraStarter.classList.add('hidden');
    isCameraRunning = true;
    appState = STATE.ARMED;
    currentBlueAmount = 1.0;
    targetBlueAmount = 1.0;
    armedStartTime = performance.now();

    requestAnimationFrame(renderLoop);
  } catch (err) {
    console.log('Awaiting user tap to start camera');
  }
}

// ============================================================================
// 4. RENDERING LOOP & SMOOTH FADE ENGINE
// ============================================================================
function renderLoop() {
  requestAnimationFrame(renderLoop);

  if (videoEl.readyState < videoEl.HAVE_CURRENT_DATA) return;

  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  // Auto Timer check
  if (settings.triggerMode === 'timer' && appState === STATE.ARMED) {
    if (!armedStartTime) armedStartTime = now;
    if ((now - armedStartTime) / 1000 >= settings.timerDuration) {
      triggerReveal();
    }
  }

  // Smooth Fade Animation: gracefully dissolve blue into red
  if (settings.transitionStyle === 'fade') {
    const fadeSpeed = 3.5; // Fades out smoothly in ~0.28 seconds
    if (currentBlueAmount < targetBlueAmount) {
      currentBlueAmount = Math.min(targetBlueAmount, currentBlueAmount + dt * fadeSpeed);
    } else if (currentBlueAmount > targetBlueAmount) {
      currentBlueAmount = Math.max(targetBlueAmount, currentBlueAmount - dt * fadeSpeed);
    }
  } else {
    // Direct cut
    currentBlueAmount = targetBlueAmount;
  }

  if (isWebGLSupported && gl && shaderProgram) {
    gl.useProgram(shaderProgram);
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);

    gl.uniform1f(uBlueAmountLocation, currentBlueAmount);
    gl.uniform1f(uSensitivityLocation, settings.colorSensitivity);

    const videoAspect = (videoEl.videoWidth || 1280) / (videoEl.videoHeight || 720);
    const screenAspect = window.innerWidth / window.innerHeight;
    gl.uniform1f(uVideoAspectLocation, videoAspect);
    gl.uniform1f(uScreenAspectLocation, screenAspect);

    const aPos = gl.getAttribLocation(shaderProgram, 'a_position');
    gl.enableVertexAttribArray(aPos);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const aTex = gl.getAttribLocation(shaderProgram, 'a_texCoord');
    gl.enableVertexAttribArray(aTex);
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  } else if (ctx2d) {
    ctx2d.drawImage(videoEl, 0, 0, window.innerWidth, window.innerHeight);
  }
}

// ============================================================================
// 5. REVEAL & SHUTTER ACTIONS (ZERO FLASH, CLEAN FADE/DISAPPEAR)
// ============================================================================
function triggerReveal() {
  if (appState === STATE.REVEALED) return;

  appState = STATE.REVEALED;
  targetBlueAmount = 0.0; // Blue fades away or cuts to 0

  if (settings.transitionStyle === 'direct') {
    currentBlueAmount = 0.0;
  }
}

function rearmTrick() {
  appState = STATE.ARMED;
  targetBlueAmount = 1.0;
  armedStartTime = performance.now();

  if (settings.transitionStyle === 'direct') {
    currentBlueAmount = 1.0;
  }
}

function handleShutterClick() {
  // Toggle: If currently armed (blue), reveal red! If already revealed, re-arm to blue!
  if (appState === STATE.ARMED) {
    triggerReveal();
  } else {
    rearmTrick();
  }
}

// ============================================================================
// 6. GCAM UI INTERACTIONS
// ============================================================================
function initGCamUI() {
  cameraStarter.addEventListener('click', () => {
    startCameraStream();
  });

  // Big Shutter Button
  shutterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleShutterClick();
  });

  // Tap on viewfinder for focus reticle
  arCanvas.addEventListener('click', (e) => {
    if (!isCameraRunning) {
      startCameraStream();
      return;
    }
    focusReticle.style.left = `${e.clientX}px`;
    focusReticle.style.top = `${e.clientY}px`;
    focusReticle.classList.remove('hidden');
    focusReticle.classList.add('active');
    setTimeout(() => {
      focusReticle.classList.remove('active');
      setTimeout(() => focusReticle.classList.add('hidden'), 200);
    }, 600);
  });

  // Settings Sheet Toggle
  btnSettings.addEventListener('click', () => settingsSheet.classList.remove('hidden'));
  btnDrawer.addEventListener('click', () => settingsSheet.classList.remove('hidden'));
  btnCloseSheet.addEventListener('click', () => settingsSheet.classList.add('hidden'));
  btnSaveSheet.addEventListener('click', () => {
    saveSettingsFromUI();
    settingsSheet.classList.add('hidden');
  });

  // Zoom pills
  zoomBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      zoomBtns.forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
    });
  });

  // Settings Controls
  triggerRadios.forEach(r => {
    r.addEventListener('change', (e) => {
      updateTriggerModeUI(e.target.value);
    });
  });

  timerSlider.addEventListener('input', (e) => {
    timerVal.textContent = `${parseFloat(e.target.value).toFixed(1)} s`;
  });

  colorSensSlider.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    const labels = ['Strict', 'Medium-Strict', 'Balanced', 'Medium-Lenient', 'Lenient'];
    colorSensVal.textContent = labels[v - 1] || 'Balanced';
  });
}

function updateTriggerModeUI(mode) {
  if (mode === 'timer') {
    timerSettingsGroup.classList.remove('hidden');
  } else {
    timerSettingsGroup.classList.add('hidden');
  }
}

function applySettingsToUI() {
  triggerRadios.forEach(r => r.checked = (r.value === settings.triggerMode));
  updateTriggerModeUI(settings.triggerMode);

  transitionRadios.forEach(r => r.checked = (r.value === settings.transitionStyle));

  timerSlider.value = settings.timerDuration;
  timerVal.textContent = `${parseFloat(settings.timerDuration).toFixed(1)} s`;

  colorSensSlider.value = settings.colorSensitivity;
  const labels = ['Strict', 'Medium-Strict', 'Balanced', 'Medium-Lenient', 'Lenient'];
  colorSensVal.textContent = labels[settings.colorSensitivity - 1] || 'Balanced';
}

function saveSettingsFromUI() {
  const selectedMode = document.querySelector('input[name="triggerMode"]:checked')?.value || 'tap';
  const selectedTrans = document.querySelector('input[name="transitionStyle"]:checked')?.value || 'fade';
  settings.triggerMode = selectedMode;
  settings.transitionStyle = selectedTrans;
  settings.timerDuration = parseFloat(timerSlider.value) || 3.0;
  settings.colorSensitivity = parseInt(colorSensSlider.value, 10) || 3;
  saveSettings();
}
