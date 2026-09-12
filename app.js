'use strict';

/* =====================================================
   Utilities
===================================================== */
const $ = (sel) => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 700;

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/* =====================================================
   DOM references
===================================================== */
const video = $('#video');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const cameraFrame = $('#cameraFrame');
const cameraEmpty = $('#cameraEmpty');
const cameraEmptySub = $('#cameraEmptySub');
const startCameraBtn = $('#startCameraBtn');
const cameraToggleBtn = $('#cameraToggleBtn');
const statusDot = $('#statusDot');
const statusLabel = $('#statusLabel');
const handsChip = $('#handsChip');
const gestureToast = $('#gestureToast');
const installBtn = $('#installBtn');

const artEl = $('#art');
const trackTitleEl = $('#trackTitle');
const trackArtistEl = $('#trackArtist');
const likeBtn = $('#likeBtn');
const seek = $('#seek');
const timeCurrent = $('#timeCurrent');
const timeTotal = $('#timeTotal');
const playBtn = $('#playBtn');
const playIcon = $('#playIcon');
const prevBtn = $('#prevBtn');
const nextBtn = $('#nextBtn');
const shuffleBtn = $('#shuffleBtn');
const repeatBtn = $('#repeatBtn');
const muteBtn = $('#muteBtn');
const muteIcon = $('#muteIcon');
const volume = $('#volume');
const volumeValue = $('#volumeValue');
const fileInput = $('#fileInput');
const playlistEl = $('#playlist');
const playlistEmpty = $('#playlistEmpty');
const visualizerCanvas = $('#visualizer');
const vctx = visualizerCanvas.getContext('2d');
const vizTabs = document.querySelectorAll('.viz-tab');

/* =====================================================
   Audio engine
===================================================== */
const audio = new Audio();
audio.preload = 'metadata';
audio.volume = 0.8;

/** @type {{id:number,name:string,artist:string,url:string,duration:number,liked:boolean}[]} */
let playlist = [];
let currentIndex = -1;
let isShuffle = false;
let isRepeatAll = false;
let isSeeking = false;
let nextTrackId = 1;

let audioCtx = null;
let analyser = null;
let dataArray = null;
let audioGraphReady = false;
let vizMode = 'bars';

function ensureAudioGraph() {
  if (audioGraphReady) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    const source = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
    dataArray = new Uint8Array(analyser.frequencyBinCount);
    audioGraphReady = true;
    requestAnimationFrame(drawVisualizer);
  } catch (err) {
    console.warn('Visualizer unavailable:', err);
  }
}

// Autoplay policies require a genuine user gesture before audio can be
// started programmatically. We piggyback on the very first real tap/click
// anywhere in the app to "unlock" the <audio> element and AudioContext, so
// that later hand-gesture-triggered play() calls are allowed to proceed.
let audioUnlocked = false;
function unlockAudioOnce() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  ensureAudioGraph();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  const silentAttempt = audio.play();
  if (silentAttempt && silentAttempt.then) {
    silentAttempt.then(() => audio.pause()).catch(() => { /* fine, no track loaded yet */ });
  }
  document.removeEventListener('pointerdown', unlockAudioOnce);
  document.removeEventListener('keydown', unlockAudioOnce);
}
document.addEventListener('pointerdown', unlockAudioOnce, { once: true });
document.addEventListener('keydown', unlockAudioOnce, { once: true });

function renderPlaylist() {
  playlistEl.innerHTML = '';
  if (playlist.length === 0) {
    playlistEl.appendChild(playlistEmpty);
    return;
  }
  playlist.forEach((track, i) => {
    const li = document.createElement('li');
    li.className = 'track-row' + (i === currentIndex ? ' is-current' : '');
    li.setAttribute('role', 'button');
    li.tabIndex = 0;
    li.innerHTML = `
      <span class="idx">${i === currentIndex && !audio.paused ? '♪' : i + 1}</span>
      <span class="row-meta">
        <p class="row-title"></p>
        <p class="row-sub"></p>
      </span>
      <span class="row-dur">${formatTime(track.duration)}</span>
      <button class="row-remove" type="button" aria-label="Remove ${track.name}">
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    `;
    li.querySelector('.row-title').textContent = track.liked ? `♥ ${track.name}` : track.name;
    li.querySelector('.row-sub').textContent = track.artist;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.row-remove')) return;
      playTrack(i);
    });
    li.querySelector('.row-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeTrack(i);
    });
    playlistEl.appendChild(li);
  });
}

