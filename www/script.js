/**
 * ONEPLUS 12R (OXYGENOS 14) AUTHENTIC CAMERA & SPECTRAL CARD REVEAL ENGINE
 * Pixel-Matched to OnePlus 12R Native Front Camera (Zero Crop 4:3 Sensor Match)
 */

// ============================================================================
// 1. GLOBAL STATE & CONFIGURATION
// ============================================================================
const SETTINGS_STORAGE_KEY = 'oneplus12r_camera_settings_v12';

const DEFAULT_SETTINGS = {
  triggerMode: 'timer',       // 'timer' | 'shutter' | 'volume'
  timerDuration: 10.0,        // 10.0s auto reveal from camera open
  transitionStyle: 'direct',  // 'direct' (instant card switch) | 'fade' (smooth)
  colorSensitivity: 1.0,      // red spectrum tolerance
  aspectRatioMode: '4:3',     // Native 4:3 uncropped OnePlus sensor
  volumeTrigger: true,
  shutterTrigger: true,
  doubleTapTrigger: false
};

let settings = loadSettings();

const STATE = {
  INITIAL: 'initial',
  ARMED: 'armed',
  REVEALED: 'revealed'
};

let appState = STATE.INITIAL;
let currentFacingMode = 'user'; // Front Camera by default
let currentZoom = 1.0;          // 1.0x native optical hardware sensor
let flipRotation = 0;

let currentStream = null;
let isCameraRunning = false;
let armedStartTime = 0;
let lastFrameTime = performance.now();

// Transformation interpolation values
// 1.0 = Red Bicycle Card, 0.0 = Blue Bicycle Card
let currentBlueAmount = 1.0;
let targetBlueAmount = 1.0;

// DOM References
const videoEl = document.getElementById('camera-feed');
const arCanvas = document.getElementById('ar-canvas');
const vfContainer = document.getElementById('viewfinder-container');
const focusReticle = document.getElementById('focus-reticle');
const cueDot = document.getElementById('magician-cue-dot');
const cameraStarter = document.getElementById('camera-tap-starter');
const shutterBtn = document.getElementById('shutter-btn');
const btnFlip = document.getElementById('btn-flip');
const btnMenu = document.getElementById('btn-menu');
const settingsModal = document.getElementById('settings-modal');
const btnCloseSettings = document.getElementById('btn-close-settings');
const inputTimer = document.getElementById('input-timer-duration');
const valTimer = document.getElementById('val-timer');
const inputSens = document.getElementById('input-sensitivity');
const valSens = document.getElementById('val-sensitivity');
const btnManualReveal = document.getElementById('btn-manual-reveal');
const btnResetApp = document.getElementById('btn-reset-app');
const modeItems = document.querySelectorAll('.mode-item');

// WebGL Context & Locations
let gl = null;
let isWebGLSupported = true;
let shaderProgram = null;
let videoTexture = null;
let positionBuffer = null;
let texCoordBuffer = null;
let uBlueAmountLocation = null;
let uSensitivityLocation = null;
let uUvScaleLocation = null;
let uIsFrontCameraLocation = null;
let ctx2d = null;

// ============================================================================
// INITIALIZATION
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {
  initRenderer();
  handleResize();
  window.addEventListener('resize', handleResize);
  setupEventListeners();

  // Auto-start camera immediately
  startCameraStream();

  // Register service worker for instant PWA loading & offline capability
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js?v=12.0').then(reg => reg.update()).catch(() => {});
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
  const vf = vfContainer || document.getElementById('viewfinder-container');
  const rect = vf ? vf.getBoundingClientRect() : { width: window.innerWidth, height: window.innerWidth * 4 / 3 };

  arCanvas.width = Math.round(rect.width * dpr);
  arCanvas.height = Math.round(rect.height * dpr);

  if (gl) {
    gl.viewport(0, 0, arCanvas.width, arCanvas.height);
  }
}

