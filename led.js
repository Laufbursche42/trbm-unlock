'use strict';

// LED strips (command 0x08).
//
// The frame is the same 20-byte shape as everything else: AA 08 <mode> <sub> <R> <G> <B> <bright>
// FF..FF <CRC>. Which of those bytes the controller reads depends on the mode:
//
//   mode 10  master switch. sub 0 turns the strips on, sub 1 sets the sticky off-latch. While the
//            latch is set the controller drops every colour, effect and brightness frame.
//   mode 1   sub 0 sets brightness only. sub 1..47 selects an animation.
//   mode 0   a static colour in bytes 4..6. Byte 3 stays at the 0xFF filler on purpose: the
//            controller branches on it being non-zero to take the full-apply path that actually
//            writes the colour.
//
// Two things the original app gets wrong and this page does not:
//   - It sends brightness AFTER the colour. The brightness-only path returns without a refresh, so
//     the colour keeps the previous brightness until something else redraws. Brightness goes first.
//   - Selecting an animation there transmits brightness 0, because the brightness argument lands in
//     the colour slot. Here the real brightness is sent with it.
//
// The brightness byte is NOT private to the strips. The controller scales the indicator and brake
// overlays by the same value, so dimming the strips dims those too. That is why switching the
// strips off here puts brightness back to 100 first.

const LED_CMD = 8;
const LED_MODE_COLOR = 0;
const LED_MODE_EFFECT = 1;
const LED_MODE_MASTER = 10;

// Animation names as the vendor app lists them. The index in this array plus one is the sub-byte.
const LED_EFFECTS = [
  'Auto Play', 'Magic Forward', 'Magic Back', '7-Color Energy', '7-Color Jump', 'R-G-B Jump',
  'Y-C-P Jump', '7-Color Strobe', 'R-G-B Strobe', 'Y-C-P Strobe', '7-Color Gradual', 'R-Y Gradual',
  'R-P Gradual', 'G-C Gradual', 'G-Y Gradual', 'B-P Gradual', 'Red Marquee', 'Green Marquee',
  'Blue Marquee', 'Yellow Marquee', 'Cyan Marquee', 'Purple Marquee', 'White Marquee',
  '7-Color Race', '7-Color Race Back', 'R-G-B Race', 'R-G-B Race Back', 'Y-C-P Race',
  'Y-C-P Race Back', '7-Color Wave', '7-Color Wave Back', 'R-G-B Wave', 'R-G-B Wave Back',
  'Y-C-P Wave', 'Y-C-P Wave Back', '7-Color Flush', '7-Color Flush Back', 'R-G-B Flush',
  'R-G-B Flush Back', 'Y-C-P Flush', 'Y-C-P Flush Back', '7-Color Flush Close',
  '7-Color Flush Open', 'R-G-B Flush Close', 'R-G-B Flush Open', 'Y-C-P Flush Close',
  'Y-C-P Flush Open'
];

// The same list in German. The colour codes are spelled out where they are not universal: R-G-B is
// read everywhere, Y-C-P is not.
const LED_EFFECTS_DE = [
  'Automatisch', 'Magisch vorwärts', 'Magisch rückwärts', '7 Farben Energie', '7 Farben Sprung',
  'R-G-B Sprung', 'Gelb-Cyan-Violett Sprung', '7 Farben Stroboskop', 'R-G-B Stroboskop',
  'Gelb-Cyan-Violett Stroboskop', '7 Farben Verlauf', 'Rot-Gelb Verlauf', 'Rot-Violett Verlauf',
  'Grün-Cyan Verlauf', 'Grün-Gelb Verlauf', 'Blau-Violett Verlauf', 'Rotes Lauflicht',
  'Grünes Lauflicht', 'Blaues Lauflicht', 'Gelbes Lauflicht', 'Cyanes Lauflicht',
  'Violettes Lauflicht', 'Weißes Lauflicht', '7 Farben Jagd', '7 Farben Jagd rückwärts',
  'R-G-B Jagd', 'R-G-B Jagd rückwärts', 'Gelb-Cyan-Violett Jagd',
  'Gelb-Cyan-Violett Jagd rückwärts', '7 Farben Welle', '7 Farben Welle rückwärts', 'R-G-B Welle',
  'R-G-B Welle rückwärts', 'Gelb-Cyan-Violett Welle', 'Gelb-Cyan-Violett Welle rückwärts',
  '7 Farben Fluten', '7 Farben Fluten rückwärts', 'R-G-B Fluten', 'R-G-B Fluten rückwärts',
  'Gelb-Cyan-Violett Fluten', 'Gelb-Cyan-Violett Fluten rückwärts', '7 Farben Fluten schließend',
  '7 Farben Fluten öffnend', 'R-G-B Fluten schließend', 'R-G-B Fluten öffnend',
  'Gelb-Cyan-Violett Fluten schließend', 'Gelb-Cyan-Violett Fluten öffnend'
];

function ledEffectNames() {
  return (typeof lang !== 'undefined' && lang === 'en') ? LED_EFFECTS : LED_EFFECTS_DE;
}

