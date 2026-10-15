/**
 * MAGIC CAMERA PWA - LIVE CARD TRANSPOSITION ENGINE
 * ============================================================================
 * Acts like a 100% normal camera.
 * When a RED card is slid into view, its red color turns BLUE in real-time.
 * When you SNAP your fingers, the blue color instantly turns back to RED!
 * NO floating card in the middle of the screen.
 */

// ============================================================================
// 1. CONFIGURATION & SETTINGS
// ============================================================================
// >>> OPTIONAL: SWAP YOUR BLUE CARD IMAGE HERE <<<
const DEFAULT_BLUE_CARD = 'blue_card.svg';
const SETTINGS_STORAGE_KEY = 'magic_camera_trick_settings_v2';

const DEFAULT_SETTINGS = {
  triggerMode: 'audio',       // 'audio' (Finger snap) or 'timer' (Auto countdown)
  visualEffect: 'colorShift', // 'colorShift' (Seamless Red->Blue) or 'overlay' (Image overlay)
  timerDuration: 3.0,         // Seconds (2 to 10)
  snapSensitivity: 70,        // 30 to 95 (higher = easier to trigger)
  colorSensitivity: 3,        // 1 (strict red) to 5 (lenient red)
  customCardUrl: '',          // Custom image URL if user specifies in settings
};

// Application State
const STATE = {
  IDLE: 'idle',               // Normal camera view
  ARMED: 'armed',             // Red card turns to Blue
  REVEALED: 'revealed'        // Instant reveal triggered (Red visible)
};

let appState = STATE.ARMED; // Start ready to turn red card into blue
let settings = loadSettings();

// DOM Elements
const videoEl = document.getElementById('camera-feed');
const arCanvas = document.getElementById('ar-canvas');
const statusIndicator = document.getElementById('status-indicator');
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
const cardPreviewImg = document.getElementById('card-preview-img');
const cardUrlInput = document.getElementById('card-url-input');
const btnResetCardUrl = document.getElementById('btn-reset-card-url');

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

// 2D Canvas Fallback Context (if WebGL unavailable)
let ctx2d = null;

// Card Image Object
const blueCardImg = new Image();
blueCardImg.crossOrigin = 'anonymous';
updateBlueCardSource();

// Tracking timers
let cardPresentStartTime = 0;
let redPixelsDetectedCount = 0;
let gearFadeTimer = null;