function removeTrack(i) {
  const wasCurrent = i === currentIndex;
  URL.revokeObjectURL(playlist[i].url);
  playlist.splice(i, 1);
  if (playlist.length === 0) {
    currentIndex = -1;
    audio.pause();
    audio.removeAttribute('src');
    updateNowPlaying(null);
  } else if (wasCurrent) {
    currentIndex = clamp(i, 0, playlist.length - 1);
    loadTrack(currentIndex, false);
  } else if (i < currentIndex) {
    currentIndex -= 1;
  }
  renderPlaylist();
}

function updateNowPlaying(track) {
  if (!track) {
    trackTitleEl.textContent = 'No track loaded';
    trackArtistEl.textContent = 'Import audio to get started';
    likeBtn.setAttribute('aria-pressed', 'false');
    return;
  }
  trackTitleEl.textContent = track.name;
  trackArtistEl.textContent = track.artist;
  likeBtn.setAttribute('aria-pressed', String(!!track.liked));
}

function loadTrack(index, autoplay) {
  if (index < 0 || index >= playlist.length) return;
  currentIndex = index;
  const track = playlist[index];
  audio.src = track.url;
  updateNowPlaying(track);
  renderPlaylist();
  if (autoplay) {
    ensureAudioGraph();
    audio.play().catch(() => showGestureToast('Tap play once to enable audio'));
  }
}

function playTrack(index) {
  loadTrack(index, true);
}

function togglePlay() {
  if (playlist.length === 0) return;
  if (currentIndex === -1) {
    playTrack(0);
    return;
  }
  ensureAudioGraph();
  if (audio.paused) {
    audio.play().catch(() => showGestureToast('Tap play once to enable audio'));
  } else {
    audio.pause();
  }
}

function pickNextIndex(direction) {
  if (playlist.length === 0) return -1;
  if (isShuffle) {
    if (playlist.length === 1) return 0;
    let r;
    do { r = Math.floor(Math.random() * playlist.length); } while (r === currentIndex);
    return r;
  }
  let next = currentIndex + direction;
  if (next >= playlist.length) next = isRepeatAll ? 0 : playlist.length - 1;
  if (next < 0) next = isRepeatAll ? playlist.length - 1 : 0;
  return next;
}

function next(auto) {
  if (playlist.length === 0) return;
  if (auto && !isRepeatAll && !isShuffle && currentIndex === playlist.length - 1) {
    audio.pause();
    audio.currentTime = 0;
    return;
  }
  playTrack(pickNextIndex(1));
}

function prev() {
  if (playlist.length === 0) return;
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  playTrack(pickNextIndex(-1));
}

function setVolume(pct) {
  pct = clamp(Math.round(pct), 0, 100);
  audio.volume = pct / 100;
  volume.value = String(pct);
  volumeValue.textContent = `${pct}%`;
  if (pct > 0 && audio.muted) {
    audio.muted = false;
    muteBtn.setAttribute('aria-pressed', 'false');
  }
}

function toggleMute() {
  audio.muted = !audio.muted;
  muteBtn.setAttribute('aria-pressed', String(audio.muted));
}

function toggleLike() {
  if (currentIndex === -1) return;
  const track = playlist[currentIndex];
  track.liked = !track.liked;
  likeBtn.setAttribute('aria-pressed', String(track.liked));
  renderPlaylist();
}

function toggleShuffle() {
  isShuffle = !isShuffle;
  shuffleBtn.setAttribute('aria-pressed', String(isShuffle));
}

function toggleRepeat() {
  isRepeatAll = !isRepeatAll;
  repeatBtn.setAttribute('aria-pressed', String(isRepeatAll));
}

