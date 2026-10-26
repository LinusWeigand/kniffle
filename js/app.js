import {
  UPPER, LOWER, CATEGORIES, ROLLS_PER_TURN, BONUS_THRESHOLD, BONUS,
  GameError, scoreFor, totals, currentRound, ranking, cleanName,
  newGame, addPlayer, dropPlayer, applyAction,
} from './game.js';
import { t, lang, setLang, catName, catHint } from './i18n.js';
import { HostNet, GuestNet, makeCode } from './net.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const storage = (area) => ({
  get(k) { try { return window[area].getItem(k); } catch { return null; } },
  set(k, v) { try { window[area].setItem(k, v); } catch {} },
  del(k) { try { window[area].removeItem(k); } catch {} },
});
const local = storage('localStorage');
const session = storage('sessionStorage'); // per tab, survives reloads

const me = {
  id: session.get('kniffel.pid') || crypto.randomUUID().slice(0, 12),
  name: local.get('kniffel.name') || '',
};
session.set('kniffel.pid', me.id);

const PIPS = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

let role = null; // 'host' | 'guest'
let code = null;
let net = null;
let state = null;
let netStatus = 'connecting';
let screen = null;
let selectedCat = null;
let lastRollSeq = -1;
let flashKey = null;
const lastSeen = new Map(); // pid -> ms timestamp of their last message (host only)
const GUEST_TIMEOUT = 70000;

const app = $('#app');
const subnav = $('#subnav');
const banner = $('#banner');
const sticky = $('#sticky');
const toastEl = $('#toast');

// ---------- shared bits ----------

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function dieHTML(value, extra = '') {
  const on = PIPS[value] || [];
  const pips = Array.from({ length: 9 }, (_, i) => `<span class="pip${on.includes(i) ? ' on' : ''}"></span>`).join('');
  return `<button class="die ${extra}" data-v="${value}" aria-label="${value}">${pips}</button>`;
}

function setFace(el, value) {
  el.dataset.v = value;
  el.setAttribute('aria-label', value);
  const on = PIPS[value];
  el.querySelectorAll('.pip').forEach((p, i) => p.classList.toggle('on', on.includes(i)));
}

function tumble(el, finalValue, delay) {
  clearInterval(el._spin);
  el.classList.remove('rolling');
  void el.offsetWidth;
  el.style.animationDelay = `${delay}ms`;
  el.classList.add('rolling');
  let frames = 0;
  el._spin = setInterval(() => {
    if (++frames > 8) {
      clearInterval(el._spin);
      el._spin = null;
      setFace(el, finalValue);
    } else {
      setFace(el, 1 + Math.floor(Math.random() * 6));
    }
  }, 70);
}

function shareLink() {
  return `${location.origin}${location.pathname}#${code}`;
}

function setHash(value) {
  history.replaceState(null, '', value ? `#${value}` : location.pathname + location.search);
}

function renderNav() {
  $('#lang').textContent = lang === 'de' ? 'EN' : 'DE';
  $('#lang').setAttribute('aria-label', lang === 'de' ? 'Switch to English' : 'Auf Deutsch umschalten');
}

function renderBanner() {
  const messages = {
    connecting: role === 'guest' && !state ? null : t('connecting'),
    reconnecting: t('reconnecting'),
    'host-offline': t('hostOffline'),
  };
  const msg = role ? messages[netStatus] : null;
  banner.textContent = msg || '';
  banner.hidden = !msg;
}

function renderSubnav() {
  if (!role || !state) {
    subnav.hidden = true;
    return;
  }
  subnav.hidden = false;
  const meta = state.phase === 'playing' ? t('round', { n: currentRound(state) }) : '';
  subnav.innerHTML = `
    <span class="subnav-title">${t('room')} ${esc(code)}</span>
    <div class="subnav-right">
      <span class="subnav-meta">${meta}</span>
      <button class="link-btn" id="leave">${t('leave')}</button>
    </div>`;
  $('#leave').onclick = leave;
}

// ---------- landing / join / error ----------

