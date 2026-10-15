/**
 * GOOGLE CAMERA (GCAM) PWA - REAL-TIME CARD TRANSPOSITION
 * ============================================================================
 * Disguised 100% as the native Google Pixel Camera app.
 * Red Playing Cards seamlessly appear Bicycle Blue in real-time.
 * Finger SNAP instantly reverts card to Red!
 * Shutter Button takes a "photo" and silently re-arms the trick.
 */

const SETTINGS_STORAGE_KEY = 'gcam_camera_settings_v4';

const DEFAULT_SETTINGS = {
  triggerMode: 'audio',       // 'audio' (Finger snap) or 'timer' (Auto countdown)
  timerDuration: 3.0,         // Seconds
  snapSensitivity: 70,        // 30 to 95
  colorSensitivity: 3,        // 1 (strict) to 5 (lenient)
};

const STATE = {
  ARMED: 'armed',             // Red turns to Blue
  REVEALED: 'revealed'        // Red color restored
};

let appState = STATE.ARMED;
let settings = loadSettings();

// DOM Elements
const videoEl = document.getElementById('camera-feed');
const arCanvas = document.getElementById('ar-canvas');
const shutterFlash = document.getElementById('shutter-flash');
const focusReticle = document.getElementById('focus-reticle');
const cameraStarter = document.getElementById('camera-tap-starter');

// GCam Buttons
const shutterBtn = document.getElementById('shutter-btn');
const btnSettings = document.getElementById('btn-settings');
const btnDrawer = document.getElementById('btn-gcam-drawer');
const btnCloseSheet = document.getElementById('btn-close-sheet');
const btnSaveSheet = document.getElementById('btn-save-sheet');
const settingsSheet = document.getElementById('gcam-settings-modal');
const zoomBtns = document.querySelectorAll('.zoom-btn');

// Settings Elements
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

// Audio Variables
let audioContext = null;
let analyserNode = null;
let micSource = null;
let micDataArray = null;
let recentAverageVolume = 0;
let lastSnapTime = 0;

// WebGL Variables
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
let isCameraRunning = false;

// 2D Fallback
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

  // Try immediate auto-start
  startCameraStream();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js?v=4.0').then(reg => reg.update()).catch(() => {});
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
// 2. ADVANCED CHROMATIC SHADER (EXACT BICYCLE RIDER BACK BLUE)
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

  // Fragment Shader: Converts red ink into authentic Bicycle Rider Back Blue (#001b54 / #0a2568)
  // Perfectly preserves white angels, scrollwork, and rejects human skin!
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

      if (!u_revealed) {
        vec3 hsv = rgb2hsv(color.rgb);
        float h = hsv.x * 360.0;
        float s = hsv.y;
        float v = hsv.z;

        // 1. Strict Skin Exclusion:
        // In human skin, green is always substantial (G/R is 0.58 to 0.85).
        // In red card ink, G/R is very low (0.15 to 0.45).
        float greenRatio = color.g / max(0.01, color.r);
        bool isSkin = (greenRatio > 0.56) || (h >= 18.0 && h <= 45.0 && s < 0.55);

        // 2. Red Card Detection:
        bool isRedHue = (h >= 342.0 || h <= 17.0);
        float minSat = 0.40 - (u_sensitivity * 0.03);
        bool hasCardSat = (s >= minSat);
        bool redDominates = (color.r > color.g * 1.35) && (color.r > color.b * 1.35);

        if (!isSkin && isRedHue && hasCardSat && redDominates && v > 0.12) {
          // Authentic Bicycle Rider Back Navy Blue target
          // Ink: Rich deep navy (#051947 to #0b2975)
          float lum = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;

          // Preserve white pattern detail by scaling with lightness
          vec3 navyBlue = vec3(
            color.r * 0.02,
            color.g * 0.22,
            max(color.r * 0.85, 0.45)
          );

          // Smooth blending
          float blend = clamp((color.r - max(color.g, color.b) - 0.10) / 0.20, 0.0, 1.0);
          color.rgb = mix(color.rgb, navyBlue, blend);
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

  uRevealedLocation = gl.getUniformLocation(shaderProgram, 'u_revealed');
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
// 3. CAMERA & MICROPHONE STREAM
// ============================================================================
async function startCameraStream() {
  if (isCameraRunning) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true
    }).catch(async () => {
      // Audio might fail on some browsers without tap; get video first
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }
      });
    });

    videoEl.srcObject = stream;
    await videoEl.play();

    if (stream.getAudioTracks().length > 0) {
      setupAudioAnalyzer(stream);
    }

    cameraStarter.classList.add('hidden');
    isCameraRunning = true;
    appState = STATE.ARMED;
    armedStartTime = performance.now();

    requestAnimationFrame(renderLoop);
  } catch (err) {
    console.log('Awaiting user tap to start camera');
  }
}

