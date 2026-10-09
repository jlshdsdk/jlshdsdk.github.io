'use strict';
/* ============================================================
   打地鼠·纳尔篇  game.js
   结构：CONFIG 参数区 → 工具 → Scheduler 统一调度器 → sfx 音效
   → state 状态 → Assets 资产预加载与兜底 → 棋盘与猫精灵
   → spawnLoop 调度 → render 渲染 → 交互与流程 → 分享战报
   ============================================================ */

/* ==================== CONFIG：全部可调参数集中在此 ==================== */
const CONFIG = {
  lives: 3,                  // 初始生命数
  levelDuration: 15000,      // 每关时长（毫秒），15 秒进下一关
  endlessAfterLevel: 3,      // 第 3 关之后进入无尽模式
  comboWindow: 2000,         // 连击有效期：2 秒内连续命中才算连击
  comboPerRage: 5,           // 每 5 连击触发一次「纳尔暴走」
  rageDuration: 600,         // 暴走持续时长（毫秒）
  wrongPenalty: 15,          // 误拍装睡纳尔扣分
  riseMs: 170,               // 出洞动画时长
  fallMs: 170,               // 缩回动画时长
  hitShowMs: 260,            // 命中后委屈表情展示时长
  sleepPeekMs: 260,          // 装睡纳尔偷偷睁眼的时长
  sleepWakeExtraMs: 700,     // 睡醒后变成普通纳尔的额外停留
  forms: {
    normal: { score: 10, stay: 1000 },   // 普通纳尔：+10 分，停留 1s
    fast:   { score: 25, stay: 550 },    // 快速纳尔：+25 分，停留 0.55s
    sleep:  { score: 0,  stay: 1500 },   // 装睡纳尔：不能打，停留 1.5s
    rage:   { score: 50, stay: 600 },    // 暴走纳尔：+50 分（连击奖励事件）
  },
  spawn: {
    baseInterval: 950,       // 第 1 关出洞间隔
    minInterval: 340,        // 出洞间隔下限
    intervalDecay: 0.12,     // 每关间隔衰减比例
    jitter: 0.25,            // 间隔随机浮动比例
    maxConcurrent: 3,        // 同屏最多同时出洞数（高关卡放宽）
  },
  fastRatio:  { base: 0.18, step: 0.12, max: 0.50 },  // 快速纳尔占比曲线
  sleepRatio: { base: 0.16, step: 0.05, max: 0.34 },  // 装睡纳尔占比曲线
  stayScale:  { min: 0.55, step: 0.12 },              // 每关停留时长衰减
  assets: {
    // 每组的 [探头照, 升起照] 来自同一张源图，保证出洞过程画面连续
    peekPairs: [['peek-1.webp', 'up-2.webp'], ['peek-2.webp', 'up-1.webp']],
    hit: 'hit-1.webp',
    sleep: 'sleep-1.webp',
    rage: 'rage-1.webp',
  },
  storage: {
    best: 'whack-nar-best',    // 历史最高分
    muted: 'whack-nar-muted',  // 静音状态
  },
};

/* ==================== 工具 ==================== */
const $ = (sel) => document.querySelector(sel);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/* ==================== Scheduler：统一调度器 ====================
   所有计时器都以"绝对截止时间"登记；页面切走时整体冻结，
   回来时把未来任务的截止时间整体后移，不会出现计时器爆炸。
   驱动用 setTimeout 而非 rAF：无头浏览器/部分 WebView 里
   rAF 会随帧产出停转而卡死，setTimeout 在任何环境都稳定触发。 */
const Scheduler = {
  _tasks: new Set(),
  _timer: null,
  _paused: false,
  _pauseAt: 0,

  add(delay, cb) {
    const task = { deadline: performance.now() + delay, cb };
    this._tasks.add(task);
    this._ensure();
    return task;
  },
  clear(task) {
    if (task) this._tasks.delete(task);
  },
  _ensure() {
    if (!this._timer && !this._paused) {
      this._timer = setTimeout(() => this._tick(), 16);
    }
  },
  _tick() {
    this._timer = null;
    const now = performance.now();
    for (const task of [...this._tasks]) {
      if (task.deadline <= now) {
        this._tasks.delete(task);
        task.cb();
      }
    }
    if (this._tasks.size) this._ensure();
  },
  pause() {
    if (this._paused) return;
    this._paused = true;
    this._pauseAt = performance.now();
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  },
  resume() {
    if (!this._paused) return;
    this._paused = false;
    const delta = performance.now() - this._pauseAt;
    for (const task of this._tasks) task.deadline += delta;
    this._ensure();
  },
};

