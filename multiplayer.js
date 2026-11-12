const PROFILE_KEY = 'sumiro.profile.v1';
const STATE_HZ = 12;
const ROSTER_HZ = 4;

const CHAPTER_TITLES = {
  ch1_climb: 'The Climb',
  ch2_pass: 'The Broken Pass',
  ch3_pines: 'Hanging Pines',
  ch4_temple: 'Temple of Silent Bells',
  ch5_sea: 'Sea of Ink',
  ch6_summit: 'The Last Brushstroke',
};

const INK_COLORS = ['#a8321f', '#2a2622', '#3d4f6b', '#4a6b3a', '#8a6a2a', '#7a4a6a'];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function loadProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null');
    if (saved && typeof saved.name === 'string' && typeof saved.color === 'string') {
      return {
        name: saved.name.slice(0, 24),
        color: INK_COLORS.includes(saved.color) ? saved.color : INK_COLORS[0],
      };
    }
  } catch {}
  return { name: 'Wanderer', color: INK_COLORS[0] };
}

function saveProfile(profile) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {}
}

function chapterTitle(id) {
  return CHAPTER_TITLES[id] ?? 'The road';
}

function makeTag(THREE, name, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const draw = (nextName, nextColor) => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = 'italic 58px "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineJoin = 'round';
    context.lineWidth = 10;
    context.strokeStyle = 'rgba(231, 220, 193, 0.9)';
    context.strokeText(nextName, canvas.width / 2, canvas.height / 2);
    context.fillStyle = nextColor;
    context.fillText(nextName, canvas.width / 2, canvas.height / 2);
    texture.needsUpdate = true;
  };

  draw(name, color);

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(1.7, 0.425, 1);
  sprite.position.y = 2.12;
  return { sprite, draw, dispose: () => texture.dispose() };
}

class Avatar {
  constructor(THREE, scene, template, cloneSkinned, peer) {
    this.THREE = THREE;
    this.scene = scene;
    this.root = cloneSkinned(template.scene);
    this.root.name = `walker-${peer.id}`;
    this.materials = [];
    this.root.traverse((object) => {
      if (!object.isMesh && !object.isSkinnedMesh) return;
      object.frustumCulled = false;
      const source = Array.isArray(object.material) ? object.material : [object.material];
      const clones = source.filter(Boolean).map((material) => cloneForRemote(material));
      this.materials.push(...clones);
      object.material = Array.isArray(object.material) ? clones : clones[0];
    });

    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions = new Map();
    for (const clip of template.animations ?? []) {
      const action = this.mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      this.actions.set(clip.name, action);
    }
    this.currentClip = null;

    this.tag = makeTag(THREE, peer.name, peer.color);
    this.root.add(this.tag.sprite);

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.46, 40),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(peer.color),
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.03;
    this.root.add(this.ring);

    this.target = { x: 0, y: 0, z: 0, heading: 0, speed: 0, state: 'IDLE', level: null };
    this.hasTarget = false;
    this.visibleLevel = null;

    scene.add(this.root);
  }

  setPeer(peer) {
    this.tag.draw(peer.name, peer.color);
    this.ring.material.color.set(peer.color);
  }

  applyState(state) {
    const jump = this.hasTarget
      ? Math.hypot(state.x - this.target.x, state.z - this.target.z) > 6
      : true;
    this.target = state;
    if (jump) {
      this.root.position.set(state.x, state.rootY, state.z);
      this.root.rotation.y = state.heading + Math.PI;
    }
    this.hasTarget = true;
  }

  setVisible(visible) {
    this.root.visible = visible;
  }

  update(dt, localLevel) {
    const visible = this.hasTarget && this.target.level === localLevel;
    this.root.visible = visible;
    if (!visible) {
      this.mixer.update(0);
      return;
    }

    const ease = 1 - Math.exp(-12 * dt);
    const position = this.root.position;
    position.x += (this.target.x - position.x) * ease;
    position.z += (this.target.z - position.z) * ease;
    position.y += (this.target.rootY - position.y) * ease;

    let delta = this.target.heading + Math.PI - this.root.rotation.y;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    this.root.rotation.y = Math.atan2(
      Math.sin(this.root.rotation.y + delta * (1 - Math.exp(-14 * dt))),
      Math.cos(this.root.rotation.y + delta * (1 - Math.exp(-14 * dt))),
    );

    const clip = clipFor(this.target.state, this.target.speed);
    const speedScale =
      clip === 'walk' || clip === 'jog' || clip === 'sprint'
        ? clamp(this.target.speed / 2.6, 0.65, 1.8)
        : 1;
    this.play(clip);
    this.mixer.update(dt * speedScale);
  }

  play(name) {
    if (this.currentClip === name) return;
    const next = this.actions.get(name);
    if (!next) return;
    const previous = this.currentClip ? this.actions.get(this.currentClip) : null;
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
    if (previous && previous !== next) previous.crossFadeTo(next, 0.25, false);
    this.currentClip = name;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.scene.remove(this.root);
    this.tag.dispose();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.root.traverse((object) => {
      if (object.isSkinnedMesh) object.skeleton?.dispose?.();
    });
  }
}