/* ---- audio element event wiring ---- */
audio.addEventListener('play', () => {
  playIcon.outerHTML = '<svg id="playIcon" viewBox="0 0 24 24" width="24" height="24"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>';
  playBtn.setAttribute('aria-label', 'Pause');
  renderPlaylist();
});
audio.addEventListener('pause', () => {
  document.getElementById('playIcon').outerHTML = '<svg id="playIcon" viewBox="0 0 24 24" width="24" height="24"><path d="M7 4l14 8-14 8z" fill="currentColor"/></svg>';
  playBtn.setAttribute('aria-label', 'Play');
  renderPlaylist();
});
audio.addEventListener('ended', () => next(true));
audio.addEventListener('loadedmetadata', () => {
  timeTotal.textContent = formatTime(audio.duration);
  if (currentIndex >= 0 && !playlist[currentIndex].duration) {
    playlist[currentIndex].duration = audio.duration;
    renderPlaylist();
  }
});
audio.addEventListener('timeupdate', () => {
  if (isSeeking) return;
  timeCurrent.textContent = formatTime(audio.currentTime);
  seek.value = audio.duration ? String((audio.currentTime / audio.duration) * 100) : '0';
});

seek.addEventListener('input', () => { isSeeking = true; });
seek.addEventListener('change', () => {
  if (audio.duration) audio.currentTime = (Number(seek.value) / 100) * audio.duration;
  isSeeking = false;
});
volume.addEventListener('input', () => setVolume(Number(volume.value)));
muteBtn.addEventListener('click', toggleMute);
playBtn.addEventListener('click', togglePlay);
prevBtn.addEventListener('click', prev);
nextBtn.addEventListener('click', () => next(false));
shuffleBtn.addEventListener('click', toggleShuffle);
repeatBtn.addEventListener('click', toggleRepeat);
likeBtn.addEventListener('click', toggleLike);

vizTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    vizTabs.forEach((t) => { t.classList.remove('is-active'); t.setAttribute('aria-selected', 'false'); });
    tab.classList.add('is-active');
    tab.setAttribute('aria-selected', 'true');
    vizMode = tab.dataset.viz;
  });
});

/* ---- file import ---- */
fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files || []);
  files.forEach((file) => {
    const url = URL.createObjectURL(file);
    const rawName = file.name.replace(/\.[^/.]+$/, '');
    let artist = 'Unknown artist';
    let name = rawName;
    const parts = rawName.split(/\s*-\s*/);
    if (parts.length >= 2) {
      artist = parts[0];
      name = parts.slice(1).join(' - ');
    }
    const track = { id: nextTrackId++, name, artist, url, duration: 0, liked: false };
    playlist.push(track);

    const probe = new Audio();
    probe.preload = 'metadata';
    probe.src = url;
    probe.addEventListener('loadedmetadata', () => {
      track.duration = probe.duration;
      renderPlaylist();
    }, { once: true });
  });
  if (currentIndex === -1 && playlist.length > 0) loadTrack(0, false);
  else renderPlaylist();
  fileInput.value = '';
});

/* =====================================================
   Visualizer
===================================================== */
function resizeVisualizer() {
  const rect = visualizerCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  visualizerCanvas.width = Math.max(1, rect.width * dpr);
  visualizerCanvas.height = Math.max(1, rect.height * dpr);
}
window.addEventListener('resize', resizeVisualizer);

function drawVisualizer() {
  requestAnimationFrame(drawVisualizer);
  if (!analyser) return;
  if (visualizerCanvas.width === 0) resizeVisualizer();
  const w = visualizerCanvas.width, h = visualizerCanvas.height;
  vctx.clearRect(0, 0, w, h);

  if (vizMode === 'bars') {
    analyser.getByteFrequencyData(dataArray);
    const barCount = 40;
    const step = Math.floor(dataArray.length / barCount);
    const barW = w / barCount;
    for (let i = 0; i < barCount; i++) {
      const v = dataArray[i * step] / 255;
      const barH = Math.max(2, v * h * 0.95);
      const x = i * barW;
      const grad = vctx.createLinearGradient(0, h - barH, 0, h);
      grad.addColorStop(0, '#4ce0d2');
      grad.addColorStop(1, 'rgba(76,224,210,0.25)');
      vctx.fillStyle = grad;
      vctx.fillRect(x + barW * 0.18, h - barH, barW * 0.64, barH);
    }
  } else {
    analyser.getByteTimeDomainData(dataArray);
    vctx.lineWidth = Math.max(2, w * 0.004);
    vctx.strokeStyle = '#ffb454';
    vctx.beginPath();
    const sliceW = w / dataArray.length;
    let x = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = dataArray[i] / 128 - 1;
      const y = h / 2 + v * h * 0.42;
      if (i === 0) vctx.moveTo(x, y); else vctx.lineTo(x, y);
      x += sliceW;
    }
    vctx.stroke();
  }
}