/* ==================== sfx：Web Audio 现场合成音效 ==================== */
const sfx = {
  ctx: null,
  muted: false,

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch (e) { /* 无音频环境时静默降级 */ }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  // 单音：可带上扬/下滑滑音
  tone({ freq = 440, endFreq = 0, type = 'sine', t = 0, dur = 0.18, vol = 0.18 }) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + t;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  },
  // 短噪声：模拟"啪"的拍击声
  noise({ t = 0, dur = 0.08, vol = 0.28, freq = 2400 }) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + t;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let k = 0; k < len; k++) data[k] = (Math.random() * 2 - 1) * (1 - k / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(g).connect(ctx.destination);
    src.start(t0);
  },
  hit() {   // 命中：短促"啪" + 上扬"喵"滑音
    this.noise({ dur: 0.07, vol: 0.3, freq: 2400 });
    this.tone({ freq: 420, endFreq: 980, type: 'triangle', t: 0.02, dur: 0.16, vol: 0.2 });
  },
  wrong() { // 误拍装睡纳尔：低沉"呜"
    this.tone({ freq: 240, endFreq: 90, type: 'sawtooth', dur: 0.3, vol: 0.14 });
    this.tone({ freq: 120, endFreq: 55, type: 'sine', dur: 0.34, vol: 0.2 });
  },
  combo(n) { // 连击达成：清脆铃声，连击越高音越高
    const base = 660 + Math.min(n, 12) * 40;
    this.tone({ freq: base, type: 'sine', dur: 0.14, vol: 0.15 });
    this.tone({ freq: base * 1.5, type: 'sine', t: 0.09, dur: 0.22, vol: 0.12 });
  },
  over() {  // 本局结束：下滑音
    this.tone({ freq: 392, endFreq: 196, type: 'triangle', dur: 0.5, vol: 0.16 });
  },
};

/* ==================== state：全局状态 ==================== */
const state = {
  screen: 'start',
  running: false,
  score: 0,
  lives: CONFIG.lives,
  level: 1,
  combo: 0,
  bestCombo: 0,
  lastHitAt: 0,
  hits: 0,      // 有效命中数
  misses: 0,    // 漏掉的普通/快速纳尔数
  wrongs: 0,    // 误拍装睡纳尔次数
  spawned: 0,
  levelDeadline: 0,
  rageUntil: 0,
  spawnTask: null,
  levelTask: null,
  best: Number(localStorage.getItem(CONFIG.storage.best) || 0),
  muted: localStorage.getItem(CONFIG.storage.muted) === '1',
};

/* ==================== Assets：预加载与兜底 ==================== */
const Assets = {
  base: './assets/nar/',
  names: [
    'peek-1.webp', 'peek-2.webp', 'up-1.webp', 'up-2.webp',
    'hit-1.webp', 'sleep-1.webp', 'rage-1.webp',
    'avatar.webp', 'decor-1.webp',
  ],
  broken: new Set(),   // 加载失败的照片名
  url: (name) => Assets.base + name,
  preload() {
    return Promise.all(this.names.map((name) => new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve();
      im.onerror = () => { this.broken.add(name); resolve(); };
      im.src = this.url(name);
    })));
  },
};

/* ==================== DOM 引用 ==================== */
const els = {
  startScreen: $('#screen-start'),
  gameScreen: $('#screen-game'),
  overScreen: $('#screen-over'),
  score: $('#hud-score'),
  lives: $('#hud-lives'),
  level: $('#hud-level'),
  timer: $('#hud-timer'),
  mute: $('#btn-mute'),
  comboBadge: $('#combo-badge'),
  comboN: $('#combo-n'),
  yard: $('#yard'),
  board: $('#board'),
  toast: $('#level-toast'),
  pauseMask: $('#pause-mask'),
  bestStart: $('#best-start'),
  overScore: $('#over-score'),
  overCombo: $('#over-combo'),
  overAcc: $('#over-acc'),
  overBestScore: $('#over-best-score'),
  overRecord: $('#over-record'),
  confetti: $('#confetti'),
  avatarFrameStart: $('#avatar-frame-start'),
  avatarFrameOver: $('#avatar-frame-over'),
  fenceCat: $('#fence-cat'),
};