function cloneForRemote(material) {
  const originalCompile = material.onBeforeCompile;
  const originalKey = material.customProgramCacheKey;
  const clone = material.clone();
  clone.onBeforeCompile = (shader, renderer) => {
    originalCompile?.call(clone, shader, renderer);
    if (shader.uniforms.uDissolve) shader.uniforms.uDissolve = { value: 0 };
  };
  clone.customProgramCacheKey = () => `${originalKey?.call(material) ?? ''}:remote`;
  clone.needsUpdate = true;
  return clone;
}

function clipFor(state, speed) {
  if (state === 'DEAD' || state === 'DEATH') return 'death';
  if (state === 'FALL' || state === 'JUMP' || state === 'LEAP' || state === 'DROP') return 'fall';
  if (state === 'HANG' || state === 'SHIMMY' || state === 'GRAB' || state === 'CLIMB') return 'hang_idle';
  if (speed > 5.4) return 'sprint';
  if (speed > 2.4) return 'jog';
  if (speed > 0.25) return 'walk';
  return 'stand_idle';
}

class Net {
  constructor(url, handlers) {
    this.url = url;
    this.handlers = handlers;
    this.socket = null;
    this.status = 'offline';
    this.attempt = 0;
    this.timer = null;
    this.id = null;
    this.profile = loadProfile();
    this.closedByUs = false;
  }

  open(profile) {
    if (profile) this.profile = profile;
    if (!this.url) {
      this.setStatus('offline');
      return;
    }
    clearTimeout(this.timer);
    this.closedByUs = false;
    this.setStatus('connecting');
    let socket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.setStatus('offline');
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus('online');
      this.send({ t: 'join', name: this.profile.name, color: this.profile.color });
    };

    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      switch (message.t) {
        case 'welcome':
          this.id = message.id;
          this.handlers.onWelcome?.(message.id, Array.isArray(message.peers) ? message.peers : []);
          break;
        case 'join':
          if (message.peer) this.handlers.onJoin?.(message.peer);
          break;
        case 'leave':
          if (message.id) this.handlers.onLeave?.(message.id);
          break;
        case 's':
          this.handlers.onState?.(message);
          break;
        case 'profile':
          if (message.id) this.handlers.onProfile?.(message);
          break;
        default:
          break;
      }
    };

    socket.onerror = () => {};
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.id = null;
      this.setStatus('offline');
      if (!this.closedByUs) this.scheduleRetry();
    };
  }

  scheduleRetry() {
    clearTimeout(this.timer);
    const delay = Math.min(1000 * 2 ** this.attempt, 8000);
    this.attempt += 1;
    this.timer = setTimeout(() => this.open(), delay);
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus?.(status);
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  updateProfile(profile) {
    this.profile = profile;
    saveProfile(profile);
    this.send({ t: 'profile', name: profile.name, color: profile.color });
  }

  close() {
    this.closedByUs = true;
    clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
  }
}

class Overlay {
  constructor(profile, handlers) {
    this.profile = profile;
    this.handlers = handlers;
    this.open = false;
    this.build();
    this.render(profile);
  }