function introTiles() {
  const catRows = (cats) => cats.map((c) => `<li><span>${catName(c)}</span><span class="muted">${catHint(c)}</span></li>`).join('');
  return `
    <section class="tile tile-dark">
      <div class="dice showcase" id="showcase">${[1, 2, 3, 4, 5].map((v) => dieHTML(v)).join('')}</div>
    </section>
    <section class="tile tile-parchment">
      <h2 class="display-lg">${t('howTitle')}</h2>
      <div class="cards">
        ${[1, 2, 3].map((n) => `
          <div class="card">
            <div class="card-num">${n}</div>
            <h3 class="body-strong">${t(`how${n}t`)}</h3>
            <p class="caption muted">${t(`how${n}`)}</p>
          </div>`).join('')}
      </div>
    </section>
    <section class="tile tile-light">
      <h2 class="display-lg">${t('rulesTitle')}</h2>
      <p class="prose">${t('rulesText')}</p>
      <div class="cards cards-2">
        <ul class="card rule-list">${catRows(UPPER)}<li class="rule-bonus"><span>${t('bonus')}</span><span class="muted">+${BONUS} ${t('bonusHint')}</span></li></ul>
        <ul class="card rule-list">${catRows(LOWER)}</ul>
      </div>
    </section>
    <footer class="footer">Kniffel · no sign-up · <a href="https://github.com/LinusWeigand/kniffle">GitHub</a></footer>`;
}

function bindShowcase() {
  const box = $('#showcase');
  if (!box) return;
  box.onclick = () => box.querySelectorAll('.die').forEach((el, i) => tumble(el, 1 + Math.floor(Math.random() * 6), i * 40));
}

function nameForm(buttonLabel, onSubmit) {
  const form = $('#name-form');
  const input = $('#name');
  input.value = me.name;
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = cleanName(input.value);
    if (!name) {
      input.focus();
      input.classList.remove('shake');
      void input.offsetWidth;
      input.classList.add('shake');
      return;
    }
    me.name = name;
    local.set('kniffel.name', name);
    onSubmit();
  };
  input.oninput = () => { me.name = input.value; };
  $('#name-submit').textContent = buttonLabel;
}

function renderLanding() {
  screen = 'landing';
  subnav.hidden = true;
  sticky.classList.remove('show');
  app.innerHTML = `
    <section class="tile tile-light hero">
      <h1 class="hero-title">Kniffel.</h1>
      <p class="lead">${t('tagline')}</p>
      <form class="form-row" id="name-form" autocomplete="off">
        <input class="input" id="name" maxlength="20" placeholder="${t('yourName')}" aria-label="${t('yourName')}" enterkeyhint="go">
        <button class="btn btn-primary" id="name-submit" type="submit"></button>
      </form>
    </section>
    ${introTiles()}`;
  nameForm(t('createGame'), createGame);
  bindShowcase();
}

function renderJoin(roomCode) {
  screen = 'join';
  code = roomCode;
  subnav.hidden = true;
  app.innerHTML = `
    <section class="tile tile-light hero">
      <h1 class="hero-title">${t('invited')}</h1>
      <p class="lead">${t('joinRoom', { code: esc(roomCode) })}</p>
      <form class="form-row" id="name-form" autocomplete="off">
        <input class="input" id="name" maxlength="20" placeholder="${t('yourName')}" aria-label="${t('yourName')}" enterkeyhint="go">
        <button class="btn btn-primary" id="name-submit" type="submit"></button>
      </form>
    </section>
    ${introTiles()}`;
  nameForm(t('joinGame'), () => startGuest(roomCode));
  bindShowcase();
  if (!me.name) $('#name').focus();
}

function renderMessage(title, body = '', withBack = false) {
  screen = 'message';
  app.innerHTML = `
    <section class="tile tile-light hero">
      <h1 class="display-lg">${title}</h1>
      ${body ? `<p class="lead lead-sm">${body}</p>` : ''}
      ${withBack ? `<div class="form-row"><button class="btn btn-primary" id="back">${t('back')}</button></div>` : ''}
    </section>`;
  if (withBack) $('#back').onclick = () => { setHash(''); renderLanding(); };
}

function fail(message) {
  net?.close();
  net = null;
  if (role === 'host') session.del('kniffel.host');
  session.del('kniffel.guest');
  role = null;
  state = null;
  subnav.hidden = true;
  sticky.classList.remove('show');
  renderBanner();
  renderMessage(message, '', true);
}