// ============================================================================
// 2. WEBGL REAL-TIME SPECTRAL TRANSPOSITION SHADER
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
    uniform vec2 u_uvScale;
    uniform bool u_isFrontCamera;

    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      vec2 coord = (a_texCoord - 0.5) * u_uvScale + 0.5;

      // Natural OnePlus mirror effect for selfie camera
      if (u_isFrontCamera) {
        coord.x = 1.0 - coord.x;
      }

      v_texCoord = coord;
    }
  `;

  // Fragment Shader: Converts EVERY shade of red/orange/ruby/crimson directly to its corresponding shade of Bicycle Blue
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

    vec3 hsv2rgb(vec3 c) {
      vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
      vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }

    void main() {
      if (v_texCoord.x < 0.0 || v_texCoord.x > 1.0 || v_texCoord.y < 0.0 || v_texCoord.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }

      vec4 color = texture2D(u_image, v_texCoord);

      if (u_blueAmount > 0.001) {
        vec3 hsv = rgb2hsv(color.rgb);
        float hDeg = hsv.x * 360.0;
        // Signed hue centered around red (0°): [-180° to +180°]
        float signedHue = (hDeg > 180.0) ? (hDeg - 360.0) : hDeg;

        // Tolerance window: covers deep ruby/crimson (-35°) up to warm orange-red (+38°)
        float minHue = -35.0 - (u_sensitivity * 1.5);
        float maxHue = 38.0 + (u_sensitivity * 2.0);

        if (signedHue >= minHue && signedHue <= maxHue) {
          // 1. Ink Saturation Check (white borders & background have sat < 0.22, card ink has sat >= 0.40)
          float satWeight = smoothstep(0.22, 0.42, hsv.y);

          // 2. Minimum Value (protects pure blacks & deep shadows)
          float valWeight = smoothstep(0.08, 0.18, hsv.z);

          // 3. Red Channel Dominance (true red/orange card ink has R significantly higher than G and B)
          float redDom = color.r - max(color.g, color.b);
          float redDomWeight = smoothstep(0.08, 0.22, redDom);

          // 4. Skin Protection Filter:
          // Human skin has high green-to-red ratio (typically g/r > 0.54) and lower saturation,
          // while Bicycle card ink has low green (g/r < 0.40) and high sat.
          float greenRatio = color.g / max(0.01, color.r);
          float skinProb = 0.0;
          if (greenRatio > 0.54 && signedHue > 8.0) {
            skinProb = smoothstep(0.54, 0.72, greenRatio) * (1.0 - smoothstep(0.42, 0.65, hsv.y));
          } else if (greenRatio > 0.66) {
            skinProb = smoothstep(0.66, 0.82, greenRatio);
          }
          float nonSkin = 1.0 - clamp(skinProb, 0.0, 1.0);

          float mask = satWeight * valWeight * redDomWeight * nonSkin;

          if (mask > 0.01) {
            // MAP EVERY SHADE OF RED/ORANGE DIRECTLY TO ITS CORRESPONDING SHADE OF BLUE:
            // Crimson/ruby (-25°) maps to deep royal navy blue (~227°)
            // Pure red (0°) maps to classic Bicycle Rider Back blue (~222°)
            // Scarlet (+12°) maps to rich sapphire blue (~218°)
            // Orange-red (+35°) maps to vibrant cobalt blue (~211°)
            float targetHueDeg = 222.0 - (signedHue * 0.32);
            float targetHue = targetHueDeg / 360.0;

            // Target saturation preserves the card's original ink saturation & contrast
            float targetSat = clamp(hsv.y * 1.08, 0.72, 0.98);

            // Base blue corresponding tone
            vec3 blueBase = hsv2rgb(vec3(targetHue, targetSat, 1.0));

            // Optical Luminance Matching:
            // Match the physical perceived luminance so cherub lines, scrolls,
            // highlights, reflections, and shadow contours look 100% authentic.
            float originalLum = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
            vec3 blueCandidate = blueBase * (originalLum * 1.14);

            vec3 finalColor = mix(color.rgb, blueCandidate, mask * u_blueAmount);
            gl_FragColor = vec4(finalColor, color.a);
            return;
          }
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

  positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1.0, -1.0,   1.0, -1.0,  -1.0,  1.0,
    -1.0,  1.0,   1.0, -1.0,   1.0,  1.0,
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
  uUvScaleLocation = gl.getUniformLocation(shaderProgram, 'u_uvScale');
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
// 3. CAMERA STREAM (1:1 4:3 HARDWARE SENSOR MATCH)
// ============================================================================
async function startCameraStream() {
  if (isCameraRunning) return;

  try {
    const isPortrait = window.innerHeight > window.innerWidth;
    // Request native 4:3 hardware sensor resolution (Zero Crop on OnePlus 12R)
    const constraints = {
      video: {
        facingMode: { ideal: currentFacingMode },
        width: { ideal: 1920, max: 2560 },
        height: { ideal: 1440, max: 1920 },
        aspectRatio: { ideal: isPortrait ? (3 / 4) : (4 / 3) }
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
    console.log('Camera awaiting user interaction or permissions:', err);
  }
}

async function toggleCameraFlip() {
  flipRotation += 180;
  btnFlip.style.transform = `rotate(${flipRotation}deg)`;

  currentFacingMode = (currentFacingMode === 'user') ? 'environment' : 'user';

  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop());
    currentStream = null;
  }

  isCameraRunning = false;
  await startCameraStream();
}

// ============================================================================
// 4. RENDERING LOOP & ZERO-CROP OPTICAL SCALING
// ============================================================================
function renderLoop() {
  requestAnimationFrame(renderLoop);

  if (videoEl.readyState < videoEl.HAVE_CURRENT_DATA) return;

  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  // 10-Second Auto Reveal Trigger with Covert Magician 3-Second Cue
  if (settings.triggerMode === 'timer' && appState === STATE.ARMED) {
    if (!armedStartTime) armedStartTime = now;
    const elapsed = (now - armedStartTime) / 1000;
    const remaining = settings.timerDuration - elapsed;

    // Covert Magician Cue: pulses softly once per second in the last 3 seconds
    if (cueDot) {
      if (remaining <= 3.0 && remaining > 0.0) {
        const phase = (remaining % 1.0) < 0.5;
        cueDot.style.opacity = phase ? '0.85' : '0.0';
      } else {
        cueDot.style.opacity = '0.0';
      }
    }

    if (elapsed >= settings.timerDuration) {
      if (cueDot) cueDot.style.opacity = '0.0';
      triggerReveal();
    }
  } else if (cueDot) {
    cueDot.style.opacity = '0.0';
  }

  // Direct Cut vs Smooth Fade
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
    gl.uniform1i(uIsFrontCameraLocation, currentFacingMode === 'user' ? 1 : 0);

    const isPortrait = window.innerHeight > window.innerWidth;
    const vw = videoEl.videoWidth || 1080;
    const vh = videoEl.videoHeight || 1440;
    const cw = arCanvas.width;
    const ch = arCanvas.height;

    // Both canvas and OnePlus camera sensor are 3:4!
    const effectiveVideoRatio = (isPortrait && vw > vh) ? (vh / vw) : (vw / vh);
    const canvasRatio = cw / ch;

    let uvScaleX = 1.0;
    let uvScaleY = 1.0;

    if (effectiveVideoRatio > canvasRatio + 0.005) {
      uvScaleX = canvasRatio / effectiveVideoRatio;
    } else if (canvasRatio > effectiveVideoRatio + 0.005) {
      uvScaleY = effectiveVideoRatio / canvasRatio;
    }

    gl.uniform2f(uUvScaleLocation, uvScaleX, uvScaleY);

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
    ctx2d.drawImage(videoEl, 0, 0, arCanvas.width, arCanvas.height);
  }
}

// ============================================================================
// 5. REVEAL & SHUTTER ACTIONS
// ============================================================================
function triggerReveal() {
  if (cueDot) cueDot.style.opacity = '0.0';
  if (appState === STATE.REVEALED) return;
  appState = STATE.REVEALED;
  // Instantly cut card from red to blue
  targetBlueAmount = 0.0;
  if (settings.transitionStyle === 'direct') {
    currentBlueAmount = 0.0;
  }
}

function resetToRed() {
  if (cueDot) cueDot.style.opacity = '0.0';
  appState = STATE.ARMED;
  armedStartTime = performance.now();
  targetBlueAmount = 1.0;
  currentBlueAmount = 1.0;
}

// ============================================================================
// 6. ONEPLUS 12R CAMERA CONTROLS & LISTENERS
// ============================================================================
function setupEventListeners() {
  // Autoplay fallback overlay
  cameraStarter.addEventListener('click', () => {
    startCameraStream();
  });

  // Tap-to-Focus Reticle on Viewfinder
  vfContainer.addEventListener('click', (e) => {
    if (e.target.closest('.vf-floating-controls') || e.target.closest('.camera-starter-overlay')) return;
    const rect = vfContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    focusReticle.style.left = `${x}px`;
    focusReticle.style.top = `${y}px`;
    focusReticle.classList.remove('hidden');
    focusReticle.classList.remove('active');
    void focusReticle.offsetWidth; // trigger reflow
    focusReticle.classList.add('active');

    setTimeout(() => {
      focusReticle.classList.remove('active');
      setTimeout(() => focusReticle.classList.add('hidden'), 200);
    }, 1800);
  });

  // OnePlus Shutter Button
  shutterBtn.addEventListener('click', () => {
    if (navigator.vibrate) navigator.vibrate(12);

    if (settings.triggerMode === 'shutter') {
      triggerReveal();
    } else {
      // Shutter press animation
      shutterBtn.style.transform = 'scale(0.92)';
      setTimeout(() => shutterBtn.style.transform = 'scale(1)', 100);
    }
  });

  // Long press shutter button opens disguised settings
  let shutterPressTimer = null;
  shutterBtn.addEventListener('touchstart', () => {
    shutterPressTimer = setTimeout(() => {
      openSettingsModal();
    }, 700);
  });
  shutterBtn.addEventListener('touchend', () => clearTimeout(shutterPressTimer));
  shutterBtn.addEventListener('touchcancel', () => clearTimeout(shutterPressTimer));

  // Switch Camera Flip Button
  btnFlip.addEventListener('click', (e) => {
    e.stopPropagation();
    if (navigator.vibrate) navigator.vibrate(10);
    toggleCameraFlip();
  });

  // Top Bar Controls
  document.getElementById('btn-flash').addEventListener('click', () => {
    if (navigator.vibrate) navigator.vibrate(8);
  });

  document.getElementById('btn-ev').addEventListener('click', () => {
    if (navigator.vibrate) navigator.vibrate(8);
  });

  document.getElementById('btn-live-color').addEventListener('click', () => {
    if (navigator.vibrate) navigator.vibrate(8);
  });

  // Hamburger Menu opens settings
  btnMenu.addEventListener('click', () => {
    openSettingsModal();
  });

  // Floating Right Buttons
  ['btn-master', 'btn-filters', 'btn-retouch'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => {
      if (navigator.vibrate) navigator.vibrate(8);
    });
  });

  // Mode Carousel items
  modeItems.forEach(item => {
    item.addEventListener('click', () => {
      modeItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      if (navigator.vibrate) navigator.vibrate(12);
    });
  });

  // Settings Modal Controls
  btnCloseSettings.addEventListener('click', closeSettingsModal);
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsModal();
  });

  // Reveal Trigger segmented buttons
  document.querySelectorAll('[data-trigger]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-trigger]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      settings.triggerMode = btn.dataset.trigger;
      saveSettings();
    });
  });

  // Transition style segmented buttons
  document.querySelectorAll('[data-transition]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-transition]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      settings.transitionStyle = btn.dataset.transition;
      saveSettings();
    });
  });

  // Timer duration slider
  inputTimer.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    settings.timerDuration = val;
    valTimer.textContent = `${val.toFixed(1)}s`;
    saveSettings();
  });

  // Sensitivity slider
  inputSens.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    settings.colorSensitivity = val;
    valSens.textContent = `${val.toFixed(1)}x`;
    saveSettings();
  });

  // Manual test trigger & reset
  btnManualReveal.addEventListener('click', () => {
    triggerReveal();
    closeSettingsModal();
  });

  btnResetApp.addEventListener('click', () => {
    resetToRed();
    closeSettingsModal();
  });

  // Hardware Volume Keys reveal
  window.addEventListener('keydown', (e) => {
    if (settings.triggerMode === 'volume' && (e.key === 'VolumeDown' || e.key === 'VolumeUp')) {
      e.preventDefault();
      triggerReveal();
    }
  });
}

function openSettingsModal() {
  if (navigator.vibrate) navigator.vibrate(15);
  // Sync UI with current settings
  inputTimer.value = settings.timerDuration;
  valTimer.textContent = `${settings.timerDuration.toFixed(1)}s`;
  inputSens.value = settings.colorSensitivity;
  valSens.textContent = `${settings.colorSensitivity.toFixed(1)}x`;

  document.querySelectorAll('[data-trigger]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.trigger === settings.triggerMode);
  });

  document.querySelectorAll('[data-transition]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.transition === settings.transitionStyle);
  });

  settingsModal.classList.remove('hidden');
}

function closeSettingsModal() {
  settingsModal.classList.add('hidden');
}
