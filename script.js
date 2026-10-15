/**
 * ONEPLUS 12R (OXYGENOS 14) AUTHENTIC CAMERA & SPECTRAL CARD REVEAL ENGINE
 * Pixel-Matched to OnePlus 12R Native Front Camera (Zero Crop 4:3 Sensor Match)
 */

// ============================================================================
// 1. GLOBAL STATE & CONFIGURATION
// ============================================================================
const SETTINGS_STORAGE_KEY = 'oneplus12r_camera_settings_v19';

const DEFAULT_SETTINGS = {
  triggerMode: 'timer',       // 'timer' | 'shutter' | 'volume'
  timerDuration: 10.0,        // 10.0s auto reveal from camera open
  transitionStyle: 'direct',  // 'direct' (instant card switch) | 'fade' (smooth)
  colorDirection: 'blue_card', // 'blue_card' (holding Blue card, shows Red -> reveals Blue) | 'red_card' (holding Red card, shows Blue -> reveals Red)
  colorSensitivity: 1.0,      // spectrum tolerance
  aspectRatioMode: '4:3',     // Native 4:3 uncropped OnePlus sensor
  volumeTrigger: true,
  shutterTrigger: true,
  doubleTapTrigger: false
};

let settings = loadSettings();

function getInitialAmount() {
  // In shader: 0.0 = Disguise Active, 1.0 = Real Card Revealed
  return 0.0;
}

function getRevealedAmount() {
  return 1.0;
}

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