// ---------- session control ----------

function createGame() {
  const roomCode = makeCode();
  setHash(roomCode);
  startHosting(roomCode, newGame(me.id, me.name));
}

function startHosting(roomCode, initial) {
  role = 'host';
  code = roomCode;
  // After a reload every guest link is gone; they re-announce themselves when they reconnect.
  state = structuredClone(initial);
  if (state.phase === 'lobby') state.players = state.players.filter((p) => p.id === me.id);
  for (const p of state.players) p.connected = p.id === me.id;
  persistHost();
  netStatus = 'connecting';
  net = new HostNet(roomCode, { onStatus, onMessage: onGuestMessage });
  net.publishState(state);
  render();
}

// Guests ping every 20s and the broker sends a "bye" when their socket dies; this catches the rest.
setInterval(() => {
  if (role !== 'host' || !state) return;
  const now = Date.now();
  const stale = state.players.filter((p) => p.id !== me.id && p.connected && now - (lastSeen.get(p.id) ?? 0) > GUEST_TIMEOUT);
  if (stale.length) commit(stale.reduce((s, p) => dropPlayer(s, p.id), state));
}, 10000);

function startGuest(roomCode) {
  role = 'guest';
  code = roomCode;
  state = null;
  netStatus = 'connecting';
  session.set('kniffel.guest', roomCode);
  net = new GuestNet(roomCode, { pid: me.id, name: me.name }, { onStatus, onMessage: onHostMessage });
  render();
}

function leave() {
  if (!confirm(role === 'host' ? t('leaveConfirmHost') : t('leaveConfirm'))) return;
  net?.close();
  net = null;
  session.del('kniffel.host');
  session.del('kniffel.guest');
  role = null;
  state = null;
  lastSeen.clear();
  setHash('');
  renderBanner();
  renderLanding();
  window.scrollTo(0, 0);
}

function onStatus(status, err) {
  if (status === 'error') {
    if (role === 'guest' || err?.type === 'browser-incompatible') return fail(t('errPeer', { msg: esc(err?.message || err?.type || '') }));
    status = 'reconnecting';
  }
  netStatus = status;
  renderBanner();
  if (role === 'guest' && !state) render();
}

function persistHost() {
  session.set('kniffel.host', JSON.stringify({ code, state }));
}

// Host: apply a change, save it, and push the new state to every guest.
function commit(next) {
  const prev = state;
  state = next;
  persistHost();
  net.publishState(state);
  render(prev);
}

function hostApply(actorId, action) {
  try {
    commit(applyAction(state, actorId, action));
  } catch (e) {
    if (!(e instanceof GameError)) throw e;
    if (actorId !== me.id) net.sendTo(actorId, { t: 'error', code: e.code });
  }
}

function onGuestMessage(msg) {
  const pid = msg.pid.slice(0, 40);
  if (!pid || pid === me.id) return;
  lastSeen.set(pid, Date.now());
  const player = state.players.find((p) => p.id === pid);

  if (msg.t === 'hello' || (msg.t === 'ping' && player && !player.connected)) {
    try {
      commit(addPlayer(state, pid, msg.t === 'hello' ? msg.name : player.name));
    } catch (e) {
      if (!(e instanceof GameError)) throw e;
      net.sendTo(pid, { t: 'reject', reason: e.code });
    }
  } else if (msg.t === 'bye' && player?.connected) {
    commit(dropPlayer(state, pid));
  } else if (msg.t === 'action' && player && msg.action && typeof msg.action === 'object') {
    hostApply(pid, { type: msg.action.type, index: msg.action.index, cat: msg.action.cat });
  }
}

function onHostMessage(msg) {
  if (msg?.t === 'state' && msg.state) {
    const prev = state;
    state = msg.state;
    render(prev);
  } else if (msg?.t === 'reject') {
    fail(msg.reason === 'full' ? t('errFull') : t('errStarted'));
  } else if (msg?.t === 'closed') {
    fail(t('errClosed'));
  }
}

function dispatch(action) {
  if (role === 'host') hostApply(me.id, action);
  else net?.send({ t: 'action', action });
}