/* =====================================================
   Gesture feedback (toast + legend highlight)
===================================================== */
let toastTimer = null;
function showGestureToast(text) {
  gestureToast.textContent = text;
  gestureToast.classList.add('is-shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => gestureToast.classList.remove('is-shown'), 1100);
}

function flashLegend(action) {
  const card = document.querySelector(`.legend-card[data-action="${action}"]`);
  if (!card) return;
  card.classList.add('is-active');
  clearTimeout(card._flashTimer);
  card._flashTimer = setTimeout(() => card.classList.remove('is-active'), 900);
}

/* =====================================================
   Hand tracking (MediaPipe Hands)
===================================================== */
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
const FINGERTIPS = [4, 8, 12, 16, 20];

let hands = null;
let stream = null;
let isCameraOn = false;
let rafId = null;

// geometry mapping from normalized landmark space -> overlay canvas pixels
let mapScale = 1, mapOffsetX = 0, mapOffsetY = 0, dpr = 1, containerW = 0, containerH = 0;

function recomputeMapping() {
  const rect = cameraFrame.getBoundingClientRect();
  containerW = rect.width;
  containerH = rect.height;
  dpr = window.devicePixelRatio || 1;
  overlay.width = Math.max(1, containerW * dpr);
  overlay.height = Math.max(1, containerH * dpr);
  overlay.style.width = `${containerW}px`;
  overlay.style.height = `${containerH}px`;
  const vw = video.videoWidth || containerW;
  const vh = video.videoHeight || containerH;
  mapScale = Math.max(containerW / vw, containerH / vh);
  mapOffsetX = (vw * mapScale - containerW) / 2;
  mapOffsetY = (vh * mapScale - containerH) / 2;
}
window.addEventListener('resize', recomputeMapping);

function mapPoint(nx, ny) {
  const vw = video.videoWidth || containerW;
  const vh = video.videoHeight || containerH;
  return {
    x: (nx * vw * mapScale - mapOffsetX) * dpr,
    y: (ny * vh * mapScale - mapOffsetY) * dpr,
  };
}

function setStatus(state) {
  statusDot.classList.remove('is-on', 'is-playing');
  if (state === 'off') {
    statusLabel.textContent = 'Camera off';
    cameraToggleBtn.textContent = 'Start camera';
  } else if (state === 'ready') {
    statusDot.classList.add('is-on');
    statusLabel.textContent = 'Tracking ready';
    cameraToggleBtn.textContent = 'Stop camera';
  } else if (state === 'tracking') {
    statusDot.classList.add('is-playing');
    statusLabel.textContent = 'Hand detected';
    cameraToggleBtn.textContent = 'Stop camera';
  }
}

/* ---- per-gesture edge detection state ---- */
const cooldowns = { join: 0, thumbsUp: 0, peace: 0, swipe: 0 };
const COOLDOWN_MS = 900;
let wasJoined = false;
let wasThumbsUp = false;
let wasPeace = false;
let isPinching = false;
let pinchBaselineY = null;
const swipeBuffer = []; // {x, t}

function now() { return performance.now(); }
function onCooldown(key) { return now() - cooldowns[key] < COOLDOWN_MS; }
function fire(key) { cooldowns[key] = now(); }

function fingerExtended(lm, tipIdx, pipIdx) {
  const wrist = lm[0];
  return dist(wrist, lm[tipIdx]) > dist(wrist, lm[pipIdx]) * 1.08;
}

function analyzeHand(lm) {
  const index = fingerExtended(lm, 8, 6);
  const middle = fingerExtended(lm, 12, 10);
  const ring = fingerExtended(lm, 16, 14);
  const pinky = fingerExtended(lm, 20, 18);
  const wrist = lm[0];
  const thumbOut = dist(wrist, lm[4]) > dist(wrist, lm[2]) * 1.1;
  const thumbUp = thumbOut && lm[4].y < wrist.y - 0.08 && lm[4].y < lm[5].y;
  const pinchDist = dist(lm[4], lm[8]);
  return {
    index, middle, ring, pinky, thumbUp,
    isFist: !index && !middle && !ring && !pinky,
    isOpenPalm: index && middle && ring && pinky,
    isPeace: index && middle && !ring && !pinky,
    isThumbsUp: thumbUp && !index && !middle && !ring && !pinky,
    isPinching: pinchDist < 0.055,
    pinchMidY: (lm[4].y + lm[8].y) / 2,
    mirroredX: 1 - wrist.x,
  };
}

function handCenter(lm) {
  let x = 0, y = 0;
  for (const p of lm) { x += p.x; y += p.y; }
  return { x: x / lm.length, y: y / lm.length };
}

function resetSingleHandTrackers() {
  isPinching = false;
  pinchBaselineY = null;
  swipeBuffer.length = 0;
}

function drawHand(lm, highlight) {
  octx.lineWidth = Math.max(1.5, 2 * dpr);
  octx.strokeStyle = highlight ? 'rgba(255,180,84,0.85)' : 'rgba(76,224,210,0.75)';
  octx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    const pa = mapPoint(lm[a].x, lm[a].y);
    const pb = mapPoint(lm[b].x, lm[b].y);
    octx.moveTo(pa.x, pa.y);
    octx.lineTo(pb.x, pb.y);
  }
  octx.stroke();

  for (let i = 0; i < lm.length; i++) {
    const p = mapPoint(lm[i].x, lm[i].y);
    const isTip = FINGERTIPS.includes(i);
    octx.beginPath();
    octx.arc(p.x, p.y, isTip ? 4 * dpr : 2.4 * dpr, 0, Math.PI * 2);
    octx.fillStyle = isTip ? '#ffb454' : '#4ce0d2';
    octx.fill();
  }
}

