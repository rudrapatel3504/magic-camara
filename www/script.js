/**
 * GOOGLE CAMERA (GCAM) PWA - ADVANCED COLOR TRANSPOSITION
 * ============================================================================
 * Disguised 100% as the native Google Pixel Camera app.
 * Color Wheel & Color Picker: Pick EXACT color to detect and EXACT color to change to!
 * Supports REAR and FRONT (selfie) camera switching with natural mirroring.
 * Tap Shutter Button (or timer) to make color layer fade away / disappear.
 * Zero flash animations. Zero microphone/audio permissions.
 */

const SETTINGS_STORAGE_KEY = 'gcam_camera_settings_v9';

const DEFAULT_SETTINGS = {
  triggerMode: 'tap',          // 'tap' (Tap shutter/screen) or 'timer' (Auto countdown)
  transitionStyle: 'fade',     // 'fade' (Smooth fade away) or 'direct' (Instant cut)
  aspectRatioMode: 'wide',     // 'wide' (Wide 4:3 Sensor - No Crop) or 'fill' (Full 16:9 Screen)
  timerDuration: 3.0,          // Seconds
  colorSensitivity: 3,         // 1 (strict) to 5 (lenient)
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
let currentZoom = 1.0;

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
const aspectRadios = document.querySelectorAll('input[name="aspectRatioMode"]');
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
let uUvScaleLocation = null;
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
    navigator.serviceWorker.register('sw.js?v=9.0').then(reg => reg.update()).catch(() => {});
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
    uniform vec2 u_uvScale;
    uniform bool u_isFrontCamera;

    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      vec2 coord = (a_texCoord - 0.5) * u_uvScale + 0.5;

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
          // Human skin (all skin types) has a high green-to-red ratio (typically g/r > 0.58)
          // and lower saturation (sat < 0.55), while card ink has low green (g/r < 0.40) and high sat.
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
            // Match the physical perceived luminance so all cherub lines, scrolls,
            // highlights, reflections, and shadow contours look 100% authentic.
            float originalLum = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
            float blueBaseLum = 0.299 * blueBase.r + 0.587 * blueBase.g + 0.114 * blueBase.b;
            float lumFactor = clamp(originalLum / max(0.01, blueBaseLum), 0.15, 2.3);

            vec3 correspondingBlue = blueBase * lumFactor;

            // Micro-tonal depth: maintain rich navy shadow in engraved grooves
            correspondingBlue = mix(correspondingBlue, correspondingBlue * vec3(0.92, 0.95, 1.06), clamp(1.0 - hsv.z, 0.0, 0.5));

            // Cleanly blend into frame
            vec3 blended = mix(color.rgb, correspondingBlue, mask);
            color.rgb = mix(color.rgb, blended, u_blueAmount);
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
// 3. CAMERA STREAM & FRONT/REAR TOGGLE
// ============================================================================
async function startCameraStream() {
  if (isCameraRunning) return;

  try {
    const isPortrait = window.innerHeight > window.innerWidth;
    const constraints = {
      video: {
        facingMode: { ideal: currentFacingMode },
        aspectRatio: { ideal: isPortrait ? (3 / 4) : (4 / 3) },
        width: { ideal: isPortrait ? 1440 : 1920, min: 640 },
        height: { ideal: isPortrait ? 1920 : 1440, min: 480 }
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

    // Check & apply camera track capabilities (e.g. wide angle/zoom)
    applyHardwareZoom(currentZoom);

    requestAnimationFrame(renderLoop);
  } catch (err) {
    console.log('Camera error or awaiting user tap:', err);
  }
}

function applyHardwareZoom(zoomLevel) {
  if (!currentStream) return;
  const [track] = currentStream.getVideoTracks();
  if (!track || !track.getCapabilities) return;
  try {
    const caps = track.getCapabilities();
    if (caps.zoom) {
      let targetHwZoom = 1.0;
      if (zoomLevel < 1.0) {
        targetHwZoom = caps.zoom.min || 1.0;
      } else if (Math.abs(zoomLevel - 1.0) < 0.05) {
        targetHwZoom = Math.max(caps.zoom.min, Math.min(caps.zoom.max, 1.0));
      } else {
        targetHwZoom = Math.min(caps.zoom.max, Math.max(caps.zoom.min, zoomLevel));
      }
      track.applyConstraints({ advanced: [{ zoom: targetHwZoom }] }).catch(() => {});
    }
  } catch (e) {}
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
    gl.uniform1i(uIsFrontCameraLocation, currentFacingMode === 'user' ? 1 : 0);

    const isPortrait = window.innerHeight > window.innerWidth;
    const vw = videoEl.videoWidth || (isPortrait ? 1440 : 1920);
    const vh = videoEl.videoHeight || (isPortrait ? 1920 : 1440);
    const cw = arCanvas.width;
    const ch = arCanvas.height;

    let uvScaleX = 1.0;
    let uvScaleY = 1.0;

    if (settings.aspectRatioMode === 'wide') {
      // Wide View (4:3 Full Sensor): Entire camera sensor fits with zero crop!
      const scale = Math.min(cw / vw, ch / vh);
      uvScaleX = cw / (vw * scale);
      uvScaleY = ch / (vh * scale);
    } else {
      // Full Screen Cover
      const scale = Math.max(cw / vw, ch / vh);
      uvScaleX = cw / (vw * scale);
      uvScaleY = ch / (vh * scale);
    }

    // Apply zoom factor (.6, 1x, 2x)
    uvScaleX /= currentZoom;
    uvScaleY /= currentZoom;

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
      e.stopPropagation();
      const z = parseFloat(btn.dataset.zoom) || 1.0;
      setZoom(z);
    });
  });

  // Aspect ratio framing controls
  aspectRadios.forEach(r => {
    r.addEventListener('change', (e) => {
      settings.aspectRatioMode = e.target.value;
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

function setZoom(z) {
  currentZoom = z;
  zoomBtns.forEach(b => {
    const val = parseFloat(b.dataset.zoom) || 1.0;
    if (Math.abs(val - z) < 0.05) {
      b.classList.add('active');
    } else {
      b.classList.remove('active');
    }
  });

  applyHardwareZoom(z);
}

function updateTriggerModeUI(mode) {
  if (mode === 'timer') {
    timerSettingsGroup.classList.remove('hidden');
  } else {
    timerSettingsGroup.classList.add('hidden');
  }
}

function applySettingsToUI() {
  aspectRadios.forEach(r => r.checked = (r.value === settings.aspectRatioMode));

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
  const selectedAspect = document.querySelector('input[name="aspectRatioMode"]:checked')?.value || 'wide';
  const selectedMode = document.querySelector('input[name="triggerMode"]:checked')?.value || 'tap';
  const selectedTrans = document.querySelector('input[name="transitionStyle"]:checked')?.value || 'fade';
  settings.aspectRatioMode = selectedAspect;
  settings.triggerMode = selectedMode;
  settings.transitionStyle = selectedTrans;
  settings.timerDuration = parseFloat(timerSlider.value) || 3.0;
  settings.colorSensitivity = parseInt(colorSensSlider.value, 10) || 3;
  saveSettings();
}