// ============================================================================
// 2. INITIALIZATION & LIFECYCLE
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {
  initUIListeners();
  applySettingsToUI();
  initRenderer();
  handleResize();
  window.addEventListener('resize', handleResize);
  window.addEventListener('orientationchange', handleResize);

  resetGearFade();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('Service Worker registration skipped:', err);
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
    console.warn('Failed to parse settings:', e);
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

function updateBlueCardSource() {
  const src = settings.customCardUrl && settings.customCardUrl.trim() !== '' 
    ? settings.customCardUrl.trim() 
    : DEFAULT_BLUE_CARD;
  blueCardImg.src = src;
  if (cardPreviewImg) {
    cardPreviewImg.src = src;
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
// 3. WEBGL SHADER PIPELINE (60FPS LIVE COLOR TRANSPOSITION)
// ============================================================================
function initRenderer() {
  try {
    gl = arCanvas.getContext('webgl', { alpha: false, depth: false, antialias: false, preserveDrawingBuffer: false }) ||
         arCanvas.getContext('experimental-webgl');
  } catch (e) {
    gl = null;
  }

  if (!gl) {
    console.warn('WebGL not supported, falling back to 2D canvas');
    isWebGLSupported = false;
    ctx2d = arCanvas.getContext('2d');
    return;
  }

  // Vertex Shader: Maps video quad with object-fit: cover scaling
  const vsSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    varying vec2 v_texCoord;
    uniform float u_videoAspect;
    uniform float u_screenAspect;

    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      
      // Calculate object-fit: cover texture coordinate mapping
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

  // Fragment Shader: Converts true red card ink into sapphire royal blue
  // Human skin and background are strictly preserved as normal
  const fsSource = `
    precision mediump float;
    varying vec2 v_texCoord;
    uniform sampler2D u_image;
    uniform bool u_revealed;
    uniform float u_sensitivity;

    // Convert RGB to HSV for precise chromatic thresholding
    vec3 rgb2hsv(vec3 c) {
      vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
      vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
      vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));

      float d = q.x - min(q.w, q.y);
      float e = 1.0e-10;
      return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
    }

    void main() {
      // Discard coordinates outside video bounds if letterboxed
      if (v_texCoord.x < 0.0 || v_texCoord.x > 1.0 || v_texCoord.y < 0.0 || v_texCoord.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }

      vec4 color = texture2D(u_image, v_texCoord);

      // If trick is armed (not revealed), transform red card ink to blue
      if (!u_revealed) {
        vec3 hsv = rgb2hsv(color.rgb);
        float h = hsv.x * 360.0;
        float s = hsv.y;
        float v = hsv.z;

        // Sensitivity adjustment (slider 1 to 5, normalized around 3)
        float minSat = 0.52 - (u_sensitivity * 0.04);
        float minDiff = 0.16 - (u_sensitivity * 0.02);

        // Strict Red Playing Card Ink Criteria:
        // 1. Hue is centered on red (0° or 360° ± 14°)
        // 2. High saturation (card ink is vivid; skin tone is pale/low saturation 0.20-0.38)
        // 3. R strongly dominates G and B
        bool isRedHue = (h >= 346.0 || h <= 14.0);
        bool hasCardSaturation = s >= minSat;
        bool isDominantRed = (color.r > color.g * 1.50) && 
                             (color.r > color.b * 1.50) && 
                             ((color.r - max(color.g, color.b)) > minDiff);

        if (isRedHue && hasCardSaturation && isDominantRed && v > 0.15) {
          // Transform Red into Deep Royal / Sapphire Blue
          // Preserves card pattern contrast, shadow, and highlights
          float rOrig = color.r;
          float gOrig = color.g;
          float bOrig = color.b;

          color.r = rOrig * 0.08;
          color.g = gOrig * 0.35 + (rOrig * 0.05);
          color.b = clamp(rOrig * 1.05 + bOrig * 0.25, 0.0, 1.0);
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

  // Set up screen-aligned full quad
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

  // In WebGL, textures from video elements usually have (0,0) at top-left
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

  // Setup video texture
  videoTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, videoTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // Uniform locations
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
// 4. CAMERA & MICROPHONE STREAM INITIALIZATION
// ============================================================================
btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  btnStart.textContent = 'Starting Camera...';
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
        console.warn('Microphone permission denied, using timer mode');
        settings.triggerMode = 'timer';
        saveSettings();
        applySettingsToUI();
      }
    }

    videoEl.srcObject = stream;
    await videoEl.play();

    // Setup Web Audio API for Finger Snap
    if (stream.getAudioTracks().length > 0) {
      setupAudioAnalyzer(stream);
    }

    // Hide Start Screen: Now it's a completely normal live camera!
    startOverlay.classList.add('hidden');

    // Armed and ready for the magic trick
    appState = STATE.ARMED;
    updateStatusDot();

    // Start 60fps Render Loop
    requestAnimationFrame(renderLoop);

  } catch (err) {
    console.error('Camera permission/init error:', err);
    permError.textContent = `Error: ${err.message || 'Camera permission denied or camera not found.'}`;
    permError.classList.remove('hidden');
    btnStart.disabled = false;
    btnStart.textContent = 'Retry Camera Access';
  }
});

// ============================================================================
// 5. AUDIO SNAP DETECTION ENGINE (WEB AUDIO API)
// ============================================================================
function setupAudioAnalyzer(stream) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    audioContext = new AudioContextClass();
    micSource = audioContext.createMediaStreamSource(stream);

    // Highpass filter: finger snap acoustic impulse is prominent above 1.4 kHz
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
  const currentLevel = sum / micDataArray.length; // Range: 0 to 255

  // Update live meter in settings modal (if open)
  if (!settingsModal.classList.contains('hidden') && micMeterFill) {
    const percent = Math.min(100, Math.round((currentLevel / 120) * 100));
    micMeterFill.style.width = `${percent}%`;
  }

  // Dynamic ambient room noise tracking
  recentAverageVolume = (recentAverageVolume * 0.92) + (currentLevel * 0.08);

  const now = performance.now();
  const dynamicThreshold = 25 + (100 - settings.snapSensitivity) * 0.7;
  const spikeDelta = currentLevel - recentAverageVolume;

  // Trigger reveal when snap detected while armed
  if (settings.triggerMode === 'audio' && appState === STATE.ARMED) {
    if (currentLevel > dynamicThreshold && spikeDelta > 18 && (now - lastSnapTime > 800)) {
      lastSnapTime = now;
      triggerInstantReveal('🎙️ Finger Snap Detected');
    }
  }
}

// ============================================================================
// 6. REAL-TIME 60FPS RENDERING LOOP
// ============================================================================
function renderLoop() {
  requestAnimationFrame(renderLoop);

  // Monitor audio in background
  checkAudioSnapTrigger();

  if (videoEl.readyState < videoEl.HAVE_CURRENT_DATA) return;

  const now = performance.now();

  // If in timer mode and armed, count down once camera is rolling
  if (settings.triggerMode === 'timer' && appState === STATE.ARMED) {
    if (!cardPresentStartTime) {
      cardPresentStartTime = now;
    }
    const elapsed = (now - cardPresentStartTime) / 1000;
    if (elapsed >= settings.timerDuration) {
      triggerInstantReveal(`⏱️ Timer Finished (${settings.timerDuration}s)`);
    }
  }

  // 1. WebGL Hardware-Accelerated Color Transposition
  if (isWebGLSupported && gl && shaderProgram) {
    renderWebGLFrame();
  } else if (ctx2d) {
    // 2. 2D Fallback
    render2DFallbackFrame();
  }
}

function renderWebGLFrame() {
  gl.useProgram(shaderProgram);

  // Upload live video frame into GPU texture
  gl.bindTexture(gl.TEXTURE_2D, videoTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);

  // Set Uniforms
  const isRevealed = (appState === STATE.REVEALED);
  gl.uniform1i(uRevealedLocation, isRevealed ? 1 : 0);
  gl.uniform1f(uSensitivityLocation, settings.colorSensitivity);

  const videoAspect = (videoEl.videoWidth || 1280) / (videoEl.videoHeight || 720);
  const screenAspect = window.innerWidth / window.innerHeight;
  gl.uniform1f(uVideoAspectLocation, videoAspect);
  gl.uniform1f(uScreenAspectLocation, screenAspect);

  // Bind Buffers
  const aPositionLocation = gl.getAttribLocation(shaderProgram, 'a_position');
  gl.enableVertexAttribArray(aPositionLocation);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.vertexAttribPointer(aPositionLocation, 2, gl.FLOAT, false, 0, 0);

  const aTexCoordLocation = gl.getAttribLocation(shaderProgram, 'a_texCoord');
  gl.enableVertexAttribArray(aTexCoordLocation);
  gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
  gl.vertexAttribPointer(aTexCoordLocation, 2, gl.FLOAT, false, 0, 0);

  // Draw full-screen quad
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function render2DFallbackFrame() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx2d.drawImage(videoEl, 0, 0, w, h);
}

// ============================================================================
// 7. THE "REVEAL" MOMENT (MAGIC INSTANT REMOVAL)
// ============================================================================
function triggerInstantReveal(reason) {
  if (appState === STATE.REVEALED) return;

  console.log(`✨ MAGIC REVEAL TRIGGERED: ${reason}`);

  // Instantly flip state so red card shows on screen
  appState = STATE.REVEALED;
  updateStatusDot();

  // Subtle 60ms white optical flash to accentuate the instant change
  revealFlash.classList.add('active');
  setTimeout(() => {
    revealFlash.classList.remove('active');
  }, 65);

  // Show unobtrusive re-arm banner so magician can repeat trick
  rearmOverlay.classList.remove('hidden');
}

/**
 * Re-arms the trick: red card will appear blue again
 */
function rearmTrick() {
  appState = STATE.ARMED;
  cardPresentStartTime = 0;
  updateStatusDot();
  rearmOverlay.classList.add('hidden');
}

function updateStatusDot() {
  if (appState === STATE.ARMED) {
    statusIndicator.classList.remove('hidden');
  } else {
    statusIndicator.classList.add('hidden');
  }
}

// ============================================================================
// 8. SECRET SETTINGS & MAGICIAN CONTROLS
// ============================================================================
function initUIListeners() {
  // Secret Long-Press (Bottom-Left Corner): Press & hold 1s to open settings
  let secretPressTimer = null;

  secretZone.addEventListener('touchstart', (e) => {
    secretPressTimer = setTimeout(() => {
      openSettingsModal();
      if (navigator.vibrate) navigator.vibrate(50);
    }, 900);
  }, { passive: true });

  secretZone.addEventListener('touchend', () => {
    clearTimeout(secretPressTimer);
  });
  secretZone.addEventListener('touchcancel', () => {
    clearTimeout(secretPressTimer);
  });

  // Desktop contextmenu fallback
  secretZone.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openSettingsModal();
  });

  // Gear Button: Fades out after 3s, tap brings it back
  gearBtn.addEventListener('click', () => {
    openSettingsModal();
  });

  document.addEventListener('pointerdown', (e) => {
    // Tap near top-right corner wakes up gear icon
    if (e.clientX > window.innerWidth - 80 && e.clientY < 80) {
      resetGearFade();
    }

    // Tap anywhere on screen while revealed instantly re-arms
    if (appState === STATE.REVEALED && !e.target.closest('#settings-modal')) {
      rearmTrick();
    }
  });

  // Re-arm banner tap
  rearmOverlay.addEventListener('click', () => {
    rearmTrick();
  });

  // Modal Close buttons
  btnCloseSettingsX.addEventListener('click', closeSettingsModal);
  btnSaveSettings.addEventListener('click', saveAndApplySettings);
  btnRearmTrick.addEventListener('click', () => {
    rearmTrick();
    closeSettingsModal();
  });

  // Trigger Mode Radio Pills
  radioPills.forEach(radio => {
    radio.addEventListener('change', (e) => {
      updateTriggerModeUI(e.target.value);
    });
  });

  // Timer Duration Slider
  timerSlider.addEventListener('input', (e) => {
    timerVal.textContent = `${parseFloat(e.target.value).toFixed(1)} s`;
  });

  // Snap Sensitivity Slider
  snapSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    snapVal.textContent = val > 80 ? `High (${val})` : (val < 50 ? `Low (${val})` : `Medium (${val})`);
    if (micThresholdMark) {
      micThresholdMark.style.left = `${100 - val}%`;
    }
  });

  // Color Sensitivity Slider
  colorSensSlider.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    const labels = ['Strict', 'Medium-Strict', 'Balanced', 'Medium-Lenient', 'Lenient'];
    colorSensVal.textContent = labels[v - 1] || 'Balanced';
  });

  btnResetCardUrl.addEventListener('click', () => {
    cardUrlInput.value = '';
    cardPreviewImg.src = DEFAULT_BLUE_CARD;
  });

  cardUrlInput.addEventListener('change', () => {
    const url = cardUrlInput.value.trim();
    if (url) {
      cardPreviewImg.src = url;
    } else {
      cardPreviewImg.src = DEFAULT_BLUE_CARD;
    }
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

  cardUrlInput.value = settings.customCardUrl || '';
  cardPreviewImg.src = (settings.customCardUrl && settings.customCardUrl.trim()) 
    ? settings.customCardUrl.trim() 
    : DEFAULT_BLUE_CARD;
}

function saveAndApplySettings() {
  const selectedMode = document.querySelector('input[name="triggerMode"]:checked')?.value || 'audio';
  settings.triggerMode = selectedMode;
  settings.timerDuration = parseFloat(timerSlider.value) || 3.0;
  settings.snapSensitivity = parseInt(snapSlider.value, 10) || 70;
  settings.colorSensitivity = parseInt(colorSensSlider.value, 10) || 3;
  settings.customCardUrl = cardUrlInput.value.trim();

  saveSettings();
  updateBlueCardSource();
  closeSettingsModal();
}