// ---------- rendering the live game ----------

function displayName(p) {
  return p.id === me.id ? t('you') : p.name;
}

// Toasts for things other people did, derived from the state diff so host and guests behave alike.
function announce(prev, next) {
  flashKey = null;
  if (!prev || !next) return;
  for (const p of next.players) {
    const before = prev.players.find((q) => q.id === p.id);
    if (p.id === me.id) continue;
    if ((!before || !before.connected) && p.connected) toast(t('joined', { name: p.name }));
    else if (before?.connected && !p.connected) toast(t('left', { name: p.name }));
  }
  for (const p of prev.players) {
    if (p.id !== me.id && !next.players.some((q) => q.id === p.id) && p.connected) toast(t('left', { name: p.name }));
  }
  if (next.last && next.last.seq !== prev.last?.seq) {
    flashKey = `${next.last.pid}:${next.last.cat}`;
    const who = next.players.find((p) => p.id === next.last.pid);
    if (who && who.id !== me.id) toast(t('scored', { name: who.name, value: next.last.value, cat: catName(next.last.cat) }));
  }
}

function render(prev) {
  announce(prev, state);
  renderSubnav();
  renderBanner();
  if (!state) {
    renderMessage(t('connecting'), netStatus === 'host-offline' ? t('hostOffline') : '');
    return;
  }
  if (state.phase === 'lobby') renderLobby();
  else renderGame();
  const mine = state.phase === 'playing' && state.players[state.turn]?.id === me.id;
  document.title = mine ? `🎲 ${t('yourTurn')} – Kniffel` : 'Kniffel';
}

function renderLobby() {
  screen = 'lobby';
  sticky.classList.remove('show');
  const host = state.players.find((p) => p.id === state.hostId);
  const isHost = role === 'host';
  const canShare = !!navigator.share;
  app.innerHTML = `
    <section class="tile tile-light hero">
      <h1 class="display-lg">${t('inviteTitle')}</h1>
      <p class="lead lead-sm">${t('inviteText')}</p>
      <div class="form-row">
        <input class="input input-link" id="link" readonly value="${esc(shareLink())}" aria-label="Link">
        <button class="btn btn-primary" id="copy">${t('copy')}</button>
        ${canShare ? `<button class="btn btn-secondary" id="share">${t('share')}</button>` : ''}
      </div>
    </section>
    <section class="tile tile-parchment tile-tight">
      <div class="card players-card">
        <h2 class="caption-strong muted">${t('players')} · ${state.players.length}/6</h2>
        <ul class="players">
          ${state.players.map((p) => `
            <li>
              <span class="avatar">${esc(p.name.slice(0, 1).toUpperCase())}</span>
              <span class="player-name">${esc(p.name)}</span>
              ${p.id === me.id ? `<span class="tag">${t('you')}</span>` : ''}
              ${p.id === state.hostId ? `<span class="tag">${t('host')}</span>` : ''}
              <span class="dot ${p.connected ? 'on' : ''}"></span>
            </li>`).join('')}
        </ul>
      </div>
      <div class="form-row">
        ${isHost
          ? `<button class="btn btn-primary btn-hero" id="start">${state.players.length > 1 ? t('start') : t('startSolo')}</button>`
          : `<p class="muted">${t('waitingHost', { name: esc(host?.name || 'Host') })}</p>`}
      </div>
    </section>`;
  $('#link').onclick = (e) => e.target.select();
  $('#copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(shareLink());
    } catch {
      $('#link').select();
      document.execCommand('copy');
    }
    $('#copy').textContent = t('copied');
    setTimeout(() => { const b = $('#copy'); if (b) b.textContent = t('copy'); }, 1600);
  };
  if (canShare) $('#share').onclick = () => navigator.share({ title: 'Kniffel', url: shareLink() }).catch(() => {});
  if (isHost) $('#start').onclick = () => dispatch({ type: 'start' });
}

function renderGame() {
  if (screen !== 'game') {
    screen = 'game';
    lastRollSeq = -1;
    app.innerHTML = `
      <div class="game">
        <section class="table on-dark" id="table"></section>
        <section class="sheet" id="sheet"></section>
      </div>`;
  }
  const myTurn = state.phase === 'playing' && state.players[state.turn]?.id === me.id;
  if (!myTurn || state.rolls === 0 || state.rollSeq !== lastRollSeq) selectedCat = null;
  renderTable();
  renderSheet();
  renderSticky();
}