  build() {
    const style = document.createElement('style');
    style.textContent = `
      #mp-ui { position: fixed; inset: 0; z-index: 7; pointer-events: none; font-family: 'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif; font-style: italic; color: #1b1712; }
      #mp-ui * { box-sizing: border-box; }
      #mp-tab { position: absolute; right: 22px; bottom: 22px; width: 46px; height: 46px; border: 0; border-radius: 12%; pointer-events: auto; cursor: pointer; background: #a8321f; color: #e8d9bd; font: italic 600 17px inherit; display: grid; place-items: center; box-shadow: 0 0 0 1px #00000022, 0 6px 18px #0000002e; transition: transform .18s ease, opacity .3s ease; }
      #mp-tab:hover { transform: translateY(-2px); }
      #mp-tab:focus-visible { outline: 2px solid #2a2622; outline-offset: 3px; }
      #mp-tab .mp-count { position: absolute; top: -7px; right: -7px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; background: #e7dcc1; color: #1b1712; font: italic 12px/20px Georgia, serif; text-align: center; box-shadow: 0 0 0 1px #a8321f55; }
      #mp-scrim { position: absolute; inset: 0; background: #1b171266; opacity: 0; pointer-events: none; transition: opacity .3s ease; backdrop-filter: blur(1.5px); }
      #mp-panel { position: absolute; top: 50%; left: 50%; width: min(440px, calc(100vw - 40px)); max-height: min(78vh, 640px); transform: translate(-50%, -46%); display: flex; flex-direction: column; gap: 16px; padding: 26px 26px 20px; background: #e7dcc1; border-radius: 3px; box-shadow: 0 18px 60px #0000003d, 0 0 0 1px #2a26221f; opacity: 0; pointer-events: none; transition: opacity .3s ease, transform .3s ease; overflow: hidden; }
      #mp-ui.open #mp-scrim { opacity: 1; pointer-events: auto; }
      #mp-ui.open #mp-panel { opacity: 1; transform: translate(-50%, -50%); pointer-events: auto; }
      #mp-panel h2 { margin: 0; font: italic 26px Georgia, serif; letter-spacing: .02em; }
      #mp-panel h2 span { color: #a8321f; }
      #mp-close { position: absolute; top: 12px; right: 12px; width: 32px; height: 32px; border: 0; border-radius: 50%; background: #2a26220f; color: #1b1712; font-size: 20px; line-height: 1; cursor: pointer; }
      #mp-close:hover { background: #2a26221f; }
      .mp-field { display: grid; gap: 6px; }
      .mp-field label { font-size: 12px; letter-spacing: .16em; text-transform: uppercase; opacity: .62; }
      #mp-name { width: 100%; padding: 9px 11px; border: 0; border-bottom: 1.5px solid #2a262229; background: #f2e9d4; color: #1b1712; font: italic 17px Georgia, serif; border-radius: 2px 2px 0 0; }
      #mp-name:focus { outline: none; border-bottom-color: #a8321f; background: #fbf4e2; }
      .mp-colors { display: flex; gap: 9px; }
      .mp-swatch { width: 27px; height: 27px; padding: 0; border: 0; border-radius: 50%; cursor: pointer; box-shadow: inset 0 0 0 1px #00000026; transition: transform .15s ease, box-shadow .15s ease; }
      .mp-swatch:hover { transform: scale(1.08); }
      .mp-swatch.on { box-shadow: inset 0 0 0 1px #00000033, 0 0 0 2px #e7dcc1, 0 0 0 4px #2a2622; }
      #mp-roster { flex: 1; min-height: 0; overflow: auto; border-top: 1px solid #2a26221f; padding-top: 12px; }
      #mp-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 9px; }
      #mp-list li { display: grid; grid-template-columns: 12px 1fr auto; align-items: center; gap: 10px; font-size: 16px; }
      #mp-list li i { width: 11px; height: 11px; border-radius: 50%; background: var(--c); box-shadow: inset 0 0 0 1px #00000026; }
      #mp-list li .mp-who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #mp-list li .mp-who b { font-weight: 600; }
      #mp-list li .mp-where { font-size: 12px; opacity: .55; text-align: right; white-space: nowrap; }
      #mp-list li.me .mp-where { opacity: .8; }
      #mp-empty { font-size: 15px; opacity: .55; padding: 4px 0; }
      #mp-status { font-size: 12px; letter-spacing: .1em; opacity: .55; border-top: 1px solid #2a26221f; padding-top: 10px; }
      #mp-status b { font-weight: 600; color: #4a6b3a; }
      #mp-status b.off { color: #a8321f; }
      #mp-toasts { position: absolute; left: 50%; bottom: 34px; transform: translateX(-50%); display: grid; gap: 6px; justify-items: center; }
      .mp-toast { background: #1b1712d9; color: #e7dcc1; padding: 7px 15px; border-radius: 2px; font-size: 14px; letter-spacing: .03em; opacity: 0; animation: mp-toast 3.4s ease forwards; }
      @keyframes mp-toast { 0% { opacity: 0; transform: translateY(6px); } 12%, 78% { opacity: 1; transform: none; } 100% { opacity: 0; } }
    `;
    document.head.appendChild(style);

    const ui = document.createElement('div');
    ui.id = 'mp-ui';
    ui.innerHTML = `
      <div id="mp-scrim"></div>
      <section id="mp-panel" role="dialog" aria-label="Wanderers" aria-modal="false">
        <h2>Wan<span>derers</span></h2>
        <button id="mp-close" type="button" aria-label="Close">×</button>
        <div class="mp-field">
          <label for="mp-name">Your name</label>
          <input id="mp-name" maxlength="24" autocomplete="off" spellcheck="false" />
        </div>
        <div class="mp-field">
          <label>Ink</label>
          <div class="mp-colors"></div>
        </div>
        <div id="mp-roster"><ul id="mp-list"></ul><p id="mp-empty">Only you, for now.</p></div>
        <footer id="mp-status"></footer>
      </section>
      <button id="mp-tab" type="button" aria-label="Wanderers">人<span class="mp-count">1</span></button>
      <div id="mp-toasts"></div>
    `;
    document.body.appendChild(ui);

    this.ui = ui;
    this.panel = ui.querySelector('#mp-panel');
    this.nameInput = ui.querySelector('#mp-name');
    this.list = ui.querySelector('#mp-list');
    this.empty = ui.querySelector('#mp-empty');
    this.statusLine = ui.querySelector('#mp-status');
    this.count = ui.querySelector('#mp-tab .mp-count');
    this.toasts = ui.querySelector('#mp-toasts');

    for (const color of INK_COLORS) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'mp-swatch';
      swatch.style.background = color;
      swatch.dataset.color = color;
      swatch.setAttribute('aria-label', `Ink ${color}`);
      swatch.addEventListener('click', () => {
        this.emitProfile({ color });
      });
      ui.querySelector('.mp-colors').appendChild(swatch);
    }