// The whole feature hides behind a URL switch while it is being tried out, so an ordinary visitor
// never sees it. Query and hash are both read the same way the do= shortcut is. A stray & in
// place of the ? is tolerated because that is an easy thing to mistype.
function ledTestEnabled() {
  const raw = (location.search + ' ' + location.hash).toLowerCase();
  return /[?&#]test=led/.test(raw) || /(^|[?&#])test=led/.test(raw.trim());
}

const LS_LED_WARN_UNTIL = 'tru_led_warn_until';   // epoch ms; the warning stays suppressed until then
const LED_WARN_DAYS = 7;

const LED = {
  on: false,          // what this page last commanded, the controller reports nothing back
  brightness: 100,
  color: '#ffffff',
  effect: 0,          // 0 = static colour, otherwise the sub-byte of the animation
};

// --------------------------- frames ---------------------------

function ledFrame(mode, sub, rgb, brightness) {
  const a = base(LED_CMD);
  a[2] = mode & 0xFF;
  if (mode === LED_MODE_COLOR) {
    a[4] = rgb[0] & 0xFF;
    a[5] = rgb[1] & 0xFF;
    a[6] = rgb[2] & 0xFF;   // a[3] deliberately left at 0xFF, see the note above
  } else {
    a[3] = sub & 0xFF;
  }
  a[7] = brightness & 0xFF;
  return finalizeFrame(a);
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// --------------------------- sending ---------------------------

// Without a link nothing is queued: a frame parked in the write queue would go out the moment a
// scooter connects, long after the rider set it, which is worse than not sending it at all.
function ledLinkReady() {
  return connected && S.received71 && !otaEngine;
}
function ledSend(frame) {
  if (!ledLinkReady()) return;
  enqueue(frame);
}

function ledSendBrightness(v) {
  ledSend(ledFrame(LED_MODE_EFFECT, 0, null, v));
}

// Brightness first, then what should carry it. Both go through the normal write queue, which already
// spaces frames by 200 ms.
function ledApply() {
  ledSendBrightness(LED.brightness);
  if (LED.effect > 0) ledSend(ledFrame(LED_MODE_EFFECT, LED.effect, null, LED.brightness));
  else ledSend(ledFrame(LED_MODE_COLOR, 0, hexToRgb(LED.color), LED.brightness));
}

function ledSetOn(on) {
  if (on) {
    ledSend(ledFrame(LED_MODE_MASTER, 0, null, 0));   // clear the off-latch first
    ledApply();
    log(ledLinkReady() ? 'LED on' : 'LED on (preview, nothing sent)');
  } else {
    // Full brightness before switching off, otherwise the indicators and the brake light stay dimmed
    // at whatever the strips were last set to.
    ledSendBrightness(100);
    ledSend(ledFrame(LED_MODE_MASTER, 1, null, 0));
    log(ledLinkReady() ? 'LED off, brightness back to 100' : 'LED off (preview, nothing sent)');
  }
  LED.on = on;
  ledRefreshUi();
}

// --------------------------- the 7-day warning ---------------------------

function ledWarnSuppressed() {
  const until = parseInt(localStorage.getItem(LS_LED_WARN_UNTIL) || '0', 10);
  return !isNaN(until) && until > Date.now();
}
function ledSuppressWarn() {
  localStorage.setItem(LS_LED_WARN_UNTIL, String(Date.now() + LED_WARN_DAYS * 86400000));
}

// Asks before turning the strips ON. Turning them off never asks.
function ledConfirmOn() {
  if (ledWarnSuppressed()) { ledSetOn(true); return; }
  const dlg = $('led-warn');
  if (!dlg || !dlg.showModal) { ledSetOn(true); return; }   // no dialog support, do not block the user
  const box = $('led-warn-skip');
  if (box) box.checked = false;
  dlg.showModal();
}

// --------------------------- UI ---------------------------

// The hand-drawn track reads its fill from --pct, so it has to be written whenever the value moves.
function ledPaintSlider(el) {
  const min = Number(el.min) || 0, max = Number(el.max) || 100;
  const v = Number(el.value);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 100;
  el.style.setProperty('--pct', pct.toFixed(1) + '%');
}

function ledRefreshUi() {
  const ready = ledLinkReady();
  const open = $('btn-led');
  if (open) open.disabled = !ready;
  const note = $('led-preview');
  if (note) note.hidden = ready;
  const live = $('led-live');
  if (live) live.hidden = !ready;

  const sw = $('led-on');
  if (sw) sw.checked = LED.on;

  // The controls stay usable while the strips are off: a rider sets the look first and then switches
  // on. The controller drops setting frames while the off-latch is set anyway. What is set here
  // is held and goes out the moment the strips are switched on.
  const br = $('led-bright'), brv = $('led-bright-val');
  if (br) { br.value = String(LED.brightness); ledPaintSlider(br); }
  if (brv) brv.textContent = LED.brightness + ' %';

  const col = $('led-color');
  if (col) col.value = LED.color;   // stays usable during an effect: picking a colour ends the effect

  const btn = $('led-effect-btn');
  if (btn) btn.textContent = ledEffectLabel(LED.effect);
}

function ledEffectLabel(n) {
  if (!n) return t('ledEffectNone');
  return ledEffectNames()[n - 1] || String(n);
}

// Rebuilt on every open rather than filled once: the language switch may have moved since.
function ledFillEffects() {
  const list = $('led-effect-list');
  if (!list) return;
  list.replaceChildren();
  const add = (value, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(value === LED.effect));
    b.textContent = label;
    b.addEventListener('click', () => {
      LED.effect = value;
      ledCloseEffects();
      ledRefreshUi();
      if (LED.on) ledApply();
    });
    list.appendChild(b);
  };
  add(0, t('ledEffectNone'));
  ledEffectNames().forEach((name, i) => add(i + 1, name));
}

function ledCloseEffects() {
  const list = $('led-effect-list'), btn = $('led-effect-btn');
  if (list) list.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}
// The list is fixed to the viewport, so its box has to be written from the button position every
// time it opens. It drops below the button when there is room and flips above it when there is not.
function ledPlaceEffects() {
  const list = $('led-effect-list'), btn = $('led-effect-btn');
  if (!list || !btn || list.hidden) return;
  const r = btn.getBoundingClientRect();
  // The list starts right at the lower edge of the field, so the two read as one piece.
  const gap = 0, margin = 8;
  list.style.width = r.width + 'px';
  list.style.left = r.left + 'px';
  const below = window.innerHeight - r.bottom - margin;
  const above = r.top - margin;
  const wanted = Math.min(220, list.scrollHeight);
  const down = below >= wanted || below >= above;
  list.classList.toggle('up', !down);
  if (down) {
    list.style.maxHeight = Math.max(80, Math.min(220, below)) + 'px';
    list.style.top = (r.bottom + gap) + 'px';
  } else {
    const h = Math.max(80, Math.min(220, above));
    list.style.maxHeight = h + 'px';
    list.style.top = (r.top - gap - h) + 'px';
  }
}

function ledToggleEffects() {
  const list = $('led-effect-list'), btn = $('led-effect-btn');
  if (!list) return;
  const open = list.hidden;
  ledFillEffects();
  list.hidden = !open;
  if (btn) btn.setAttribute('aria-expanded', String(open));
  if (open) {
    ledPlaceEffects();
    const sel = list.querySelector('button[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
}

function ledOpen() {
  ledCloseEffects();
  ledFillEffects();
  ledRefreshUi();
  const dlg = $('led');
  if (dlg && dlg.showModal) dlg.showModal();
}

function initLed() {
  const card = document.getElementById('led-card');
  if (!ledTestEnabled()) { if (card) card.hidden = true; return; }
  if (card) card.hidden = false;

  const open = $('btn-led');
  if (open) open.addEventListener('click', ledOpen);

  ['led-close', 'led-close-2'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('click', () => { const d = $('led'); if (d) d.close(); });
  });

  const sw = $('led-on');
  if (sw) sw.addEventListener('change', () => {
    if (sw.checked) { sw.checked = false; ledConfirmOn(); }   // the dialog decides, not the tick
    else ledSetOn(false);
  });

  const br = $('led-bright');
  if (br) br.addEventListener('change', () => {
    LED.brightness = Math.max(1, Math.min(100, parseInt(br.value, 10) || 100));
    ledRefreshUi();
    if (LED.on) ledApply();
  });
  if (br) br.addEventListener('input', () => {
    const v = Math.max(1, Math.min(100, parseInt(br.value, 10) || 100));
    const brv = $('led-bright-val');
    if (brv) brv.textContent = v + ' %';
    ledPaintSlider(br);
  });

  const col = $('led-color');
  if (col) col.addEventListener('change', () => {
    LED.color = col.value;
    LED.effect = 0;   // a static colour and an animation cannot both be showing
    ledRefreshUi();
    if (LED.on) ledApply();
  });

  const effBtn = $('led-effect-btn');
  if (effBtn) effBtn.addEventListener('click', (e) => { e.stopPropagation(); ledToggleEffects(); });
  // A click anywhere else closes the list, the same way a native drop-down behaves.
  document.addEventListener('click', ledCloseEffects);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ledCloseEffects(); });
  // Scrolling the dialog behind it would leave the list hanging next to nothing, so it closes.
  // The list's own scrolling is excluded, otherwise it would shut itself while being used.
  const body = document.querySelector('#led .dlg-body');
  if (body) body.addEventListener('scroll', ledCloseEffects);
  window.addEventListener('resize', ledPlaceEffects);

  const ok = $('btn-led-warn-ok');
  if (ok) ok.addEventListener('click', () => {
    const box = $('led-warn-skip');
    if (box && box.checked) ledSuppressWarn();
    const d = $('led-warn'); if (d) d.close();
    ledSetOn(true);
  });
  const no = $('btn-led-warn-cancel');
  if (no) no.addEventListener('click', () => { const d = $('led-warn'); if (d) d.close(); ledRefreshUi(); });

  ledRefreshUi();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initLed);
else initLed();