function renderTable() {
  const table = $('#table');
  if (state.phase === 'finished') {
    table.dataset.mode = 'finished';
    const ranked = ranking(state);
    const best = ranked[0].total;
    const winners = ranked.filter((r) => r.total === best);
    const title = winners.length > 1 ? t('tie') : winners[0].id === me.id ? t('youWin') : t('wins', { name: esc(winners[0].name) });
    const host = state.players.find((p) => p.id === state.hostId);
    table.innerHTML = `
      <h1 class="display-lg">${title}</h1>
      <ol class="ranking">
        ${ranked.map((r, i) => `<li class="${r.total === best ? 'top' : ''}"><span class="rank">${i + 1}</span><span class="rank-name">${esc(displayName(r))}</span><span class="rank-score">${r.total}</span></li>`).join('')}
      </ol>
      ${role === 'host'
        ? `<button class="btn btn-primary btn-hero" id="again">${t('playAgain')}</button>`
        : `<p class="hint">${t('waitingRematch', { name: esc(host?.name || 'Host') })}</p>`}`;
    if (role === 'host') $('#again').onclick = () => dispatch({ type: 'start' });
    return;
  }

  if (table.dataset.mode !== 'playing') {
    table.dataset.mode = 'playing';
    lastRollSeq = -1;
    table.innerHTML = `
      <p class="status" id="status"></p>
      <div class="dots" id="dots">${'<span></span>'.repeat(ROLLS_PER_TURN)}</div>
      <div class="dice" id="dice">${state.dice.map((v) => dieHTML(v)).join('')}</div>
      <p class="hint" id="hint"></p>
      <button class="btn btn-primary btn-hero" id="roll"></button>`;
    table.querySelectorAll('.die').forEach((el, i) => {
      el.onclick = () => {
        const s = state;
        if (s.players[s.turn]?.id === me.id && s.rolls > 0 && s.rolls < ROLLS_PER_TURN) dispatch({ type: 'hold', index: i });
      };
    });
    $('#roll').onclick = () => {
      navigator.vibrate?.(15);
      dispatch({ type: 'roll' });
    };
  }

  const current = state.players[state.turn];
  const mine = current.id === me.id;
  $('#status').textContent = mine ? t('yourTurn') : current.connected ? t('theirTurn', { name: current.name }) : t('offlineTurn', { name: current.name });
  $('#status').classList.toggle('mine', mine);
  $('#dots').querySelectorAll('span').forEach((d, i) => d.classList.toggle('used', i < state.rolls));

  const diceBox = $('#dice');
  const freshRoll = lastRollSeq !== -1 && state.rollSeq !== lastRollSeq;
  diceBox.classList.toggle('idle', state.rolls === 0);
  diceBox.classList.toggle('pickable', mine && state.rolls > 0 && state.rolls < ROLLS_PER_TURN);
  diceBox.querySelectorAll('.die').forEach((el, i) => {
    const held = state.rolls > 0 && state.held[i];
    el.classList.toggle('held', held);
    el.dataset.heldLabel = t('held');
    if (freshRoll && !(state.rolls > 1 && state.held[i])) tumble(el, state.dice[i], i * 40);
    else if (!el._spin) setFace(el, state.dice[i]);
  });
  lastRollSeq = state.rollSeq;

  $('#hint').textContent = !mine ? '' : state.rolls === 0 ? t('firstRoll') : state.rolls < ROLLS_PER_TURN ? t('tapToHold') : t('pickBox');
  const roll = $('#roll');
  roll.classList.toggle('invisible', !mine);
  roll.disabled = !mine || state.rolls >= ROLLS_PER_TURN;
  roll.textContent = state.rolls === 0 ? t('roll') : t('rollAgain', { n: ROLLS_PER_TURN - state.rolls });
}