/* ==================== CSS 奶牛猫兜底（照片缺失时启用） ==================== */
const CAT_CSS_HTML = `
  <div class="ear l"></div><div class="ear r"></div>
  <div class="head">
    <div class="blaze"></div>
    <div class="eye l"><i></i></div>
    <div class="eye r"><i></i></div>
    <div class="nose"></div>
    <div class="mouth"></div>
    <div class="whisk w1"></div><div class="whisk w2"></div>
    <div class="whisk w3"></div><div class="whisk w4"></div>
  </div>
  <div class="body"><div class="chest"></div><div class="paw l"></div><div class="paw r"></div></div>`;

/* ==================== 棋盘 ==================== */
const holes = [];

function buildBoard() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 9; i++) {
    const el = document.createElement('div');
    el.className = 'hole';
    el.dataset.i = String(i);
    el.innerHTML = `
      <div class="hole__mound"></div>
      <div class="hole__lift">
        <div class="hole__sprite">
          <div class="spr-frame">
            <img class="spr spr-peek" alt="">
            <img class="spr spr-up" alt="">
            <img class="spr spr-hit" alt="">
            <img class="spr spr-rage" alt="">
            <img class="spr spr-sleep" alt="">
            <div class="spr spr-css cat-css">${CAT_CSS_HTML}</div>
          </div>
          <span class="badge bolt" aria-hidden="true"></span>
          <span class="badge zzz" aria-hidden="true">💤</span>
          <div class="eyelid l" aria-hidden="true"></div>
          <div class="eyelid r" aria-hidden="true"></div>
        </div>
      </div>
      <div class="hole__opening"></div>
      <button class="hole__hit" type="button" aria-label="拍纳尔"></button>`;

    const sprite = el.querySelector('.hole__sprite');
    const sprFrame = el.querySelector('.spr-frame');
    const imgs = {
      peek: el.querySelector('.spr-peek'),
      up: el.querySelector('.spr-up'),
      hit: el.querySelector('.spr-hit'),
      rage: el.querySelector('.spr-rage'),
      sleep: el.querySelector('.spr-sleep'),
    };
    const cssCat = el.querySelector('.spr-css');

    const hole = {
      i,
      el,
      sprite,
      sprFrame,
      imgs,
      cssCat,
      busy: false,
      form: null,
      awake: false,
      hitDone: false,
      retractTask: null,   // 缩回计时器单独管理，避免误杀出洞切换等任务
      tasks: new Set(),
    };

    // 该洞专属的计时器：统一走 Scheduler，可随洞一起清理
    hole.after = (ms, cb) => {
      let ref;
      ref = Scheduler.add(ms, () => {
        hole.tasks.delete(ref);
        cb();
      });
      hole.tasks.add(ref);
      return ref;
    };
    hole.clearTimers = () => {
      hole.tasks.forEach((t) => Scheduler.clear(t));
      hole.tasks.clear();
    };

    // 照片加载失败 → 登记损坏，当前显示的照片立即切换为 CSS 猫
    Object.entries(imgs).forEach(([key, img]) => {
      img.addEventListener('error', () => {
        if (img.dataset.name) Assets.broken.add(img.dataset.name);
        if (img.classList.contains('show')) setSpr(hole, 'css');
      });
    });

    const hitBtn = el.querySelector('.hole__hit');
    hitBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      onHit(i);
    });

    holes.push(hole);
    frag.appendChild(el);
  }
  els.board.appendChild(frag);
}

/* 切换精灵显示的照片；目标照片损坏时退化为 CSS 奶牛猫 */
function setSpr(hole, which) {
  const frame = hole.sprFrame;
  frame.querySelectorAll('.spr').forEach((el) => el.classList.remove('show'));
  const target = which === 'css' ? hole.cssCat : hole.imgs[which];
  if (target && target.tagName === 'IMG' && Assets.broken.has(target.dataset.name)) {
    hole.cssCat.classList.add('show');
    return;
  }
  if (target) target.classList.add('show');
  else hole.cssCat.classList.add('show');
}

/* ==================== 关卡难度曲线 ==================== */
function levelParams(level) {
  const s = CONFIG.spawn;
  const interval = Math.max(s.minInterval, s.baseInterval * Math.pow(1 - s.intervalDecay, level - 1));
  const fast = Math.min(CONFIG.fastRatio.max, CONFIG.fastRatio.base + CONFIG.fastRatio.step * (level - 1));
  const sleep = Math.min(CONFIG.sleepRatio.max, CONFIG.sleepRatio.base + CONFIG.sleepRatio.step * (level - 1));
  const stayMul = Math.max(CONFIG.stayScale.min, 1 - CONFIG.stayScale.step * (level - 1));
  return { interval, fast, sleep, normal: 1 - fast - sleep, stayMul };
}