function onResults(results) {
  recomputeMapping();
  octx.clearRect(0, 0, overlay.width, overlay.height);

  const handsList = results.multiHandLandmarks || [];
  handsChip.textContent = `${handsList.length} hand${handsList.length === 1 ? '' : 's'}`;

  if (handsList.length === 0) {
    setStatus('ready');
    wasJoined = false;
    wasThumbsUp = false;
    wasPeace = false;
    resetSingleHandTrackers();
    return;
  }

  setStatus('tracking');

  if (handsList.length >= 2) {
    const c1 = handCenter(handsList[0]);
    const c2 = handCenter(handsList[1]);
    const joined = dist(c1, c2) < 0.16;
    handsList.forEach((lm) => drawHand(lm, joined));

    if (joined && !wasJoined && !onCooldown('join')) {
      togglePlay();
      showGestureToast(audio.paused ? '⏸ Paused' : '▶ Playing');
      flashLegend('play');
      fire('join');
    }
    wasJoined = joined;
    resetSingleHandTrackers();
    return;
  }

  // exactly one hand -> pose + motion gestures
  wasJoined = false;
  const lm = handsList[0];
  const g = analyzeHand(lm);
  drawHand(lm, g.isPinching || g.isThumbsUp || g.isPeace);

  if (g.isPinching) {
    if (!isPinching) {
      isPinching = true;
      pinchBaselineY = g.pinchMidY;
    } else {
      const deltaY = pinchBaselineY - g.pinchMidY; // moving up (smaller y) => positive
      if (Math.abs(deltaY) > 0.004) {
        const deltaPct = deltaY * 260; // sensitivity tuned for normalized coords
        setVolume(Number(volume.value) + deltaPct);
        pinchBaselineY = g.pinchMidY;
        flashLegend('volume');
      }
    }
    swipeBuffer.length = 0;
    wasThumbsUp = false;
    wasPeace = false;
    return;
  }
  isPinching = false;
  pinchBaselineY = null;

  if (g.isThumbsUp) {
    if (!wasThumbsUp && !onCooldown('thumbsUp')) {
      toggleLike();
      showGestureToast(playlist[currentIndex]?.liked ? '♥ Liked' : 'Removed like');
      flashLegend('like');
      fire('thumbsUp');
    }
    wasThumbsUp = true;
    wasPeace = false;
    swipeBuffer.length = 0;
    return;
  }
  wasThumbsUp = false;

  if (g.isPeace) {
    if (!wasPeace && !onCooldown('peace')) {
      toggleMute();
      showGestureToast(audio.muted ? '🔇 Muted' : '🔊 Unmuted');
      flashLegend('mute');
      fire('peace');
    }
    wasPeace = true;
    swipeBuffer.length = 0;
    return;
  }
  wasPeace = false;

  if (g.isOpenPalm) {
    // steady open palm = calibration point, clears swipe history
    swipeBuffer.length = 0;
    return;
  }

  // motion-based swipe tracking for any other transitional open-ish pose
  const t = now();
  swipeBuffer.push({ x: g.mirroredX, t });
  while (swipeBuffer.length && t - swipeBuffer[0].t > 350) swipeBuffer.shift();
  if (swipeBuffer.length >= 3 && !onCooldown('swipe')) {
    const first = swipeBuffer[0];
    const last = swipeBuffer[swipeBuffer.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt > 0.05) {
      const velocity = (last.x - first.x) / dt;
      if (velocity > 1.1) {
        next(false);
        showGestureToast('⏭ Next track');
        flashLegend('next');
        fire('swipe');
        swipeBuffer.length = 0;
      } else if (velocity < -1.1) {
        prev();
        showGestureToast('⏮ Previous track');
        flashLegend('prev');
        fire('swipe');
        swipeBuffer.length = 0;
      }
    }
  }
}