    ui.querySelector('#mp-tab').addEventListener('click', () => this.toggle());
    ui.querySelector('#mp-close').addEventListener('click', () => this.setOpen(false));
    ui.querySelector('#mp-scrim').addEventListener('click', () => this.setOpen(false));

    this.nameInput.addEventListener('input', () => {
      this.emitProfile({ name: this.nameInput.value });
    });
    this.nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        this.nameInput.blur();
        this.setOpen(false);
      }
    });

    for (const type of ['keydown', 'keyup']) {
      this.nameInput.addEventListener(type, (event) => event.stopPropagation());
    }

    window.addEventListener(
      'keydown',
      (event) => {
        const typing = event.target === this.nameInput;
        if (typing) return;
        if (event.code === 'KeyM' && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          this.toggle();
          return;
        }
        if (event.code === 'Escape' && this.open) {
          event.stopPropagation();
          this.setOpen(false);
        }
      },
      true,
    );
  }

  emitProfile(patch) {
    this.profile = { ...this.profile, ...patch };
    if (patch.name !== undefined) {
      this.profile.name = patch.name.replace(/[\u0000-\u001f]/g, '').slice(0, 24);
    }
    this.render(this.profile);
    this.handlers.onProfile?.(this.profile);
  }

  render(profile) {
    if (this.nameInput.value !== profile.name && document.activeElement !== this.nameInput) {
      this.nameInput.value = profile.name;
    }
    for (const swatch of this.ui.querySelectorAll('.mp-swatch')) {
      swatch.classList.toggle('on', swatch.dataset.color === profile.color);
    }
    const me = this.list.querySelector('li.me');
    if (me) {
      me.querySelector('.mp-who b').textContent = profile.name || 'Wanderer';
      me.style.setProperty('--c', profile.color);
    }
  }

  setRoster(entries, localId) {
    this.list.replaceChildren();
    for (const entry of entries) {
      const item = document.createElement('li');
      if (entry.id === localId) item.className = 'me';
      item.style.setProperty('--c', entry.color);

      const dot = document.createElement('i');
      const who = document.createElement('span');
      who.className = 'mp-who';
      const name = document.createElement('b');
      name.textContent = entry.name || 'Wanderer';
      who.appendChild(name);
      if (entry.id === localId) who.appendChild(document.createTextNode(' (you)'));

      const where = document.createElement('span');
      where.className = 'mp-where';
      where.textContent = entry.level ? chapterTitle(entry.level) : 'somewhere';

      item.append(dot, who, where);
      this.list.appendChild(item);
    }
    this.empty.hidden = entries.length > 0;
    this.count.textContent = String(Math.max(entries.length, 1));
  }

  setStatus(status) {
    const label =
      status === 'online' ? 'walking together' : status === 'connecting' ? 'finding the road' : 'alone';
    this.statusLine.replaceChildren();
    const dot = document.createElement('b');
    dot.className = status === 'online' ? '' : 'off';
    dot.textContent = status === 'online' ? '● ' : '○ ';
    this.statusLine.append(dot, document.createTextNode(label));
  }

  toast(text) {
    const toast = document.createElement('div');
    toast.className = 'mp-toast';
    toast.textContent = text;
    this.toasts.appendChild(toast);
    setTimeout(() => toast.remove(), 3600);
  }

  toggle() {
    this.setOpen(!this.open);
  }

  setOpen(value) {
    if (this.open === value) return;
    this.open = value;
    this.ui.classList.toggle('open', value);
    this.handlers.onOpenChange?.(value);
    if (value) {
      setTimeout(() => this.nameInput.focus({ preventScroll: true }), 60);
    } else {
      this.nameInput.blur();
    }
  }
}