/* ==================== 出洞 / 缩回 ==================== */
function spawnCat(i, form) {
  const h = holes[i];
  if (h.busy) return false;
  h.clearTimers();
  clearRetract(h);
  h.busy = true;
  h.form = form;
  h.awake = false;
  h.hitDone = false;
  h.el.classList.remove('is-leaving', 'is-wrong', 'eyes-open');
  h.sprite.classList.remove('is-hit', 'is-rage', 'is-sleep');
  h.sprFrame.classList.remove('squash');

  // 每组 [探头照, 升起照] 同源，出洞过程画面连续
  const pair = pick(CONFIG.assets.peekPairs);
  assignImg(h.imgs.peek, pair[0]);
  assignImg(h.imgs.up, pair[1]);
  assignImg(h.imgs.hit, CONFIG.assets.hit);   // 被打表情照，命中时切换

  if (form === 'sleep') {
    assignImg(h.imgs.sleep, CONFIG.assets.sleep);
    h.el.classList.add('is-sleep');
    h.sprite.classList.add('is-sleep');
    setSpr(h, 'sleep');
  } else if (form === 'rage') {
    assignImg(h.imgs.rage, CONFIG.assets.rage);
    h.el.classList.add('is-rage');
    h.sprite.classList.add('is-rage');
    setSpr(h, 'rage');
  } else {
    setSpr(h, 'peek');
    if (form === 'fast') h.el.classList.add('is-fast');
  }
  state.spawned++;

  h.el.classList.add('is-active');
  h.after(CONFIG.riseMs, () => {
    if (!h.busy) return;
    if (h.form === 'normal' || h.form === 'fast') setSpr(h, 'up');
  });

  const stay = CONFIG.forms[form].stay * (form === 'rage' ? 1 : levelParams(state.level).stayMul);

  if (form === 'sleep') {
    // 装睡纳尔周期性偷偷睁眼；睡饱后醒来变成普通纳尔
    const peek = () => {
      if (!h.busy || h.form !== 'sleep' || h.awake) return;
      h.el.classList.add('eyes-open');
      h.after(CONFIG.sleepPeekMs, () => h.el.classList.remove('eyes-open'));
    };
    h.after(420, peek);
    h.after(900, peek);
    h.after(CONFIG.riseMs + stay, () => wakeUp(h));
  } else {
    scheduleRetract(h, CONFIG.riseMs + stay);
  }
  return true;
}

function assignImg(img, name) {
  img.dataset.name = name;
  const url = Assets.url(name);
  if (img.getAttribute('src') !== url) img.src = url;
}

function wakeUp(h) {
  if (!h.busy || h.form !== 'sleep') return;
  h.awake = true;
  h.el.classList.remove('is-sleep', 'eyes-open');
  h.sprite.classList.remove('is-sleep');
  setSpr(h, 'up');   // 眼睛睁开的瞬间：切换回普通纳尔
  scheduleRetract(h, CONFIG.sleepWakeExtraMs);
}

function scheduleRetract(h, delay) {
  clearRetract(h);
  h.retractTask = Scheduler.add(delay, () => {
    h.retractTask = null;
    retract(h, true);
  });
}

function clearRetract(h) {
  if (h.retractTask) {
    Scheduler.clear(h.retractTask);
    h.retractTask = null;
  }
}

function retract(h, countMiss) {
  if (!h.busy) return;
  const form = h.form;
  h.clearTimers();
  clearRetract(h);
  h.el.classList.remove('is-active', 'eyes-open');
  h.el.classList.add('is-leaving');
  h.after(CONFIG.fallMs, () => {
    h.el.classList.remove('is-leaving', 'is-fast', 'is-sleep', 'is-rage', 'is-wrong');
    h.sprite.classList.remove('is-sleep', 'is-rage', 'is-hit');
    h.sprFrame.classList.remove('squash');
    h.busy = false;
    h.form = null;
  });
  // 漏掉快速纳尔扣 1 命；漏掉普通纳尔不扣命
  if (countMiss && !h.hitDone) {
    if (form === 'fast') {
      state.misses++;
      loseLife();
    } else if (form === 'normal') {
      state.misses++;
    }
  }
}