// Transformation interpolation values (0.0 = Blue Card, 1.0 = Red Card)
let currentBlueAmount = 0.0;
let targetBlueAmount = 0.0;

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
let uCardModeLocation = null;
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

  // Fragment Shader: Oklab Perceptual Chromatic Engine with Specular Highlight Preservation
  const fsSource = `
    precision mediump float;
    varying vec2 v_texCoord;
    uniform sampler2D u_image;
    uniform float u_blueAmount;
    uniform float u_sensitivity;
    uniform int u_cardMode;

    // Fast, robust cube root for GLSL ES
    float cbrt_approx(float x) {
      if (x <= 0.0) return 0.0;
      return pow(x, 0.33333333);
    }

    // sRGB to Linear RGB
    vec3 srgb2linear(vec3 c) {
      return mix(
        c / 12.92,
        pow((c + 0.055) / 1.055, vec3(2.4)),
        step(0.04045, c)
      );
    }

    // Linear RGB to sRGB
    vec3 linear2srgb(vec3 c) {
      vec3 cl = clamp(c, 0.0, 1.0);
      return mix(
        cl * 12.92,
        1.055 * pow(max(cl, 0.00005), vec3(0.41666667)) - 0.055,
        step(0.0031308, cl)
      );
    }

    // Linear RGB to Oklab Perceptual Color Space (L, a, b)
    vec3 linear2oklab(vec3 c) {
      float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
      float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
      float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;

      float l_ = cbrt_approx(l);
      float m_ = cbrt_approx(m);
      float s_ = cbrt_approx(s);

      return vec3(
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
      );
    }

    // Oklab to Linear RGB
    vec3 oklab2linear(vec3 c) {
      float l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
      float m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
      float s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;

      float l = l_ * l_ * l_;
      float m = m_ * m_ * m_;
      float s = s_ * s_ * s_;

      return vec3(
        +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
      );
    }

    void main() {
      if (v_texCoord.x < 0.0 || v_texCoord.x > 1.0 || v_texCoord.y < 0.0 || v_texCoord.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }

      vec4 color = texture2D(u_image, v_texCoord);

      // Only transform when disguise is active (u_blueAmount < 0.999)
      if (u_blueAmount < 0.999) {
        vec3 linRgb = srgb2linear(color.rgb);
        vec3 oklab = linear2oklab(linRgb);

        float L = oklab.x;
        float a = oklab.y;
        float b = oklab.z;

        float chroma = sqrt(a * a + b * b);
        float hueRad = (chroma > 0.0001) ? atan(b, a) : 0.0;
        float hueDeg = degrees(hueRad);
        if (hueDeg < 0.0) hueDeg += 360.0;

        float mask = 0.0;
        vec2 targetDir = vec2(0.0);
        float targetChroma = 0.0;
        float targetL = L;

        if (u_cardMode == 0) {
          // ============================================================
          // MODE 0: PHYSICAL BLUE CARD IN HAND (SHOWS RED -> TURNS BLUE)
          // ============================================================
          // 1. Detect Bicycle Blue Ink (Centroid = 263.5°)
          float hueDiff = abs(hueDeg - 263.5);
          if (hueDiff > 180.0) hueDiff = 360.0 - hueDiff;
          float hueWeight = 1.0 - smoothstep(18.0 * u_sensitivity, 36.0 * u_sensitivity, hueDiff);

          // 2. Ink Chroma Threshold
          float chromaWeight = smoothstep(0.040 / u_sensitivity, 0.080, chroma);

          // 3. Minimum Lightness
          float lumWeight = smoothstep(0.07, 0.16, L);

          mask = hueWeight * chromaWeight * lumWeight;

          // Target: Bicycle Rider Back RED (Centroid = 27.0°)
          float targetRad = 0.4712; // radians(27.0°)
          targetDir = vec2(cos(targetRad), sin(targetRad));
          targetChroma = max(chroma * 1.15, 0.205);

          // Natural specular highlight preservation
          float highlightSheen = smoothstep(0.65, 0.94, L);
          targetChroma = mix(targetChroma, targetChroma * 0.40, highlightSheen);
          targetL = min(L * 1.16, 0.92);
        } else {
          // ============================================================
          // MODE 1: PHYSICAL RED CARD IN HAND (SHOWS BLUE -> TURNS RED)
          // ============================================================
          // 1. Detect Bicycle Red Ink (Centroid = 27.0°)
          float hueDiff = abs(hueDeg - 27.0);
          if (hueDiff > 180.0) hueDiff = 360.0 - hueDiff;
          float hueWeight = 1.0 - smoothstep(12.0 * u_sensitivity, 24.0 * u_sensitivity, hueDiff);

          // 2. Ink Chroma Threshold
          float chromaWeight = smoothstep(0.040 / u_sensitivity, 0.082, chroma);

          // 3. Minimum Lightness
          float lumWeight = smoothstep(0.08, 0.18, L);

          // 4. Skin Protection (Human skin in Oklab is 52° - 58°)
          float skinDist = abs(hueDeg - 55.0);
          float nonSkin = smoothstep(6.0, 14.0, skinDist);

          mask = hueWeight * chromaWeight * lumWeight * nonSkin;

          // Target: Bicycle Rider Back BLUE (Centroid = 263.5°)
          float targetRad = 4.5988; // radians(263.5°)
          targetDir = vec2(cos(targetRad), sin(targetRad));
          targetChroma = max(chroma * 1.12, 0.185);

          float highlightSheen = smoothstep(0.68, 0.95, L);
          targetChroma = mix(targetChroma, targetChroma * 0.45, highlightSheen);
          targetL = L * 0.96;
        }

        if (mask > 0.005) {
          vec2 targetAB = targetDir * targetChroma;
          vec3 transformedLin = oklab2linear(vec3(targetL, targetAB.x, targetAB.y));
          vec3 transformedSrgb = linear2srgb(transformedLin);

          // u_blueAmount: 0.0 = Disguise Active, 1.0 = Revealed Real Color
          float transformAmount = (1.0 - u_blueAmount) * mask;
          vec3 finalColor = mix(color.rgb, transformedSrgb, transformAmount);

          gl_FragColor = vec4(finalColor, color.a);
          return;
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
  uCardModeLocation = gl.getUniformLocation(shaderProgram, 'u_cardMode');
}

function createShaderProgram(gl, vs, fs) {
  const p = gl.createProgram();
  const v = gl.createShader(gl.VERTEX_SHADER);
  const f = gl.createShader(gl.FRAGMENT_SHADER);
  
  gl.shaderSource(v, vs);
  gl.compileShader(v);
  if (!gl.getShaderParameter(v, gl.COMPILE_STATUS)) {
    console.error('Vertex Shader Compile Error:', gl.getShaderInfoLog(v));
    return null;
  }

  gl.shaderSource(f, fs);
  gl.compileShader(f);
  if (!gl.getShaderParameter(f, gl.COMPILE_STATUS)) {
    console.error('Fragment Shader Compile Error:', gl.getShaderInfoLog(f));
    return null;
  }

  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('Shader Program Link Error:', gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

// ============================================================================
// 3. CAMERA STREAM (1:1 4:3 HARDWARE SENSOR MATCH)
// ============================================================================
async function startCameraStream() {
  if (isCameraRunning) return;

  try {
    let stream = null;
    try {
      // 1. Try high-definition 4:3 constraints
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: currentFacingMode },
          width: { ideal: 1920 },
          height: { ideal: 1440 }
        }
      });
    } catch (e1) {
      console.warn('High-res constraints rejected, falling back to standard facingMode:', e1);
      // 2. Fallback to basic facingMode if overconstrained
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: currentFacingMode }
      });
    }

    currentStream = stream;
    videoEl.srcObject = currentStream;
    await videoEl.play();

    cameraStarter.classList.add('hidden');
    isCameraRunning = true;
    appState = STATE.ARMED;
    currentBlueAmount = getInitialAmount();
    targetBlueAmount = getInitialAmount();
    armedStartTime = performance.now();

    requestAnimationFrame(renderLoop);
  } catch (err) {
    console.error('Camera stream error:', err);
    cameraStarter.classList.remove('hidden');
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
    gl.uniform1i(uCardModeLocation, settings.colorDirection === 'blue_card' ? 0 : 1);

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
  targetBlueAmount = getRevealedAmount();
  if (settings.transitionStyle === 'direct') {
    currentBlueAmount = targetBlueAmount;
  }
}

function resetCard() {
  if (cueDot) cueDot.style.opacity = '0.0';
  appState = STATE.ARMED;
  armedStartTime = performance.now();
  targetBlueAmount = getInitialAmount();
  currentBlueAmount = getInitialAmount();
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

  // Color Direction segmented buttons (Blue -> Red vs Red -> Blue)
  document.querySelectorAll('[data-direction]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-direction]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      settings.colorDirection = btn.dataset.direction;
      saveSettings();
      resetCard();
    });
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
    resetCard();
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

  document.querySelectorAll('[data-direction]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.direction === settings.colorDirection);
  });

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