function renderSheet() {
  const sheet = $('#sheet');
  const current = state.players[state.turn];
  const canPick = state.phase === 'playing' && current?.id === me.id && state.rolls > 0;
  const players = state.players;

  const cell = (p, cat) => {
    const v = p.scores[cat];
    const flash = flashKey === `${p.id}:${cat}` ? ' flash' : '';
    if (v != null) return `<td class="val${flash}">${v}</td>`;
    if (canPick && p.id === me.id) {
      const potential = scoreFor(cat, state.dice);
      const cls = `${potential === 0 ? ' zero' : ''}${selectedCat === cat ? ' selected' : ''}`;
      return `<td class="val"><button class="pick${cls}" data-cat="${cat}" aria-label="${catName(cat)}: ${potential}">${potential}</button></td>`;
    }
    return `<td class="val empty"></td>`;
  };
  const catRow = (cat) => `
    <tr>
      <th scope="row" class="cat"><span class="cat-name">${catName(cat)}</span><span class="cat-hint">${catHint(cat)}</span></th>
      ${players.map((p) => cell(p, cat)).join('')}
    </tr>`;
  const sums = players.map((p) => totals(p.scores));

  sheet.innerHTML = `
    <div class="scroll-x">
      <table class="scorecard">
        <thead>
          <tr>
            <th></th>
            ${players.map((p, i) => `
              <th scope="col" class="player${state.phase === 'playing' && i === state.turn ? ' active' : ''}${p.connected ? '' : ' away'}">
                <span>${esc(displayName(p))}</span>
              </th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${UPPER.map(catRow).join('')}
          <tr class="sum">
            <th scope="row" class="cat"><span class="cat-name">${t('upperSum')}</span></th>
            ${sums.map((s) => `<td class="val"><span>${s.upper}</span><span class="of">/${BONUS_THRESHOLD}</span></td>`).join('')}
          </tr>
          <tr class="sum">
            <th scope="row" class="cat"><span class="cat-name">${t('bonus')}</span><span class="cat-hint">+${BONUS} ${t('bonusHint')}</span></th>
            ${sums.map((s) => `<td class="val">${s.bonus || ''}</td>`).join('')}
          </tr>
          ${LOWER.map(catRow).join('')}
          <tr class="total">
            <th scope="row" class="cat"><span class="cat-name">${t('total')}</span></th>
            ${sums.map((s) => `<td class="val">${s.total}</td>`).join('')}
          </tr>
        </tbody>
      </table>
    </div>`;

  sheet.querySelectorAll('.pick').forEach((btn) => {
    btn.onclick = () => {
      const cat = btn.dataset.cat;
      if (selectedCat === cat) return enter();
      selectedCat = cat;
      renderSheet();
      renderSticky();
    };
  });
}

function enter() {
  if (!selectedCat) return;
  const cat = selectedCat;
  selectedCat = null;
  sticky.classList.remove('show');
  dispatch({ type: 'score', cat });
}

function renderSticky() {
  const show = !!selectedCat && state?.phase === 'playing';
  sticky.classList.toggle('show', show);
  if (!show) return;
  const value = scoreFor(selectedCat, state.dice);
  sticky.innerHTML = `
    <div class="sticky-text"><strong>${catName(selectedCat)}</strong><span class="muted"> · ${t('points', { n: value })}</span></div>
    <button class="btn btn-primary" id="enter">${value === 0 ? t('strike') : t('enter')}</button>`;
  $('#enter').onclick = enter;
}

// ---------- boot ----------

$('#lang').onclick = () => {
  setLang(lang === 'de' ? 'en' : 'de');
  renderNav();
  const current = screen;
  screen = null;
  if (role) render();
  else if (current === 'join') renderJoin(code);
  else renderLanding();
};

function boot() {
  setLang(lang);
  renderNav();
  if (typeof mqtt === 'undefined') {
    renderMessage(t('errPeer', { msg: 'mqtt.js' }));
    return;
  }
  const hashCode = location.hash.slice(1).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!hashCode) return renderLanding();

  const hosted = JSON.parse(session.get('kniffel.host') || 'null');
  if (hosted?.code === hashCode) return startHosting(hashCode, hosted.state);
  if (session.get('kniffel.guest') === hashCode && cleanName(me.name)) return startGuest(hashCode);
  renderJoin(hashCode);
}

window.addEventListener('hashchange', () => location.reload());
boot();