/* ==================== 连击与暴走 ==================== */
function resetCombo() {
  state.combo = 0;
  updateCombo();
}

function updateCombo() {
  if (state.combo >= 2) {
    els.comboN.textContent = state.combo;
    if (els.comboBadge.classList.contains('hidden')) {
      els.comboBadge.classList.remove('hidden');
    } else {
      // 重新弹一下
      els.comboBadge.style.animation = 'none';
      void els.comboBadge.offsetWidth;
      els.comboBadge.style.animation = '';
    }
  } else {
    els.comboBadge.classList.add('hidden');
  }
}

function triggerRage() {
  const now = performance.now();
  if (state.rageUntil > now) return;   // 暴走中不重复触发
  state.rageUntil = now + CONFIG.rageDuration;
  sfx.combo(5);
  toast('纳尔暴走！九洞齐冒！');
  els.yard.classList.add('rage');
  holes.forEach((h) => { if (!h.busy) spawnCat(h.i, 'rage'); });
  if (state.spawnTask) {
    Scheduler.clear(state.spawnTask);
    state.spawnTask = null;
  }
  Scheduler.add(CONFIG.rageDuration, () => {
    els.yard.classList.remove('rage');
    state.rageUntil = 0;
    if (state.running) scheduleSpawn(260);
  });
}

/* ==================== 命中判定 ==================== */
function onHit(i) {
  if (!state.running) return;
  const h = holes[i];
  sfx.ensure();

  if (!h.busy || h.hitDone) {   // 空拍：只飘一点尘土
    puff(h);
    return;
  }

  if (h.form === 'sleep' && !h.awake) {
    // 误拍装睡纳尔：扣 15 分 + 扣 1 命
    state.wrongs++;
    h.hitDone = true;
    addScore(-CONFIG.wrongPenalty);
    loseLife();
    resetCombo();
    h.el.classList.add('is-wrong');
    setSpr(h, 'hit');          // 被打的委屈脸
    showPopup(h, '-' + CONFIG.wrongPenalty, 'bad');
    sfx.wrong();
    shakeYard();
    scheduleRetract(h, 420);
    return;
  }

  // 有效命中：普通 / 快速 / 睡醒后的纳尔 / 暴走纳尔
  h.hitDone = true;
  state.hits++;
  const now = performance.now();
  state.combo = (state.combo > 0 && now - state.lastHitAt <= CONFIG.comboWindow)
    ? state.combo + 1
    : 1;
  state.lastHitAt = now;
  state.bestCombo = Math.max(state.bestCombo, state.combo);

  // 睡醒后的纳尔按普通纳尔计分
  const gain = CONFIG.forms[h.form === 'sleep' ? 'normal' : h.form].score;
  addScore(gain);
  showPopup(h, '+' + gain, state.combo >= 2 ? 'gold' : '');
  sfx.hit();
  h.sprFrame.classList.add('squash');       // 被拍中的纳尔压扁
  h.sprite.classList.add('is-hit');
  if (h.form !== 'rage') setSpr(h, 'hit');  // 换成委屈表情
  shakeYard();
  updateCombo();
  if (state.combo >= CONFIG.comboPerRage && state.combo % CONFIG.comboPerRage === 0) {
    triggerRage();
  } else if (state.combo >= 2) {
    sfx.combo(state.combo);
  }
  scheduleRetract(h, CONFIG.hitShowMs);
}

function addScore(delta) {
  state.score = Math.max(0, state.score + delta);
  render();
}

function loseLife() {
  state.lives = Math.max(0, state.lives - 1);
  render();
  const chip = els.lives.closest('.chip');
  chip.classList.remove('flash');
  void chip.offsetWidth;
  chip.classList.add('flash');
  Scheduler.add(520, () => chip.classList.remove('flash'));
  if (state.lives <= 0) {
    Scheduler.add(430, gameOver);
  }
}

/* ==================== spawnLoop：出洞调度 ==================== */
function scheduleSpawn(delay) {
  if (state.spawnTask) Scheduler.clear(state.spawnTask);
  state.spawnTask = Scheduler.add(delay, () => {
    state.spawnTask = null;
    if (!state.running) return;
    doSpawn();
    const p = levelParams(state.level);
    scheduleSpawn(p.interval * (1 + rand(-CONFIG.spawn.jitter, CONFIG.spawn.jitter)));
  });
}

