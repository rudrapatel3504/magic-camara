/**
 * GOOGLE CAMERA (GCAM) PWA - ADVANCED COLOR TRANSPOSITION
 * ============================================================================
 * Disguised 100% as the native Google Pixel Camera app.
 * Color Wheel & Color Picker: Pick EXACT color to detect and EXACT color to change to!
 * Supports REAR and FRONT (selfie) camera switching with natural mirroring.
 * Tap Shutter Button (or timer) to make color layer fade away / disappear.
 * Zero flash animations. Zero microphone/audio permissions.
 */

const SETTINGS_STORAGE_KEY = 'gcam_camera_settings_v7';

const DEFAULT_SETTINGS = {
  triggerMode: 'tap',          // 'tap' (Tap shutter/screen) or 'timer' (Auto countdown)
  transitionStyle: 'fade',     // 'fade' (Smooth fade away) or 'direct' (Instant cut)
  timerDuration: 3.0,          // Seconds
  colorSensitivity: 3,         // 1 (strict) to 5 (lenient)
  sourceColor: '#d81b1b',      // Exact color to detect (Default: Bicycle Red)
  targetColor: '#0a2265',      // Exact color to change it to (Default: Bicycle Navy Blue)
};

const STATE = {
  ARMED: 'armed',              // Color transposition active
  REVEALED: 'revealed'         // Color layer faded away (real color visible)
};

let appState = STATE.ARMED;
let settings = loadSettings();

// Camera facing mode: 'environment' (back) or 'user' (front)
let currentFacingMode = 'environment';
let currentStream = null;
let flipRotation = 0;

// Fade transition progress (1.0 = transposed color, 0.0 = original color)
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
const btnFlip = document.getElementById('btn-flip');
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

// Color Picker Elements
const pickerSourceColor = document.getElementById('picker-source-color');
const pickerTargetColor = document.getElementById('picker-target-color');
const sourceColorHex = document.getElementById('source-color-hex');
const targetColorHex = document.getElementById('target-color-hex');
const presetChips = document.querySelectorAll('.preset-chip');