function setupAudioAnalyzer(stream) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    audioContext = new AC();
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
  } catch (e) {}
}

function checkAudioSnapTrigger() {
  if (!analyserNode || !micDataArray) return;

  analyserNode.getByteFrequencyData(micDataArray);

  let sum = 0;
  for (let i = 0; i < micDataArray.length; i++) sum += micDataArray[i];
  const currentLevel = sum / micDataArray.length;

  if (!settingsSheet.classList.contains('hidden') && micMeterFill) {
    micMeterFill.style.width = `${Math.min(100, Math.round((currentLevel / 120) * 100))}%`;
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
// 4. RENDERING LOOP
// ============================================================================
function renderLoop() {
  requestAnimationFrame(renderLoop);

  checkAudioSnapTrigger();

  if (videoEl.readyState < videoEl.HAVE_CURRENT_DATA) return;

  const now = performance.now();

  if (settings.triggerMode === 'timer' && appState === STATE.ARMED) {
    if (!armedStartTime) armedStartTime = now;
    if ((now - armedStartTime) / 1000 >= settings.timerDuration) {
      triggerInstantReveal('⏱️ Auto Timer Expired');
    }
  }

  if (isWebGLSupported && gl && shaderProgram) {
    gl.useProgram(shaderProgram);
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);

    gl.uniform1i(uRevealedLocation, appState === STATE.REVEALED ? 1 : 0);
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
// 5. REVEAL & SHUTTER ACTIONS
// ============================================================================
function triggerInstantReveal(reason) {
  if (appState === STATE.REVEALED) return;

  appState = STATE.REVEALED;

  // Optical flash
  shutterFlash.classList.add('active');
  setTimeout(() => shutterFlash.classList.remove('active'), 65);

  if (navigator.vibrate) navigator.vibrate(40);
}

function handleShutterClick() {
  // Play subtle camera shutter feedback
  shutterFlash.classList.add('active');
  setTimeout(() => shutterFlash.classList.remove('active'), 80);

  if (navigator.vibrate) navigator.vibrate(30);

  // Silently re-arm the trick
  appState = STATE.ARMED;
  armedStartTime = performance.now();
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
    // Show focus ring
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
  radioPills.forEach(r => {
    r.addEventListener('change', (e) => {
      updateTriggerModeUI(e.target.value);
    });
  });

  timerSlider.addEventListener('input', (e) => {
    timerVal.textContent = `${parseFloat(e.target.value).toFixed(1)} s`;
  });

  snapSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    snapVal.textContent = val > 80 ? `High (${val})` : (val < 50 ? `Low (${val})` : `Medium (${val})`);
    if (micThresholdMark) micThresholdMark.style.left = `${100 - val}%`;
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
    audioSettingsGroup.classList.add('hidden');
  } else {
    timerSettingsGroup.classList.add('hidden');
    audioSettingsGroup.classList.remove('hidden');
  }
}

function applySettingsToUI() {
  radioPills.forEach(r => r.checked = (r.value === settings.triggerMode));
  updateTriggerModeUI(settings.triggerMode);

  timerSlider.value = settings.timerDuration;
  timerVal.textContent = `${parseFloat(settings.timerDuration).toFixed(1)} s`;

  snapSlider.value = settings.snapSensitivity;
  const sVal = settings.snapSensitivity;
  snapVal.textContent = sVal > 80 ? `High (${sVal})` : (sVal < 50 ? `Low (${sVal})` : `Medium (${sVal})`);
  if (micThresholdMark) micThresholdMark.style.left = `${100 - sVal}%`;

  colorSensSlider.value = settings.colorSensitivity;
  const labels = ['Strict', 'Medium-Strict', 'Balanced', 'Medium-Lenient', 'Lenient'];
  colorSensVal.textContent = labels[settings.colorSensitivity - 1] || 'Balanced';
}

function saveSettingsFromUI() {
  const selectedMode = document.querySelector('input[name="triggerMode"]:checked')?.value || 'audio';
  settings.triggerMode = selectedMode;
  settings.timerDuration = parseFloat(timerSlider.value) || 3.0;
  settings.snapSensitivity = parseInt(snapSlider.value, 10) || 70;
  settings.colorSensitivity = parseInt(colorSensSlider.value, 10) || 3;
  saveSettings();
}