function doSpawn() {
  if (performance.now() < state.rageUntil) return;   // 暴走期间只冒暴走纳尔
  const free = holes.filter((h) => !h.busy);
  if (!free.length) return;
  const active = holes.length - free.length;
  const cap = Math.min(CONFIG.spawn.maxConcurrent + Math.floor((state.level - 1) / 2), 5);
  if (active >= cap) return;
  const p = levelParams(state.level);
  const r = Math.random();
  let form = 'normal';
  if (r < p.fast) form = 'fast';
  else if (r < p.fast + p.sleep) form = 'sleep';
  spawnCat(pick(free).i, form);
}

/* ==================== 关卡计时 ==================== */
function startLevel() {
  state.levelDeadline = performance.now() + CONFIG.levelDuration;
  levelTick();
}

function levelTick() {
  if (!state.running) return;
  const left = state.levelDeadline - performance.now();
  els.timer.textContent = String(Math.max(0, Math.ceil(left / 1000)));
  if (left <= 0) {
    state.level++;
    if (state.level > CONFIG.endlessAfterLevel) toast('无尽模式 · 纳尔记仇中');
    else toast('第 ' + state.level + ' 关！难度提升');
    render();
    startLevel();
  } else {
    state.levelTask = Scheduler.add(250, levelTick);
  }
}

/* ==================== render：HUD 渲染 ==================== */
function render() {
  els.score.textContent = state.score;
  els.level.textContent = state.level > CONFIG.endlessAfterLevel ? '∞' : String(state.level);
  els.lives.innerHTML = Array.from({ length: CONFIG.lives }, (_, k) =>
    '<span class="heart' + (k < state.lives ? '' : ' off') + '">♥</span>').join('');
  els.bestStart.textContent = state.best;
}

/* ==================== 表现层：飘字 / 提示 / 震动 / 撒花 ==================== */
function showPopup(h, text, cls) {
  const s = document.createElement('span');
  s.className = 'pop' + (cls ? ' ' + cls : '');
  s.textContent = text;
  h.el.appendChild(s);
  s.addEventListener('animationend', () => s.remove(), { once: true });
  Scheduler.add(780, () => s.remove());   // 双保险：动画被禁用时也能回收
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  els.toast.style.animation = 'none';
  void els.toast.offsetWidth;
  els.toast.style.animation = '';
  Scheduler.add(1300, () => els.toast.classList.add('hidden'));
}

function shakeYard() {
  els.yard.classList.remove('shake');
  void els.yard.offsetWidth;
  els.yard.classList.add('shake');
  Scheduler.add(200, () => els.yard.classList.remove('shake'));
}

function puff(h) {
  h.el.classList.remove('puff');
  void h.el.offsetWidth;
  h.el.classList.add('puff');
  Scheduler.add(320, () => h.el.classList.remove('puff'));
}

function fireConfetti() {
  const colors = ['#ffd54a', '#ff7043', '#64b5f6', '#81c784', '#ba68c8', '#ffffff'];
  for (let k = 0; k < 42; k++) {
    const i = document.createElement('i');
    i.style.left = Math.random() * 100 + '%';
    i.style.background = pick(colors);
    i.style.animationDuration = (1.4 + Math.random() * 1.2).toFixed(2) + 's';
    i.style.animationDelay = (Math.random() * 0.5).toFixed(2) + 's';
    els.confetti.appendChild(i);
  }
  Scheduler.add(3400, () => { els.confetti.innerHTML = ''; });
}

/* ==================== 流程：开始 / 结束 / 界面切换 ==================== */
function showScreen(name) {
  state.screen = name;
  els.startScreen.classList.toggle('hidden', name !== 'start');
  els.gameScreen.classList.toggle('hidden', name !== 'game');
  els.overScreen.classList.toggle('hidden', name !== 'over');
}

function startGame() {
  sfx.ensure();
  Object.assign(state, {
    score: 0, lives: CONFIG.lives, level: 1, combo: 0, bestCombo: 0,
    lastHitAt: 0, hits: 0, misses: 0, wrongs: 0, spawned: 0,
    rageUntil: 0, running: true,
  });
  holes.forEach((h) => {
    h.clearTimers();
    clearRetract(h);
    h.el.classList.remove('is-active', 'is-leaving', 'is-fast', 'is-sleep', 'is-rage', 'is-wrong', 'eyes-open');
    h.sprite.classList.remove('is-sleep', 'is-rage', 'is-hit');
    h.sprFrame.classList.remove('squash');
    h.busy = false;
    h.form = null;
    h.awake = false;
    h.hitDone = false;
  });
  els.yard.classList.remove('rage', 'shake');
  showScreen('game');
  render();
  updateCombo();
  els.timer.textContent = String(CONFIG.levelDuration / 1000);
  scheduleSpawn(650);
  startLevel();
}