function socketUrl() {
  const override = new URLSearchParams(location.search).get('net');
  if (override) return override;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}

async function start() {
  const profile = loadProfile();
  const peers = new Map();
  const avatars = new Map();

  let engine = null;
  let game = null;
  let template = null;
  let cloneSkinned = null;
  let localLevel = null;
  let localId = null;
  let lastSend = 0;
  let lastRoster = 0;
  let lastTime = performance.now();
  let pausedByPanel = false;

  function syncMute() {
    if (!engine) return;
    const state = engine.registry?.get('game.state');
    engine.input.muted = overlay.open || state !== 'PLAY';
  }

  function resumeIfPaused() {
    if (engine?.registry?.get('game.state') !== 'PAUSE') return;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', key: 'p', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyP', key: 'p', bubbles: true }));
  }

  const overlay = new Overlay(profile, {
    onProfile(next) {
      net.updateProfile(next);
      roster(true);
    },
    onOpenChange(open) {
      if (!engine) return;
      const state = engine.registry?.get('game.state');
      if (open) {
        pausedByPanel = state === 'PLAY';
        if (document.pointerLockElement) document.exitPointerLock?.();
      } else if (pausedByPanel) {
        pausedByPanel = false;
        resumeIfPaused();
      }
      syncMute();
    },
  });

  const net = new Net(socketUrl(), {
    onStatus(status) {
      overlay.setStatus(status);
    },
    onWelcome(id, list) {
      localId = id;
      peers.clear();
      for (const peer of list) if (peer && peer.id) peers.set(peer.id, peer);
      syncAvatars();
      roster(true);
    },
    onJoin(peer) {
      if (!peer?.id) return;
      peers.set(peer.id, peer);
      syncAvatars();
      overlay.toast(`${peer.name} joined the road`);
      roster(true);
    },
    onLeave(id) {
      const peer = peers.get(id);
      peers.delete(id);
      const avatar = avatars.get(id);
      if (avatar) {
        avatar.dispose();
        avatars.delete(id);
      }
      if (peer) overlay.toast(`${peer.name} left the road`);
      roster(true);
    },
    onState(state) {
      const peer = peers.get(state.id);
      if (peer) peer.level = state.level ?? peer.level;
      const avatar = avatars.get(state.id);
      if (avatar) avatar.applyState(state);
    },
    onProfile(message) {
      const peer = peers.get(message.id);
      if (!peer) return;
      peer.name = message.name;
      peer.color = message.color;
      avatars.get(message.id)?.setPeer(peer);
      roster(true);
    },
  });

  function localEntry() {
    return {
      id: localId,
      name: net.profile.name,
      color: net.profile.color,
      level: localLevel,
    };
  }

  function roster(force = false) {
    const now = performance.now();
    if (!force && now - lastRoster < 1000 / ROSTER_HZ) return;
    lastRoster = now;
    const entries = [localEntry(), ...peers.values()];
    overlay.setRoster(entries, localId);
  }

  function syncAvatars() {
    if (!engine || !template || !cloneSkinned) return;
    for (const [id, peer] of peers) {
      if (id === localId || avatars.has(id)) continue;
      try {
        avatars.set(id, new Avatar(engine.THREE, engine.scene, template, cloneSkinned, peer));
      } catch (error) {
        console.warn('[multiplayer] could not build avatar', error);
      }
    }
    for (const id of [...avatars.keys()]) {
      if (!peers.has(id)) {
        avatars.get(id)?.dispose();
        avatars.delete(id);
      }
    }
  }

  async function resolveGame() {
    if (!window.__engine || !window.__game) return false;
    engine = window.__engine;
    try {
      const entryScript = [...document.querySelectorAll('script[type="module"][src]')].find((node) =>
        /bundle\/index-[^/]+\.js$/.test(node.getAttribute('src') ?? ''),
      );
      if (!entryScript) return false;
      const entryUrl = new URL(entryScript.getAttribute('src'), location.href).href;
      const module = await import(entryUrl);
      if (typeof module.n === 'function') cloneSkinned = module.n;
    } catch (error) {
      console.warn('[multiplayer] could not load clone helper', error);
    }

    const asset = engine.registry?.get('player.asset');
    if (asset?.scene && asset.animations) template = asset;

    if (!cloneSkinned && template?.scene) {
      cloneSkinned = (source) => source.clone(true);
    }
    if (overlay.open) {
      engine.input.muted = true;
    }
    return Boolean(engine && template && cloneSkinned);
  }

  function tick(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    try {
      game = window.__game ? window.__game : null;
      if (game && engine) {
        let read = null;
        try {
          read = game.read();
        } catch {}
        if (read) {
          localLevel = read.level ?? localLevel;
          if (now - lastSend >= 1000 / STATE_HZ) {
            lastSend = now;
            net.send({
              t: 's',
              x: read.x,
              y: read.y,
              z: read.z,
              rootY: read.rootY,
              heading: read.heading,
              speed: read.speed,
              state: read.state,
              level: read.level,
            });
          }
        }
      }

      if (engine && overlay.open && !engine.input.muted) engine.input.muted = true;

      for (const avatar of avatars.values()) avatar.update(dt, localLevel);
      roster();
    } catch (error) {
      console.warn('[multiplayer] frame error', error);
    }

    requestAnimationFrame(tick);
  }

  overlay.setStatus('offline');
  overlay.setRoster([localEntry()], null);

  net.open();
  requestAnimationFrame(tick);

  const waitForGame = async () => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      try {
        if (await resolveGame()) {
          syncAvatars();
          roster(true);
          return;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  waitForGame();

  const firstRun = !localStorage.getItem(PROFILE_KEY);
  if (firstRun) {
    setTimeout(() => overlay.toast('Press M to choose your name and ink'), 1800);
  }

  window.addEventListener('pagehide', () => net.close());
}

start().catch((error) => console.warn('[multiplayer] failed to start', error));