// WebGL Variables
let gl = null;
let shaderProgram = null;
let videoTexture = null;
let positionBuffer = null;
let texCoordBuffer = null;
let uBlueAmountLocation = null;
let uSensitivityLocation = null;
let uSourceColorLocation = null;
let uTargetColorLocation = null;
let uVideoAspectLocation = null;
let uScreenAspectLocation = null;
let uIsFrontCameraLocation = null;
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

  startCameraStream();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js?v=7.0').then(reg => reg.update()).catch(() => {});
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

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const num = parseInt(h, 16);
  return [
    ((num >> 16) & 255) / 255.0,
    ((num >> 8) & 255) / 255.0,
    (num & 255) / 255.0
  ];
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
// 2. WEBGL REAL-TIME COLOR WHEEL & TRANSPOSITION SHADER
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
    uniform bool u_isFrontCamera;

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

      if (u_isFrontCamera) {
        coord.x = 1.0 - coord.x;
      }

      v_texCoord = coord;
    }
  `;

  // Fragment Shader: Matches exact source color on the color wheel and converts to exact target color
  const fsSource = `
    precision mediump float;
    varying vec2 v_texCoord;
    uniform sampler2D u_image;
    uniform float u_blueAmount;
    uniform float u_sensitivity;
    uniform vec3 u_sourceColor;
    uniform vec3 u_targetColor;

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
        vec3 pixelHsv = rgb2hsv(color.rgb);
        vec3 sourceHsv = rgb2hsv(u_sourceColor);

        // Angular distance on the color wheel (0° to 180°)
        float hueDiff = abs(pixelHsv.x - sourceHsv.x) * 360.0;
        if (hueDiff > 180.0) {
          hueDiff = 360.0 - hueDiff;
        }

        // Sensitivity tolerance: maps 1-5 to max allowed hue deviation
        float maxHueDiff = 14.0 + (u_sensitivity * 4.0);
        float minSat = max(0.20, sourceHsv.y * 0.55);

        bool isHueMatch = (hueDiff <= maxHueDiff);
        bool hasSat = (pixelHsv.y >= minSat);

        // Smart Skin Protection (if detecting red/orange hues, keep skin natural)
        bool sourceIsRedOrWarm = (sourceHsv.x * 360.0 <= 40.0 || sourceHsv.x * 360.0 >= 330.0);
        float greenRatio = color.g / max(0.01, color.r);
        bool isSkin = sourceIsRedOrWarm && ((greenRatio > 0.56) || (pixelHsv.x * 360.0 >= 18.0 && pixelHsv.x * 360.0 <= 45.0 && pixelHsv.y < 0.55));

        if (isHueMatch && hasSat && !isSkin && pixelHsv.z > 0.10) {
          // Preserve shading, specular highlights, and paper contrast:
          float pixelLum = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
          float targetLum = max(0.01, 0.299 * u_targetColor.r + 0.587 * u_targetColor.g + 0.114 * u_targetColor.b);

          // Scaled target matching the scene's natural lighting
          vec3 mappedTarget = u_targetColor * clamp(pixelLum / targetLum, 0.2, 2.2);

          // Smooth edge falloff around the color boundaries
          float blend = smoothstep(maxHueDiff, maxHueDiff * 0.35, hueDiff);
          vec3 finalColor = mix(color.rgb, mappedTarget, blend);

          // Fade or direct transition
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
  uSourceColorLocation = gl.getUniformLocation(shaderProgram, 'u_sourceColor');
  uTargetColorLocation = gl.getUniformLocation(shaderProgram, 'u_targetColor');
  uVideoAspectLocation = gl.getUniformLocation(shaderProgram, 'u_videoAspect');
  uScreenAspectLocation = gl.getUniformLocation(shaderProgram, 'u_screenAspect');
  uIsFrontCameraLocation = gl.getUniformLocation(shaderProgram, 'u_isFrontCamera');
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
// 3. CAMERA STREAM & FRONT/REAR TOGGLE
// ============================================================================
async function startCameraStream() {
  if (isCameraRunning) return;

  try {
    const constraints = {
      video: {
        facingMode: { ideal: currentFacingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    };

    currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    videoEl.srcObject = currentStream;
    await videoEl.play();

    cameraStarter.classList.add('hidden');
    isCameraRunning = true;
    appState = STATE.ARMED;
    currentBlueAmount = 1.0;
    targetBlueAmount = 1.0;
    armedStartTime = performance.now();

    requestAnimationFrame(renderLoop);
  } catch (err) {
    console.log('Camera error or awaiting user tap:', err);
  }
}

async function toggleCameraFlip() {
  flipRotation += 180;
  btnFlip.style.transform = `rotate(${flipRotation}deg)`;

  currentFacingMode = (currentFacingMode === 'environment') ? 'user' : 'environment';

  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop());
    currentStream = null;
  }

  isCameraRunning = false;
  await startCameraStream();
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

  if (settings.triggerMode === 'timer' && appState === STATE.ARMED) {
    if (!armedStartTime) armedStartTime = now;
    if ((now - armedStartTime) / 1000 >= settings.timerDuration) {
      triggerReveal();
    }
  }

  if (settings.transitionStyle === 'fade') {
    const fadeSpeed = 3.5;
    if (currentBlueAmount < targetBlueAmount) {
      currentBlueAmount = Math.min(targetBlueAmount, currentBlueAmount + dt * fadeSpeed);
    } else if (currentBlueAmount > targetBlueAmount) {
      currentBlueAmount = Math.max(targetBlueAmount, currentBlueAmount - dt * fadeSpeed);
    }
  } else {
    currentBlueAmount = targetBlueAmount;
  }

  if (isWebGLSupported && gl && shaderProgram) {
    gl.useProgram(shaderProgram);
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);

    gl.uniform1f(uBlueAmountLocation, currentBlueAmount);
    gl.uniform1f(uSensitivityLocation, settings.colorSensitivity);
    gl.uniform3fv(uSourceColorLocation, hexToRgb(settings.sourceColor));
    gl.uniform3fv(uTargetColorLocation, hexToRgb(settings.targetColor));
    gl.uniform1i(uIsFrontCameraLocation, currentFacingMode === 'user' ? 1 : 0);

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
// 5. REVEAL & SHUTTER ACTIONS
// ============================================================================
function triggerReveal() {
  if (appState === STATE.REVEALED) return;

  appState = STATE.REVEALED;
  targetBlueAmount = 0.0;

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
  if (appState === STATE.ARMED) {
    triggerReveal();
  } else {
    rearmTrick();
  }
}

// ============================================================================
// 6. GCAM UI & COLOR WHEEL PICKER INTERACTIONS
// ============================================================================
function initGCamUI() {
  cameraStarter.addEventListener('click', () => {
    startCameraStream();
  });

  // Shutter Button
  shutterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleShutterClick();
  });

  // Camera Flip Button
  btnFlip.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCameraFlip();
  });

  // Viewfinder focus reticle
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

  // Color Pickers Live Update
  pickerSourceColor.addEventListener('input', (e) => {
    sourceColorHex.textContent = e.target.value;
    settings.sourceColor = e.target.value;
    updateActiveChipState();
  });

  pickerTargetColor.addEventListener('input', (e) => {
    targetColorHex.textContent = e.target.value;
    settings.targetColor = e.target.value;
    updateActiveChipState();
  });

  // Preset Chips
  presetChips.forEach(chip => {
    chip.addEventListener('click', () => {
      const src = chip.dataset.src;
      const tgt = chip.dataset.tgt;
      pickerSourceColor.value = src;
      pickerTargetColor.value = tgt;
      sourceColorHex.textContent = src;
      targetColorHex.textContent = tgt;
      settings.sourceColor = src;
      settings.targetColor = tgt;

      presetChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });
  });
}

function updateActiveChipState() {
  presetChips.forEach(chip => {
    if (chip.dataset.src === settings.sourceColor && chip.dataset.tgt === settings.targetColor) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
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

  pickerSourceColor.value = settings.sourceColor;
  pickerTargetColor.value = settings.targetColor;
  sourceColorHex.textContent = settings.sourceColor;
  targetColorHex.textContent = settings.targetColor;

  updateActiveChipState();
}

function saveSettingsFromUI() {
  const selectedMode = document.querySelector('input[name="triggerMode"]:checked')?.value || 'tap';
  const selectedTrans = document.querySelector('input[name="transitionStyle"]:checked')?.value || 'fade';
  settings.triggerMode = selectedMode;
  settings.transitionStyle = selectedTrans;
  settings.timerDuration = parseFloat(timerSlider.value) || 3.0;
  settings.colorSensitivity = parseInt(colorSensSlider.value, 10) || 3;
  settings.sourceColor = pickerSourceColor.value;
  settings.targetColor = pickerTargetColor.value;
  saveSettings();
}
