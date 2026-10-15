# 🪄 Magic Camera PWA - Live Card Transposition

A mobile-first Progressive Web App (PWA) designed for magicians. When the rear camera detects a **Red Playing Card**, it overlays a **Blue Playing Card** seamlessly over it in real-time. Upon your command (a finger snap or a secret timer), the blue card instantly vanishes, revealing the red card underneath in the live camera feed.

---

## ✨ How the Magic Works

- **Normal Camera by Default**: When the app starts, it looks and behaves **100% like a normal camera**. There are **NO floating cards**, placeholders, or boxes on the screen.
- **Live Chromatic Transposition**: When you slide a real **Red Playing Card** into the camera frame, its red color turns into a rich **Sapphire Blue** in real-time. Hands, skin, table, and white borders remain completely natural!
- **Instant Snap Reveal**: The moment you **snap your fingers** (or the countdown timer elapses), the blue card on screen instantly turns back to its real **Red** color!
- **Instant Re-Arm**: Tap anywhere on the screen after the reveal to silently re-arm the trick for the next spectator.
- **Hardware-Accelerated 60 FPS WebGL**: Real-time chromatic transposition runs directly on the GPU with zero CPU stutter and strict skin-tone exclusion.
- **Hidden Magician Controls**:
  - **Secret Long-Press**: Press and hold the bottom-left corner of the screen for 1 second.
  - **Ghost Gear Icon**: A semi-transparent gear in the top-right corner that fades out after 3 seconds so spectators never see it.
  - **Live VU Meter**: Test and calibrate your finger snap sensitivity before performing in different venues.
  - **Quick Re-arm**: Tap the screen anytime after a reveal to instantly re-arm the trick for your next spectator.
- **Offline PWA**: Full `manifest.json` and Service Worker (`sw.js`). Can be installed via "Add to Home Screen" to run standalone without browser URL bars.

---

## 🃏 How to Swap Your Own Blue Card Image

### Method 1: In the Code (Permanent)
Open [`script.js`](script.js#L14-L16) and update the `DEFAULT_BLUE_CARD` constant:
```javascript
// Replace 'blue_card.svg' with your own image URL, relative path, or data URI
const DEFAULT_BLUE_CARD = 'my_blue_card.png';
```
Place your image file (e.g., `my_blue_card.png` or `my_blue_card.jpg`) in the same root directory.

### Method 2: Live In-App (No Code Changes)
1. Open the secret Settings menu (long-press bottom-left corner).
2. Under **Blue Card Image Source**, paste any web URL or image link.
3. Tap **Save & Close**.

---

## 🚀 How to Run & Test Locally

Modern browsers strictly require a secure context (**HTTPS** or **localhost**) to access the camera and microphone.

### Option A: Using Node.js (Quickest)
Run a local static server from this folder:
```bash
npx serve .
```
Or:
```bash
npx http-server -p 8080
```
Open `http://localhost:8080` in your browser.

### Option B: Using Python
```bash
python -m http.server 8080
```
Open `http://localhost:8080` in your browser.

---

## 🌐 Deploying to GitHub Pages (Free 1-Click Hosting)

1. Create a new repository on GitHub (e.g., `magic-camera`).
2. Upload all the files in this directory:
   - `index.html`
   - `style.css`
   - `script.js`
   - `blue_card.svg`
   - `manifest.json`
   - `sw.js`
   - `icons/`
3. In your GitHub repository:
   - Go to **Settings** > **Pages**.
   - Under **Build and deployment** > **Source**, choose **Deploy from a branch**.
   - Select branch: `main` (or `master`) and folder: `/ (root)`.
   - Click **Save**.
4. GitHub will give you an **`https://<your-username>.github.io/<repo-name>/`** link with free SSL enabled (mandatory for camera and microphone access on iPhone and Android).
5. Open this link on your phone, tap **Share** > **Add to Home Screen** (iOS) or **Install App** (Android) for the full standalone magic app experience!

---

## 🎩 Magician's Performance Routine Guide

1. **Setup**: Have a standard Red-backed card in your hand or on a dark mat/table.
2. **App Prep**: Open the app, press "Start Magic Camera". The gear icon will fade out after 3 seconds.
3. **The Lock**: Point the camera at the red card. The secret green dot in the top-left pulses, confirming the card is locked. On screen, the red card is seamlessly transformed into a blue-backed card!
4. **The Patter**: Tell the spectator: *"Watch the card closely. Notice its color."*
5. **The Snap**: Snap your fingers! The blue overlay instantly vanishes with an imperceptible micro-flash, revealing the real red card underneath.
6. **Re-arming**: While misdirecting the audience, subtly tap anywhere on the screen or the bottom banner to re-arm the trick for the next performance.