async function startCamera() {
  if (typeof Hands === 'undefined') {
    cameraEmptySub.textContent = "Couldn't load the hand-tracking model. Check your connection and reload the page.";
    return;
  }
  try {
    if (!hands) {
      hands = new Hands({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      });
      hands.setOptions({
        maxNumHands: 2,
        modelComplexity: isMobile ? 0 : 1,
        minDetectionConfidence: 0.65,
        minTrackingConfidence: 0.6,
      });
      hands.onResults(onResults);
    }

    const constraints = {
      video: {
        facingMode: 'user',
        width: { ideal: isMobile ? 480 : 640 },
        height: { ideal: isMobile ? 360 : 480 },
      },
      audio: false,
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();
    video.classList.add('is-active');
    cameraEmpty.hidden = true;
    isCameraOn = true;
    recomputeMapping();
    setStatus('ready');

    const loop = async () => {
      if (!isCameraOn) return;
      try {
        await hands.send({ image: video });
      } catch (err) {
        console.error('Hand tracking error:', err);
        stopCamera();
        cameraEmptySub.textContent = 'Hand tracking hit an error. Try starting the camera again.';
        return;
      }
      rafId = requestAnimationFrame(loop);
    };
    loop();
  } catch (err) {
    let msg = "Couldn't access the camera. You can still use the on-screen controls.";
    if (err && err.name === 'NotAllowedError') msg = 'Camera access was denied. Allow camera permission in your browser settings and try again.';
    else if (err && err.name === 'NotFoundError') msg = 'No camera was found on this device.';
    cameraEmptySub.textContent = msg;
    cameraEmpty.hidden = false;
    setStatus('off');
  }
}

function stopCamera() {
  isCameraOn = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  video.classList.remove('is-active');
  cameraEmpty.hidden = false;
  octx.clearRect(0, 0, overlay.width, overlay.height);
  handsChip.textContent = '0 hands';
  resetSingleHandTrackers();
  wasJoined = false; wasThumbsUp = false; wasPeace = false;
  setStatus('off');
}

function toggleCamera() {
  unlockAudioOnce();
  if (isCameraOn) stopCamera(); else startCamera();
}

startCameraBtn.addEventListener('click', toggleCamera);
cameraToggleBtn.addEventListener('click', toggleCamera);

/* =====================================================
   Keyboard shortcuts (accessibility + non-gesture control)
===================================================== */
document.addEventListener('keydown', (e) => {
  if (e.target && /^(input|textarea)$/i.test(e.target.tagName) && e.target.type !== 'range') return;
  switch (e.code) {
    case 'Space': e.preventDefault(); togglePlay(); break;
    case 'ArrowRight': if (e.target.id !== 'seek') next(false); break;
    case 'ArrowLeft': if (e.target.id !== 'seek') prev(); break;
    case 'ArrowUp': if (e.target.id !== 'volume') { e.preventDefault(); setVolume(Number(volume.value) + 5); } break;
    case 'ArrowDown': if (e.target.id !== 'volume') { e.preventDefault(); setVolume(Number(volume.value) - 5); } break;
    case 'KeyM': toggleMute(); break;
  }
});

/* =====================================================
   PWA: install prompt + service worker
===================================================== */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.hidden = false;
});
installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  installBtn.hidden = true;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
});
window.addEventListener('appinstalled', () => { installBtn.hidden = true; });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed:', err));
  });
}

/* =====================================================
   Init
===================================================== */
resizeVisualizer();
setVolume(80);
updateNowPlaying(null);
renderPlaylist();
setStatus('off');