function gameOver() {
  if (!state.running) return;
  state.running = false;
  if (state.spawnTask) { Scheduler.clear(state.spawnTask); state.spawnTask = null; }
  if (state.levelTask) { Scheduler.clear(state.levelTask); state.levelTask = null; }
  holes.forEach((h) => {
    if (h.busy) {
      h.hitDone = true;
      retract(h, false);
    }
  });

  const isRecord = state.score > state.best;
  if (isRecord) {
    state.best = state.score;
    localStorage.setItem(CONFIG.storage.best, String(state.best));
  }

  const total = state.hits + state.misses + state.wrongs;
  els.overScore.textContent = state.score;
  els.overCombo.textContent = '×' + state.bestCombo;
  els.overAcc.textContent = total ? Math.round((state.hits / total) * 100) + '%' : '0%';
  els.overBestScore.textContent = state.best;
  els.overRecord.classList.toggle('hidden', !(isRecord && state.score > 0));
  if (isRecord && state.score > 0) fireConfetti();
  sfx.over();
  showScreen('over');
  render();
}

/* ==================== 社交分享彩蛋：canvas 战报 ==================== */
function drawCatFace(x, cx, cy, r) {
  // 头像照片缺失时，用 canvas 现画一只奶牛猫
  x.fillStyle = '#1d1d1f';
  x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#fff';
  x.beginPath();
  x.moveTo(cx, cy - r * 0.95);
  x.lineTo(cx + r * 0.62, cy + r * 0.28);
  x.lineTo(cx + r * 0.34, cy + r * 0.95);
  x.lineTo(cx - r * 0.34, cy + r * 0.95);
  x.lineTo(cx - r * 0.62, cy + r * 0.28);
  x.closePath(); x.fill();
  ['#b9c93f', '#b9c93f'].forEach((c, k) => {
    x.fillStyle = c;
    x.beginPath();
    x.arc(cx + (k ? 1 : -1) * r * 0.46, cy - r * 0.12, r * 0.16, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = '#10100f';
    x.beginPath();
    x.arc(cx + (k ? 1 : -1) * r * 0.46, cy - r * 0.12, r * 0.06, 0, Math.PI * 2);
    x.fill();
  });
  x.fillStyle = '#f2a0b5';
  x.beginPath();
  x.ellipse(cx, cy + r * 0.4, r * 0.1, r * 0.07, 0, 0, Math.PI * 2);
  x.fill();
}

function shareCard() {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 860;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 860);
  g.addColorStop(0, '#a8dcff');
  g.addColorStop(0.55, '#ddf3c6');
  g.addColorStop(1, '#a5d977');
  x.fillStyle = g;
  x.fillRect(0, 0, 640, 860);

  // 圆形头像（优先用纳尔照片，缺失则现画）
  const cx = 320;
  const cy = 215;
  const r = 112;
  x.save();
  x.beginPath();
  x.arc(cx, cy, r, 0, Math.PI * 2);
  x.closePath();
  x.clip();
  const avatar = document.querySelector('#avatar-frame-start img');
  if (avatar && avatar.complete && avatar.naturalWidth > 0 && !Assets.broken.has('avatar.webp')) {
    const ar = avatar.naturalWidth / avatar.naturalHeight;
    let dw = r * 2;
    let dh = dw / ar;
    if (dh < r * 2) { dh = r * 2; dw = dh * ar; }
    x.drawImage(avatar, cx - dw / 2, cy - dh / 2 - r * 0.12, dw, dh);
  } else {
    drawCatFace(x, cx, cy, r * 0.9);
  }
  x.restore();
  x.lineWidth = 9;
  x.strokeStyle = '#ffffff';
  x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.stroke();
  x.lineWidth = 5;
  x.strokeStyle = '#ffd54a';
  x.beginPath(); x.arc(cx, cy, r + 8, 0, Math.PI * 2); x.stroke();

  x.textAlign = 'center';
  x.fillStyle = '#2e4a1c';
  x.font = '800 44px "PingFang SC", "Microsoft YaHei", sans-serif';
  x.fillText('打地鼠 · 纳尔篇', cx, 410);
  x.font = '600 24px "PingFang SC", "Microsoft YaHei", sans-serif';
  x.fillStyle = '#5b7a48';
  x.fillText('一只叫纳尔的奶牛猫在线求拍', cx, 452);

  x.fillStyle = '#ffffff';
  const roundRect = (rx, ry, rw, rh, rr) => {
    x.beginPath();
    x.moveTo(rx + rr, ry);
    x.arcTo(rx + rw, ry, rx + rw, ry + rh, rr);
    x.arcTo(rx + rw, ry + rh, rx, ry + rh, rr);
    x.arcTo(rx, ry + rh, rx, ry, rr);
    x.arcTo(rx, ry, rx + rw, ry, rr);
    x.closePath();
  };
  roundRect(120, 500, 400, 190, 26);
  x.fill();

  x.fillStyle = '#5b7a48';
  x.font = '26px "PingFang SC", "Microsoft YaHei", sans-serif';
  x.textAlign = 'left';
  x.fillText('本局得分', 160, 552);
  x.fillText('最高连击', 160, 606);
  x.fillText('命中率', 160, 660);
  x.fillStyle = '#2e4a1c';
  x.font = '800 34px "PingFang SC", "Microsoft YaHei", sans-serif';
  x.textAlign = 'right';
  x.fillText(String(state.score), 480, 552);
  x.fillText('×' + state.bestCombo, 480, 606);
  const total = state.hits + state.misses + state.wrongs;
  x.fillText(total ? Math.round((state.hits / total) * 100) + '%' : '0%', 480, 660);

  x.textAlign = 'center';
  x.fillStyle = '#3c5a2a';
  x.font = '22px "PingFang SC", "Microsoft YaHei", sans-serif';
  const d = new Date();
  x.fillText(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'), cx, 740);
  x.fillStyle = '#6b7f5c';
  x.font = '20px "PingFang SC", "Microsoft YaHei", sans-serif';
  x.fillText('纳尔说：拍完要负责', cx, 790);

  const a = document.createElement('a');
  a.download = '打地鼠纳尔篇-战报.png';
  a.href = c.toDataURL('image/png');
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ==================== 事件绑定 ==================== */
function bindEvents() {
  $('#btn-start').addEventListener('click', startGame);
  $('#btn-again').addEventListener('click', startGame);
  $('#btn-home').addEventListener('click', () => { showScreen('start'); render(); });
  $('#btn-share').addEventListener('click', shareCard);
  els.mute.addEventListener('click', toggleMute);
  els.board.addEventListener('contextmenu', (e) => e.preventDefault());

  // 页面切走自动暂停，回来继续（截止时间整体后移，不会计时器爆炸）
  document.addEventListener('visibilitychange', () => {
    if (!state.running) return;
    if (document.hidden) {
      Scheduler.pause();
      els.gameScreen.classList.add('paused');
      els.pauseMask.classList.add('show');
    } else {
      Scheduler.resume();
      els.gameScreen.classList.remove('paused');
      els.pauseMask.classList.remove('show');
      render();
    }
  });
}

function toggleMute() {
  state.muted = !state.muted;
  sfx.muted = state.muted;
  localStorage.setItem(CONFIG.storage.muted, state.muted ? '1' : '0');
  els.mute.textContent = state.muted ? '🔇' : '🔊';
  if (!state.muted) {
    sfx.ensure();
    sfx.combo(2);
  }
}

/* ==================== 初始化 ==================== */
function init() {
  buildBoard();

  // 头像照片加载失败 → 显示 CSS 奶牛猫兜底
  [els.avatarFrameStart, els.avatarFrameOver].forEach((frame) => {
    const img = frame.querySelector('img');
    if (img) {
      img.addEventListener('error', () => frame.classList.add('broken'));
      if (img.complete && img.naturalWidth === 0) frame.classList.add('broken');
    }
    const holder = frame.querySelector('.cat-css');
    if (holder && !holder.children.length) holder.innerHTML = CAT_CSS_HTML;
  });
  // 篱笆上的纳尔加载失败 → 直接隐藏（纯装饰）
  els.fenceCat.addEventListener('error', () => els.fenceCat.classList.add('hidden'));

  bindEvents();
  Assets.preload();      // 页面加载即预加载全部照片
  sfx.muted = state.muted;
  els.mute.textContent = state.muted ? '🔇' : '🔊';
  showScreen('start');
  render();
}

init();

/* 调试/自动化测试出口：只读状态与句柄，不参与游戏逻辑 */
window.__nar = { state, CONFIG, holes, Scheduler, Assets, spawnCat, onHit, triggerRage };
