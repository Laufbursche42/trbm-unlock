// Laufbursche Blade Tool: a Web Bluetooth tool for the Teverun Blade / Blade Mini (eKFV).
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42).
// Scope: scan, reconnect, read the full Blade Mini field set, and lock/unlock on firmware 3.4.6.
// The protocol (CRC-8, 0x18 settings frame, 55 71 parse) is ported 1:1 from the native lb-edition.
//
// Lock/unlock does NOT use the 0x1B TESTLOCK command (which needs patched firmware). It drives the
// eKFV clamp via the per-gear speed byte inside the stock 0x18 settings frame - reverse-engineered
// on firmware 3.4.6. On 3.4.8 the limiter sits in the ESC firmware and ignores every BLE write, so
// lock/unlock is disabled there; on any other/unknown firmware the tool stays read-only.
//
// Runs in a Web Bluetooth browser: Bluefy on iOS, Chrome on Android/desktop. Safari has no BLE.

'use strict';

const BUILD = 'v115';

// --------------------------- BLE transport constants ---------------------------

// Only real scooters: the BLE name is the FIN, "TDE..." when locked, "T1..." when unlocked. The old
// broad 'T' matched any T-named device (TVs, phones); these strict prefixes keep the picker (and
// getDevices) to actual scooters only.
const NAME_PREFIXES = ['TDE', 'T1'];

// Candidate GATT services the Teverun BLE module exposes. The ISSC (Microchip) Transparent-UART
// service is the usual one; the 0000FFxx family is the fallback. Web Bluetooth needs every service
// we touch listed here up front (optionalServices).
const ISSC_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
const ISSC_NOTIFY  = '49535343-1e4d-4bd9-ba61-23c647249616';
const ISSC_WRITE   = '49535343-aca3-481c-91ec-d85e28a60318';
// Web Bluetooth can only touch services declared up front. Cheap BLE-UART modules use 16-bit UUIDs
// in the vendor ranges 0xFCxx-0xFFxx, so declare the whole range plus the known 128-bit UARTs (ISSC,
// Nordic). That covers almost every module without knowing its exact UUID and surfaces it in the log.
const VENDOR_16BIT = [];
for (const base of ['fc', 'fd', 'fe', 'ff'])
  for (let i = 0; i < 256; i++)
    VENDOR_16BIT.push('0000' + base + i.toString(16).padStart(2, '0') + '-0000-1000-8000-00805f9b34fb');
const NORDIC_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';   // Nordic UART: a common non-ISSC/FF module
const OPTIONAL_SERVICES = [ISSC_SERVICE, NORDIC_SERVICE, ...VENDOR_16BIT];

const CONNECT_CODE_INTERVAL_MS = 6500;
const WRITE_GAP_MS = 200;         // match the native app's ~200 ms spacing (gentler on the BLE module)
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 20000;
const LINK_TIMEOUT_MS = 6000;     // how long a fresh link may stay silent before it is reported

// --------------------------- CRC-8 (poly 0x07), exact port ---------------------------

function crc8(data, len) {
  let crc = 0;
  for (let i = 0; i < len; i++) {
    crc ^= (data[i] & 0xFF);
    for (let n = 8; n > 0; n--) {
      crc = ((crc & 0x80) !== 0) ? (((crc << 1) ^ 0x07) & 0x1FF) : ((crc << 1) & 0x1FF);
    }
    crc &= 0xFF;
  }
  return crc & 0xFF;
}

// --------------------------- bit helpers ---------------------------

function bytesToInt(bits) {           // LSB-first: index 0 = bit0
  let v = 0;
  for (let i = 0; i < bits.length; i++) if ((bits[i] & 1) !== 0) v |= (1 << i);
  return v & 0xFF;
}
function bytesToInt2(bits) {          // MSB-first: index 0 = most-significant bit
  let v = 0;
  const n = bits.length;
  for (let i = 0; i < n; i++) if ((bits[i] & 1) !== 0) v |= (1 << (n - 1 - i));
  return v & 0xFF;
}
function nibbles(high, low) {
  const b = new Array(8).fill(0);
  for (let k = 0; k < 4; k++) b[k] = (high >> (3 - k)) & 1;
  for (let k = 0; k < 4; k++) b[4 + k] = (low >> (3 - k)) & 1;
  return b;
}
function applyCruise(bits, cruise) {  // 2 (manual) -> bit2; 1 (auto) -> bit0 & bit1; else none
  if (cruise === 2) bits[2] = 1;
  else if (cruise === 1) { bits[0] = 1; bits[1] = 1; }
}
function voltCode(packVolt) {
  switch (packVolt) {
    case 36: return 30; case 48: return 39; case 52: return 42;
    case 60: return 48; case 72: return 60; case 84: return 69;
    default: return packVolt & 0xFF;
  }
}

// --------------------------- frame assembly ---------------------------

function finalizeFrame(a19) {
  const out = new Uint8Array(20);
  for (let i = 0; i < 19; i++) out[i] = a19[i] & 0xFF;
  out[19] = crc8(a19, 19);
  return out;
}
function base(cmdId) {
  const a = new Array(19).fill(0xFF);
  a[0] = 170;            // 0xAA
  a[1] = cmdId & 0xFF;
  return a;
}
function connectCode(e) {          // handshake / keep-alive: AA 01 10 <e> FF..FF CRC
  const a = base(1);
  a[2] = 0x10;
  a[3] = e & 0xFF;
  return finalizeFrame(a);
}

// --------------------------- settings state (mirrors SettingsState.java) ---------------------------

const S = {
  gear: 1, wheel: 8.5, sysProTemp: 80, motorPolePairs: 15,
  assistSpeedLimit: 25, speedLimit: 25, fCurrent: 0, rCurrent: 0, packVolt: 60,
  enfEcon: false, isUnitMile: false, atMode: false, isSmart: false,
  cruise: 0, abs: false, startMode: false,
  fStartLevel: 0, rStartLevel: 0, eabsLevel: 0, sleepTime: 0, prTime: 0,
  rmStatus: 1, doubleMotor: 1,
  systemStatus6: 0,
  received71: false,
};

// Per-gear cache: each gear's OWN speed/current/assist, filled from 55 71 telemetry, so we can write
// wheel + cruise into every gear without disturbing that gear's other per-gear settings.
const gearCache = {};

function updateFrom71(t) {
  S.gear = t[3] & 0xFF;
  const r = t[4] & 0xFF;                       // rControlStatus (LSB-first)
  const b1 = (r >> 1) & 1, b2 = (r >> 2) & 1;
  S.cruise = (b2 << 1) | b1;                   // (bit2<<1)|bit1
  S.abs = ((r >> 3) & 1) !== 0;
  S.startMode = ((r >> 6) & 1) !== 0;
  S.motorPolePairs = t[5] & 0xFF;
  S.wheel = (t[6] & 0xFF) * 0.1;
  S.sysProTemp = t[7] & 0xFF;
  S.fStartLevel = t[8] & 0x0F;
  S.eabsLevel = (t[9] >> 4) & 0x0F;
  S.rStartLevel = t[9] & 0x0F;
  S.assistSpeedLimit = t[10] & 0xFF;
  S.speedLimit = t[11] & 0xFF;
  S.fCurrent = t[12] & 0xFF;
  S.rCurrent = t[13] & 0xFF;
  S.packVolt = t[15] & 0xFF;
  const sys = t[17] & 0xFF;
  S.enfEcon = (sys & 0x01) !== 0;
  S.isUnitMile = (sys & 0x02) !== 0;
  S.atMode = (sys & 0x04) !== 0;
  S.isSmart = (sys & 0x10) !== 0;
  S.systemStatus6 = (sys >> 6) & 1;   // ESC eKFV-clamp bit (1 = clamped/22, 0 = open); read-only diagnostic
  const sp = t[18] & 0xFF;
  S.sleepTime = sp & 0x07;
  S.prTime = (sp >> 3) & 0x1F;
  S.received71 = true;
  gearCache[S.gear] = { assistSpeedLimit: S.assistSpeedLimit, fCurrent: S.fCurrent, rCurrent: S.rCurrent,
                        eabsLevel: S.eabsLevel, fStartLevel: S.fStartLevel, rStartLevel: S.rStartLevel };
}

// Full 0x18 settings frame. All shared config comes from S; per-gear bytes from the args. Mirrors
// CommandBuilder.buildSettingFrame: the whole state is serialised, so only call after received71.
function buildSettingFrame(n, gearByte, eabsLevel, fStartLevel, rStartLevel, perGearSpeed, fCurrent, rCurrent) {
  const a = new Array(19).fill(0xFF);
  a[0] = 170; a[1] = 24; a[2] = n & 0xFF; a[3] = gearByte & 0xFF;
  const s4 = new Array(8).fill(0);
  applyCruise(s4, S.cruise); s4[3] = S.abs ? 1 : 0; s4[6] = S.startMode ? 1 : 0; s4[7] = S.rmStatus & 1;
  a[4] = bytesToInt(s4);
  a[5] = S.motorPolePairs & 0xFF;
  a[6] = Math.round(S.wheel * 10.0) & 0xFF;
  a[7] = S.sysProTemp & 0xFF;
  a[8] = bytesToInt2(nibbles(eabsLevel, fStartLevel));
  a[9] = bytesToInt2(nibbles(eabsLevel, rStartLevel));
  a[10] = perGearSpeed & 0xFF;
  a[11] = S.speedLimit & 0xFF;
  a[12] = fCurrent & 0xFF;
  a[13] = rCurrent & 0xFF;
  a[14] = voltCode(S.packVolt);
  a[15] = S.packVolt & 0xFF;
  const d = new Array(8).fill(0);
  d[0] = S.enfEcon ? 1 : 0; d[1] = S.isUnitMile ? 1 : 0; d[2] = S.atMode ? 1 : 0; d[4] = S.isSmart ? 1 : 0;
  a[16] = bytesToInt(d);
  const s17 = new Array(8).fill(0);
  applyCruise(s17, S.cruise); s17[3] = S.abs ? 1 : 0; s17[6] = S.startMode ? 1 : 0; s17[7] = S.doubleMotor & 1;
  a[17] = bytesToInt(s17);
  a[18] = ((S.prTime & 0x1F) << 3) | (S.sleepTime & 0x07);
  return finalizeFrame(a);
}

// Wheel + cruise are global in the firmware, so ONE 0x18 write for the active gear sets them for
// every gear. Writing all gears in a burst could starve the display link and trip a false boot-lock.
function writeWheelCruiseAllGears() {
  const cur = S.gear & 0xFF;
  enqueue(buildSettingFrame(2, cur, S.eabsLevel, S.fStartLevel, S.rStartLevel,
                            S.assistSpeedLimit, S.fCurrent, S.rCurrent));
}

// --------------------------- telemetry parse (subset of FrameParser.java) ---------------------------

const ERROR_COUNT = 17;     // 55 54 t[2..18], one severity byte per error type
const CELL_SLOTS = 24;      // 55 51 / 55 55 / 55 56 carry eight cells each

const T = {
  speed: 0, soc: 0, gear: 0, speedRaw: 0, volt: 0, frameNum: '', fin: '', lock: null, swVer: null,
  // Battery detail from 55 52 / 55 53 and the BMS severity array from 55 54. The have* flags say
  // whether that frame has been seen at all, so a view can show a placeholder instead of a zero.
  have52: false, have53: false, have72: false, current: 0, soh: 0, maxCellTemp: 0, minCellTemp: 0,
  capacity: 0, chargeCounter: 0, cellCount: 0, maxCellV: 0, minCellV: 0, balance: 0,
  cellMv: null, errors: null,
  mCurF: 0, mCurR: 0, mTempF: 0, mTempR: 0,
  // Controller status bytes 55 72 t[10] / t[11]: the fault bits behind the error report.
  ecu1: null, ecu2: null,
};

function u16(t, i) { return ((t[i] & 0xFF) << 8) | (t[i + 1] & 0xFF); }

// Frame reassembly: a BLE notification is not guaranteed to carry exactly one 20-byte frame (it can
// be fragmented or batched), so we buffer the bytes and pull out every 20-byte frame that starts
// with 0x55 and has a valid CRC.
let rxBuf = new Uint8Array(0);
let diagParsed = false;

function onNotify(value) {                       // value: DataView
  const len = value.byteLength;
  const u = new Uint8Array(len);
  for (let i = 0; i < len; i++) u[i] = value.getUint8(i);
  if (diagLog) log('RX ' + hexOf(u, Math.min(len, 20)), 'log-rx');
  const merged = new Uint8Array(rxBuf.length + len);
  merged.set(rxBuf, 0);
  merged.set(u, rxBuf.length);
  let pos = 0;
  while (pos + 20 <= merged.length) {
    if (merged[pos] !== 0x55) { pos++; continue; }            // resync to the 0x55 frame marker
    const t = new Array(20);
    for (let i = 0; i < 20; i++) t[i] = merged[pos + i];
    if (crc8(t, 19) !== (t[19] & 0xFF)) { pos++; continue; }  // not a valid frame, skip one byte
    dispatch(t);
    pos += 20;
  }
  rxBuf = merged.slice(pos);                     // keep the unconsumed tail for the next notification
  if (rxBuf.length > 200) rxBuf = rxBuf.slice(rxBuf.length - 40);
}

// A frame from the scooter is the only proof the link is real: iOS reports a connected GATT even for a
// bonded device far out of range.
function confirmLink() {
  if (linkConfirmed) return;
  linkConfirmed = true;
  if (linkTimer) { clearTimeout(linkTimer); linkTimer = null; }
  setStatus('connected');
  maybeRunDeepAction();
}

// The unlock (per-gear speed values) was reverse-engineered on firmware 3.4.6. The version comes from
// the 55 43 frame (t[2].t[3].t[4]) parsed in dispatch().
const SUPPORTED_FW = '3.4.6';
// 3.4.8 is confirmed to ignore every BLE write (the clamp sits in the ESC firmware), so it is blocked.
// Flip this to true to re-open 3.4.8 testing later - that is the only switch needed.
const ALLOW_FW348 = false;
function isFw348() { return typeof T.swVer === 'string' && T.swVer.indexOf('3.4.8') === 0; }
// True when the connected scooter runs 3.4.8 and 3.4.8 is currently switched off -> block writes.
function fw348Blocked() { return isFw348() && !ALLOW_FW348; }

let fwWarned = false;
function checkFwVersion() {
  if (fwWarned || !T.swVer || T.swVer === SUPPORTED_FW) return;
  fwWarned = true;
  const msg = $('fwwarn-msg');
  if (msg) {
    // Safe DOM nodes (no innerHTML): the version goes into a span styled by CSS (.fw-ver).
    while (msg.firstChild) msg.removeChild(msg.firstChild);
    const parts = t('fwWarnMsg').split('{ver}');
    msg.appendChild(document.createTextNode(parts[0] || ''));
    const ver = document.createElement('span');
    ver.className = 'fw-ver';
    ver.textContent = T.swVer;
    msg.appendChild(ver);
    if (parts.length > 1) msg.appendChild(document.createTextNode(parts.slice(1).join('{ver}')));
  }
  const dlg = $('fwwarn');
  if (dlg && dlg.showModal && !dlg.open) dlg.showModal();
  log('firmware ' + T.swVer + ' is not the supported ' + SUPPORTED_FW
      + (isFw348() ? ' -> 3.4.8, lock/unlock disabled' : ' -> read-only'));
}

function dispatch(t) {
  if (!diagParsed) { diagParsed = true; log('telemetry ok, first frame 0x' + (t[1] & 0xFF).toString(16), 'log-ok'); }
  confirmLink();                 // first real frame proves the device is truly here -> now "connected"
  switch (t[1]) {
    case 0x71:
      updateFrom71(t);
      // On the Blade the real lock state is the per-gear speed (t[10] -> S.assistSpeedLimit): ~22 when
      // locked, high when unlocked. Threshold 30 sits between the locked 22 and the open value.
      T.lock = (S.assistSpeedLimit > 30) ? 'unlocked' : 'locked';
      T.gear = t[3] & 0xFF;
      onSettingsFrame();
      maybeRunDeepAction();      // a shortcut's ?do=lock waits for this first 55 71
      break;
    case 0x72: {
      T.ecu1 = t[10] & 0xFF;         // rear ECU status bytes, the fault bits of the error report
      T.ecu2 = t[11] & 0xFF;
      T.speedRaw = u16(t, 15);
      let v = 0;
      if (T.speedRaw > 0) v = 287.0 * S.wheel / T.speedRaw;
      if (T.speedRaw >= 3000 || v <= 0.5) v = 0;
      if (S.isUnitMile) v = v / 1.6093439;
      T.speed = v;
      T.mCurF = u16(t, 4) * 0.1;     // front motor current = 0.1 * (byte 4:5)
      T.mCurR = u16(t, 12) * 0.1;    // rear motor current  = 0.1 * (byte 12:13)
      T.mTempF = t[9] & 0xFF;        // front motor temp (raw, 0 = not sent)
      T.mTempR = t[17] & 0xFF;       // rear motor temp (raw)
      T.have72 = true;
      break;
    }
    case 0x51: parseCells(t, 0); break;      // cells 1-8
    case 0x55: parseCells(t, 8); break;      // cells 9-16
    case 0x56: parseCells(t, 16); break;     // cells 17-24
    case 0x52:
      T.volt = u16(t, 2) * 0.1;
      T.current = u16(t, 6) * 0.1 - 1000;    // below zero the pack is taking charge back in
      T.soc = t[8] & 0xFF;
      T.soh = t[9] & 0xFF;
      T.maxCellTemp = (t[17] & 0xFF) - 40;   // both temperatures carry a 40 degree offset
      T.minCellTemp = (t[18] & 0xFF) - 40;
      T.have52 = true;
      break;
    case 0x53:
      T.balance = t[7] & 0xFF;               // one balancing bit per cell, bit 0 = cell 1
      // A T2 pack carries the rated capacity in t[10] instead of t[8]. The name is the only source.
      T.capacity = deviceName.startsWith('T2') ? u16(t, 10) : u16(t, 8);
      T.chargeCounter = u16(t, 12);
      T.cellCount = t[14] & 0xFF;
      T.maxCellV = u16(t, 15);
      T.minCellV = u16(t, 17);
      T.have53 = true;
      break;
    case 0x54: {
      // Severity per error type: the index is the type, the byte its level. Thresholds live in collectErrors.
      const errs = new Array(ERROR_COUNT);
      for (let i = 0; i < ERROR_COUNT; i++) errs[i] = t[i + 2] & 0xFF;
      T.errors = errs;
      break;
    }
    case 0x42: T.frameNum = ascii(t, 2, 18); updateFin(); break;
    case 0x43:
      // 55 43 version frame: t[2..4] = base VCU sw version. On stock firmware t[2] > 0 for a real read.
      if ((t[2] & 0xFF) > 0) {
        const ver = (t[2] & 0xFF) + '.' + (t[3] & 0xFF) + '.' + (t[4] & 0xFF);
        if (ver !== T.swVer) log('RX firmware R' + ver, 'log-rx');
        T.swVer = ver;
      }
      checkFwVersion();      // warn once if this is not the supported 3.4.6
      break;
    default: break;
  }
  renderLive();
}

// 55 51 / 55 55 / 55 56 each carry eight cell voltages as big-endian millivolts, no scaling.
function parseCells(t, base) {
  if (!T.cellMv) T.cellMv = new Array(CELL_SLOTS).fill(0);
  for (let k = 0; k < 8 && base + k < CELL_SLOTS; k++) T.cellMv[base + k] = u16(t, 2 + 2 * k);
}

function ascii(t, from, toInc) {
  let s = '';
  for (let i = from; i <= toInc && i < 20; i++) {
    const c = t[i] & 0xFF;
    if (c >= 0x20 && c <= 0x7E) s += String.fromCharCode(c);
  }
  return s.trim();
}
function updateFin() { T.fin = (deviceName || T.frameNum || '').trim(); }   // FIN only (BLE name; telemetry as fallback)

// --------------------------- BLE connection ---------------------------

let device = null, server = null, notifyChar = null, writeChar = null;
let notifyReady = false, connected = false, userDisconnect = false;
let deviceName = '';
let reconnectDelay = RECONNECT_BASE_MS;
let keepAliveTimer = null;
let linkConfirmed = false, linkTimer = null;   // "connected" is shown only once real telemetry arrives
let connecting = false;                        // connectGatt is not re-entrant, see the guard there

async function pickAndConnect() {
  if (!navigator.bluetooth) { log('Web Bluetooth not available. Use Bluefy (iOS) or Chrome.', 'log-err'); return; }
  try {
    userDisconnect = false;
    log('scanning...');
    const dev = await navigator.bluetooth.requestDevice({
      filters: NAME_PREFIXES.map(p => ({ namePrefix: p })),
      optionalServices: OPTIONAL_SERVICES,
    });
    log('selected: ' + sens(dev.name || '') + ' [' + sens(dev.id) + ']');
    await connectGatt(dev);                      // adopts the device, see adoptDevice
  } catch (e) {
    log('scan/connect cancelled: ' + e);
  }
}

// Named handler: an anonymous one leaves a second listener behind on a re-entered connect.
function onCharacteristicValue(ev) {
  try { onNotify(ev.target.value); } catch (e) {}
}

// The listener lives on the characteristic, so it has to be released BEFORE the reference to it is
// dropped: otherwise the old one keeps delivering into this page for as long as its GATT link lasts.
function detachNotify() {
  const nc = notifyChar;
  notifyChar = null;
  if (!nc) return;
  try { nc.removeEventListener('characteristicvaluechanged', onCharacteristicValue); } catch (e) {}
  try { const p = nc.stopNotifications(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}

// The one place where a device becomes THE device: the old notify listener goes first, then the
// reference, so a replaced device cannot leave a live listener behind.
function adoptDevice(dev) {
  if (!dev || dev === device) return;
  detachNotify();
  try { if (device) device.removeEventListener('gattserverdisconnected', onDisconnected); } catch (e) {}
  device = dev;
  deviceName = device.name || '';
  deviceId = device.id || '';
  updateFin();
  device.addEventListener('gattserverdisconnected', onDisconnected);
}

async function connectGatt(next) {
  const target = next || device;
  if (connecting) { log('connect already in progress'); return; }
  if (connected && target && target.gatt && target.gatt.connected) { log('already connected'); return; }
  connecting = true;
  try {
    adoptDevice(target);
    setStatus('connecting');
    notifyReady = false; connected = false;
    rxBuf = new Uint8Array(0);
    diagParsed = false;                            // fresh frame buffer + diagnostics
    server = await device.gatt.connect();
    const svc = await pickService(server);
    if (!svc) { setStatus('no-service'); log('no matching GATT service', 'log-err'); return; }
    await pickCharacteristics(svc);
    if (!notifyChar || !writeChar) { setStatus('no-char'); log('notify/write characteristic missing', 'log-err'); return; }
    await notifyChar.startNotifications();
    notifyChar.removeEventListener('characteristicvaluechanged', onCharacteristicValue);
    notifyChar.addEventListener('characteristicvaluechanged', onCharacteristicValue);
    notifyReady = true; connected = true; linkConfirmed = false;
    reconnectDelay = RECONNECT_BASE_MS;
    // The GATT link is up, but iOS reports success even for a bonded device far out of range (a
    // phantom link). Do NOT show "connected" yet: wait for a real frame (see confirmLink).
    setStatus('linking');
    renderLive();                  // show the tiles we already know from the BLE name
    try { if (device && device.id) localStorage.setItem(LS_DEVICE, device.id); } catch (e) {}
    log('link up, waiting for data. notify=' + notifyChar.uuid.slice(0, 8) + ' write=' + writeChar.uuid.slice(0, 8));
    startKeepAlive();
    if (linkTimer) clearTimeout(linkTimer);
    linkTimer = setTimeout(onLinkTimeout, LINK_TIMEOUT_MS);
  } finally {
    connecting = false;
  }
}

// Silence is not proof of a dead link: a scooter out of range or just booting answers late. Report
// the silence and keep the link plus auto-reconnect intact. It never tears a usable link down.
function onLinkTimeout() {
  linkTimer = null;
  if (linkConfirmed || !connected) return;
  log('no data yet: out of range or still booting. Link kept.', 'log-err');
  setStatus('no-data');
  resetTiles(); refreshSettingsInputs();
}

// The common ISSC/FF services to fetch directly when enumeration is unavailable (Bluefy).
const COMMON_SERVICES = [ISSC_SERVICE, NORDIC_SERVICE,
  '0000ffe0-0000-1000-8000-00805f9b34fb', '0000ffe1-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe5-0000-1000-8000-00805f9b34fb', '0000fff6-0000-1000-8000-00805f9b34fb',
  '0000ffb0-0000-1000-8000-00805f9b34fb', '0000fee0-0000-1000-8000-00805f9b34fb'];

async function pickService(srv) {
  const isMatch = u => u.startsWith('495353') || u.startsWith('6e400001') || /^0000f[c-f]/.test(u) || /^f[c-f][0-9a-f]{2}$/.test(u);
  async function direct(list) {
    const BATCH = 16;   // fetch in parallel batches so scanning the whole range stays fast
    for (let i = 0; i < list.length; i += BATCH) {
      const batch = list.slice(i, i + BATCH);
      const rs = await Promise.allSettled(batch.map(u => srv.getPrimaryService(u)));
      for (let j = 0; j < rs.length; j++) {
        if (rs[j].status === 'fulfilled' && rs[j].value) { log('service (direct): ' + batch[j].slice(0, 8)); return rs[j].value; }
      }
    }
    return null;
  }
  // The native app waits ~1500 ms after connect before discovering services. In Web Bluetooth the
  // service list can likewise be empty right after connect (Bluefy), so try twice with a wait.
  for (let attempt = 0; attempt < 2; attempt++) {
    let services = [];
    try { services = await srv.getPrimaryServices(); } catch (e) { log('service enumerate failed: ' + e); }
    if (services.length) {
      log('services: ' + services.map(s => s.uuid.slice(0, 8)).join(', '));
      let chosen = null;
      for (const s of services) if (isMatch(s.uuid.toLowerCase())) chosen = s;   // last match wins (as native)
      if (chosen) return chosen;
    }
    const d = await direct(COMMON_SERVICES);
    if (d) return d;
    if (attempt === 0) { log('no service yet, waiting for GATT discovery, retrying'); await sleep(1500); }
  }
  return await direct(VENDOR_16BIT);   // last resort: batched direct-fetch over the whole declared range
}

async function pickCharacteristics(svc) {
  detachNotify();                                // release the old characteristic before losing it
  writeChar = null;
  const u = svc.uuid.toLowerCase();
  if (u.startsWith('495353')) {
    try { notifyChar = await svc.getCharacteristic(ISSC_NOTIFY); } catch (e) {}
    try { writeChar  = await svc.getCharacteristic(ISSC_WRITE); } catch (e) {}
    if (notifyChar && writeChar) return;
  }
  let chars = [];
  try { chars = await svc.getCharacteristics(); } catch (e) { log('char enumerate failed: ' + e); }
  log('chars on ' + svc.uuid.slice(0, 8) + ': ' + chars.map(c => c.uuid.slice(0, 8)).join(', '));
  let anyWritable = null;
  for (const c of chars) {                       // last notify / last write-only wins (as native)
    const p = c.properties;
    if (p.notify) notifyChar = c;
    else if (p.write) writeChar = c;
    if (p.write || p.writeWithoutResponse) anyWritable = c;
  }
  if (!writeChar) writeChar = anyWritable;
}

function onDisconnected() {
  connected = false; notifyReady = false; linkConfirmed = false;
  if (linkTimer) { clearTimeout(linkTimer); linkTimer = null; }
  stopKeepAlive();
  setStatus('disconnected');
  resetTiles();
  refreshSettingsInputs();
  log('link dropped' + (userDisconnect ? ' (by user)' : ''));
  if (!userDisconnect && device) {
    if (pendingRestore) restoreArmed = true;     // a rename-triggered drop: arm the settings restore
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    log('reconnecting in ' + delay + ' ms');
    setTimeout(() => { if (!userDisconnect) reconnect(); }, delay);
  }
}

async function reconnect() {
  try { await connectGatt(); }
  catch (e) { log('reconnect failed: ' + e); if (!userDisconnect) setTimeout(reconnect, reconnectDelay); }
}

function disconnectBle() {
  userDisconnect = true;
  linkConfirmed = false;
  if (linkTimer) { clearTimeout(linkTimer); linkTimer = null; }
  stopKeepAlive();
  try { if (device && device.gatt.connected) device.gatt.disconnect(); } catch (e) {}
  connected = false; notifyReady = false;
  setStatus('disconnected');
  resetTiles();
  refreshSettingsInputs();
}

// --------------------------- keep-alive + write queue ---------------------------

function startKeepAlive() {
  stopKeepAlive();
  const tick = () => {
    if (!notifyReady) return;
    enqueue(connectCode(0));
    keepAliveTimer = setTimeout(tick, CONNECT_CODE_INTERVAL_MS);
  };
  tick();
}
function stopKeepAlive() { if (keepAliveTimer) { clearTimeout(keepAliveTimer); keepAliveTimer = null; } }

const writeQueue = [];
let writing = false;

// Log outgoing frames: the 0x18 settings write is the notable TX, always shown. The 0x01 keep-alive
// is verbose, so it is only logged when Diagnostics is on.
function logTx(frame) {
  const cmd = frame[1] & 0xFF;
  if (cmd === 0x18) log('TX ' + hexOf(frame, 20), 'log-tx');
  else if (diagLog) log('TX ' + hexOf(frame, 8), 'log-tx');
}

function enqueue(frame) {
  logTx(frame);
  writeQueue.push(frame);
  drain();
}
async function drain() {
  if (writing || !notifyReady) return;
  writing = true;
  while (writeQueue.length) {
    const f = writeQueue.shift();
    try { await doWrite(f); } catch (e) { log('write error: ' + e, 'log-err'); }
    await sleep(WRITE_GAP_MS);
  }
  writing = false;
}
async function doWrite(frame) {
  const wc = writeChar;
  if (!wc) throw 'no write characteristic';
  const buf = frame.buffer ? frame : Uint8Array.from(frame);
  if (wc.properties.write && wc.writeValueWithResponse) return wc.writeValueWithResponse(buf);
  if (wc.properties.writeWithoutResponse && wc.writeValueWithoutResponse) return wc.writeValueWithoutResponse(buf);
  return wc.writeValue(buf);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --------------------------- lock / unlock + wheel / cruise ---------------------------
//
// Wheel diameter + cruise are the only user prefs we persist (localStorage). On lock the wheel is
// forced to the eKFV value, so the app is the sole place the real value survives. On unlock, after
// the rename-reconnect brings a fresh 55 71, we re-apply both.

const LS_WHEEL = 'trbm_wheel', LS_CRUISE = 'trbm_cruise', LS_DEVICE = 'trbm_device', LS_LOCK = 'trbm_lock';
let pendingRestore = false;     // set on unlock; consumed by the first 55 71 after the reconnect
let restoreArmed = false;       // set once the rename-drop actually happened
let deviceId = '';              // BLE device id, redacted out of the public log

function savedWheel() { const v = parseFloat(localStorage.getItem(LS_WHEEL)); return isNaN(v) ? null : v; }
function savedCruise() { const v = parseInt(localStorage.getItem(LS_CRUISE), 10); return isNaN(v) ? null : v; }
function persistWheel(v) { try { localStorage.setItem(LS_WHEEL, String(v)); } catch (e) {} }
function persistCruise(v) { try { localStorage.setItem(LS_CRUISE, String(v)); } catch (e) {} }

// Per-gear lock speeds. Riders want the locked gears staggered, and a value under 22 keeps the
// start-up peak under the eKFV limit. Defaults 10/15/21, remembered as a JSON triple.
const LOCK_DEFAULTS = [10, 15, 21];
function clampLock(v) { return Math.min(Math.max(v, 1), 22); }
function savedLocks() {
  try { const a = JSON.parse(localStorage.getItem(LS_LOCK)); return (Array.isArray(a) && a.length === 3) ? a : null; }
  catch (e) { return null; }
}
function lockValues() { return [1, 2, 3].map(n => clampLock(readNum('g' + n + '-lock', LOCK_DEFAULTS[n - 1]))); }
function persistLocks() { try { localStorage.setItem(LS_LOCK, JSON.stringify(lockValues())); } catch (e) {} }

// User sets the wheel diameter (unlocked only). Save it, then write the full 0x18 with the new wheel.
function setWheel(v) {
  if (!requireReady() || !requireUnlocked('wheel size')) return;
  S.wheel = v;
  persistWheel(v);
  writeWheelCruiseAllGears();
  log('wheel set to ' + v + ' (saved)');
}

// User sets cruise: 0 off, 1 auto, 2 manual. Stays settable while locked. Save it, then write 0x18.
function setCruise(v) {
  if (!requireReady()) return;
  S.cruise = v;
  persistCruise(v);
  writeWheelCruiseAllGears();
  refreshToggle();
  log('cruise set to ' + v + ' (saved)');
}

function readNum(id, dflt) {
  const el = $(id);
  const v = el ? parseInt(el.value, 10) : NaN;
  return (isNaN(v) || v < 0) ? dflt : Math.min(v, 100);
}

// Start level / eABS field: the value is the low/high nibble of a[8]/a[9], so 0..15 fit on the wire.
// Empty field returns null -> the mirrored (unchanged) level is written.
function readLevel(id) {
  const el = $(id);
  if (!el || el.value === '') return null;
  const v = parseInt(el.value, 10);
  return isNaN(v) ? null : Math.max(0, Math.min(v, 15));
}

// Germany uses the internal ESC gears 2, 3, 4 (the rider sees them as gears 1, 2, 3). Internal gears
// 1 and 5 exist only abroad, so we never touch them. DE_GEARS maps rider gear -> internal ESC gear.
const DE_GEARS = [2, 3, 4];

// Write one 0x18 frame per German gear (internal 2/3/4), setting that gear's speed (a[10]). Everything
// else is mirrored from the last 55 71. vals[i] is the speed for DE_GEARS[i]. Confirmed lever from the
// captures: byte10 = 22 locked, ~60 open. This is the clean 3.4.6 path (3.4.8 never reaches here).
function writeGearSpeeds(vals) {
  const plan = [[2, vals[0], 1], [3, vals[1], 2], [4, vals[2], 3]];   // [internalGear, speed, riderField]
  const notes = [];
  const curDefaults = [20, 25, 30];
  for (const [g, spd, rider] of plan) {
    const eabsIn = readLevel('g' + rider + '-eabs');   // null (empty) = default 2
    const eabs = (eabsIn != null) ? eabsIn : 2;
    const fsIn = readLevel('g' + rider + '-fs');       // null (empty) = default 5
    const rsIn = readLevel('g' + rider + '-rs');
    const fs = (fsIn != null) ? fsIn : 5;
    const rs = (rsIn != null) ? rsIn : 5;
    const cur = readNum('g' + rider + '-cur', curDefaults[rider - 1] || 25);
    enqueue(buildSettingFrame(2, g, eabs, fs, rs, spd & 0xFF, cur, cur));
    if (fsIn != null || rsIn != null || eabsIn != null) notes.push('gear ' + rider + ' start f=' + fs + ' r=' + rs + ' eABS=' + eabs + ' current=' + cur);
  }
  if (notes.length) log('advanced levels: ' + notes.join(' | '));
}

function unlock() {
  if (!requireReady()) return;
  const v = [readNum('g1-in', 45), readNum('g2-in', 60), readNum('g3-in', 80)];
  writeGearSpeeds(v);
  T.lock = 'unlocked';
  log('unlocked: gear 1/2/3 (ESC 2/3/4) = ' + v.join(' / '), 'log-ok');
  refreshToggle();
}

function lock() {
  if (!requireReady()) return;
  const lv = lockValues();
  writeGearSpeeds(lv);
  T.lock = 'locked';
  log('locked: gear 1/2/3 = ' + lv.join(' / '), 'log-ok');
  refreshToggle();
}

// Called on every 55 71. When a restore is armed (unlock happened, link dropped and came back),
// re-apply the saved wheel + cruise once.
function onSettingsFrame() {
  if (pendingRestore && restoreArmed && S.received71) {
    const w = savedWheel(), c = savedCruise();
    if (w != null) S.wheel = w;
    if (c != null) S.cruise = c;
    writeWheelCruiseAllGears();
    log('restored after unlock: wheel=' + (w != null ? w : '-') + ' cruise=' + (c != null ? c : '-'));
    pendingRestore = false; restoreArmed = false;
  }
}

// Central gate: lock/unlock and every 0x18 write are enabled ONLY on the supported 3.4.6. 3.4.8,
// any other version and the pre-read unknown state are all read-only (the safe default).
function lockUnlockAllowed() {
  return connected && S.received71 && T.swVer === SUPPORTED_FW;
}
const settingsAllowed = lockUnlockAllowed;   // wheel/cruise/gear grid share the same gate

const GEAR_INPUT_IDS = [
  'g1-in', 'g1-lock', 'g1-fs', 'g1-rs', 'g1-cur', 'g1-eabs',
  'g2-in', 'g2-lock', 'g2-fs', 'g2-rs', 'g2-cur', 'g2-eabs',
  'g3-in', 'g3-lock', 'g3-fs', 'g3-rs', 'g3-cur', 'g3-eabs',
  'speed-open', 'speed-legal',
];
function refreshGearInputs() {
  const ok = settingsAllowed();
  GEAR_INPUT_IDS.forEach(id => { const el = $(id); if (el) el.disabled = !ok; });
}

function requireReady() {
  if (!connected) { log('connect first'); return false; }
  if (!S.received71) { log('waiting for telemetry (55 71) before writing settings'); return false; }
  if (T.swVer !== SUPPORTED_FW) {
    log('lock/unlock is only available on firmware ' + SUPPORTED_FW
        + (isFw348() ? ' - 3.4.8 ignores every BLE write' : T.swVer ? ' - version ' + T.swVer + ' is read-only' : ' - firmware not read yet'), 'log-err');
    return false;
  }
  return true;
}

// Wheel size is only settable while unlocked: the firmware discards it otherwise. Second guard so a
// deep-link, a stale page or a console call cannot push a write the controller would silently drop.
function requireUnlocked(what) {
  if (T.lock === 'locked') { log('unlock the scooter first to change the ' + what); return false; }
  return true;
}

// --------------------------- shortcut deep-link + auto-reconnect ---------------------------
//
// A home-screen shortcut opens the page with ?do=lock or ?do=unlock. On load we reconnect to the last
// granted scooter via getDevices(): no chooser. The action runs once connected AND the firmware gate
// allows it; on a blocked/unknown firmware the shortcut is refused with the same reason as the UI.

let pendingDeepAction = null;     // 'lock' | 'unlock' parsed from the URL, run once after connect

function parseDeepLink() {
  try {
    let a = (new URLSearchParams(location.search).get('do') || '').toLowerCase();
    if (!a && location.hash) a = (new URLSearchParams(location.hash.replace(/^#/, '')).get('do') || '').toLowerCase();
    if (a === 'lock' || a === 'unlock') { pendingDeepAction = a; log('shortcut: ' + a + ' requested'); }
  } catch (e) {}
}

function maybeRunDeepAction() {
  if (!pendingDeepAction || !connected || !S.received71) return;   // both actions write a full 0x18
  if (lockUnlockAllowed()) {
    const act = pendingDeepAction;
    pendingDeepAction = null;
    log('shortcut: auto-' + act);
    if (act === 'unlock') unlock(); else lock();
    return;
  }
  // Firmware known but not 3.4.6 -> refuse the shortcut with the reason. Unknown -> keep waiting.
  if (T.swVer) {
    const act = pendingDeepAction;
    pendingDeepAction = null;
    log('shortcut ' + act + ' refused: '
        + (isFw348() ? '3.4.8 ignores every BLE write' : 'firmware ' + T.swVer + ' is read-only'), 'log-err');
  }
}

// Reconnect to a previously paired scooter without showing the chooser (Web Bluetooth getDevices()).
async function tryAutoReconnect() {
  if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return;
  try {
    const devs = await navigator.bluetooth.getDevices();
    if (!devs || !devs.length) return;
    const savedId = localStorage.getItem(LS_DEVICE);
    const dev = (savedId && devs.find(d => d.id === savedId))
             || devs.find(d => (d.name || '') && NAME_PREFIXES.some(p => d.name.startsWith(p)))
             || null;
    if (!dev) return;
    userDisconnect = false;
    log('auto-reconnect: ' + sens(dev.name || dev.id));
    await connectGatt(dev);
  } catch (e) {
    setStatus('disconnected');
    log('auto-reconnect skipped: ' + e);
  }
}

// --------------------------- UI ---------------------------

function $(id) { return document.getElementById(id); }
function setStatus(s) {
  const el = $('status'); if (el) { el.textContent = s; el.dataset.state = s; }
  const cb = $('btn-conn');
  if (cb) {
    const on = (s === 'connecting' || s === 'linking' || s === 'connected' || s === 'no-data');
    cb.textContent = on ? t('btnDisconnect') : t('btnConnect');
    cb.dataset.act = on ? 'disconnect' : 'connect';
  }
  refreshInfoButtons();
}

// --------------------------- log panel (lb-tool-web model) ---------------------------
//
// Timestamped, appended newest-at-bottom with autoscroll, coloured TX/RX/ok/err, buffered so a
// re-render (the Public Log toggle) can rebuild it. Copy / clear / save all use the same redacted text.

let logBuffer = [];
let publicLog = true;
let diagLog = false;

function hexOf(bytes, max) {
  let h = '';
  const n = Math.min(bytes.length, max || bytes.length);
  for (let i = 0; i < n; i++) h += (bytes[i] & 0xFF).toString(16).padStart(2, '0') + ' ';
  return h.trim();
}
// Wrap a value that should be masked in the public log (FIN / BLE name / device id).
function sens(s) { return '\x01' + String(s) + '\x01'; }

function redact(text) {
  let s = String(text);
  if (deviceId) s = s.split(deviceId).join('[redacted-id]');
  s = s.replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, '[redacted-mac]');
  s = s.replace(/\b(secret|token|key|aes|pwd|password|pin|mac|serial|vin|uid|imei)\b(\s*[:=]\s*)("?)([^\s",]+)\3/gi,
    function (m, k, sep) { return k + sep + '[redacted]'; });
  s = s.replace(/\b[0-9A-Fa-f]{16,}\b/g, '[redacted-hex]');
  return s;
}
// Public log on = mask the driver-marked spans (\x01..\x01, e.g. FIN) and run redaction. Off = the
// full raw line (local debugging only, do not share).
function anonymize(s) {
  if (publicLog === false) return s.replace(/\x01/g, '');
  return redact(s.replace(/\x01[^\x01]*\x01/g, 'XX').replace(/\x01/g, ''));
}
function log(msg, cls) {
  const ts = new Date().toISOString().slice(11, 19);
  const raw = '[' + ts + '] ' + msg;
  logBuffer.push({ raw: raw, cls: cls || '' });
  const pre = $('log');
  if (pre) {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = anonymize(raw) + '\n';
    pre.appendChild(span);
    pre.scrollTop = pre.scrollHeight;
  }
}
function renderLog() {
  const pre = $('log'); if (!pre) return;
  pre.textContent = '';
  logBuffer.forEach(function (e) {
    const span = document.createElement('span');
    if (e.cls) span.className = e.cls;
    span.textContent = anonymize(e.raw) + '\n';
    pre.appendChild(span);
  });
  pre.scrollTop = pre.scrollHeight;
}
function clearLog() { logBuffer = []; const pre = $('log'); if (pre) pre.textContent = ''; log(t('logCleared')); }
function copyLog() {
  const text = logBuffer.map(function (e) { return anonymize(e.raw); }).join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { log(t('logCopied'), 'log-ok'); },
      function () { log('clipboard write failed', 'log-err'); });
  } else { log('clipboard API unavailable', 'log-err'); }
}
function saveLog() {
  const text = logBuffer.map(function (e) { return anonymize(e.raw); }).join('\n');
  try {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'laufbursche42-log.txt';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    log(t('logSaved'), 'log-ok');
  } catch (e) { log('save failed: ' + e.message, 'log-err'); }
}

// The single lock/unlock control reflects the current state: "Unlock" when locked, "Lock" when open.
// The state is derived from the live 55 71 per-gear speed. Enabled only when 3.4.6 is confirmed.
function refreshToggle() {
  const btn = $('btn-toggle');
  if (!btn) return;
  const locked = (T.lock !== 'unlocked');
  btn.textContent = locked ? t('btnUnlock') : t('btnLock');
  btn.dataset.action = locked ? 'unlock' : 'lock';
  btn.disabled = !lockUnlockAllowed();
}

// The detected-firmware indicator: single source of truth for what the tool allows.
function fwVerdict() {
  if (T.swVer === SUPPORTED_FW) return { cls: '', text: t('fwState346'), reason: null };
  if (isFw348()) return { cls: 'caution', text: t('fwState348'), reason: t('lockReason348') };
  if (T.swVer) return { cls: 'neutral', text: fmt(t('fwStateOther'), { ver: T.swVer }),
                        reason: fmt(t('lockReasonOther'), { ver: T.swVer }) };
  return { cls: 'neutral', text: t('fwStateReading'), reason: t('lockReasonReading') };
}
function renderFwState() {
  const host = $('fw-state');
  if (host) {
    const v = fwVerdict();
    host.className = 'verdict' + (v.cls ? ' ' + v.cls : '');
    host.replaceChildren();
    const b = document.createElement('b');
    b.textContent = v.text;
    host.appendChild(b);
  }
  // The reason under the lock card: hidden on 3.4.6 (allowed), shown otherwise.
  const reason = $('lock-reason');
  if (reason) {
    const v = fwVerdict();
    if (v.reason && !lockUnlockAllowed()) { reason.textContent = v.reason; reason.hidden = false; }
    else reason.hidden = true;
  }
}

// Live telemetry tiles. Every field the Blade Mini shows, filled from the parsed frames; shown in
// every firmware state (the read-only surface never depends on the gate).
function tileText(id, val) { const el = $(id); if (el) el.textContent = val; }
function renderLive() {
  renderFwState();
  const dash = '-';
  const kmh = S.isUnitMile ? t('unitMph') : t('unitKmh');
  tileText('t-speed', T.have72 ? (T.speed.toFixed(1) + ' ' + kmh) : dash);
  tileText('t-batt', T.have52 ? (T.soc + ' %') : dash);
  // Voltage: prefer the BMS pack voltage (55 52); fall back to the 55 71 config pack voltage.
  const volt = (T.have52 && T.volt > 0) ? (T.volt.toFixed(1) + ' V')
             : (S.received71 ? (S.packVolt + ' V') : dash);
  tileText('t-volt', volt);
  // Current is hidden when the Blade Mini leaves the smart-BMS field empty (sentinel -1000 A).
  const curTile = $('tile-cur');
  if (T.have52 && T.current > -999.9) {
    tileText('t-cur', T.current.toFixed(1) + ' A');
    if (curTile) curTile.hidden = false;
  } else if (curTile) {
    curTile.hidden = true;
  }
  tileText('t-lock', T.lock === 'unlocked' ? t('lockUnlocked')
                   : T.lock === 'locked' ? t('lockLocked')
                   : (S.received71 ? t('lockUnknown') : dash));
  tileText('t-gear', S.received71 ? String(S.gear) : dash);
  tileText('t-cruise', S.received71 ? cruiseName(S.cruise) : dash);
  tileText('t-wheel', S.received71 ? (S.wheel.toFixed(1) + ' "') : dash);
  tileText('t-unit', S.received71 ? kmh : dash);
  tileText('t-abs', S.received71 ? t(S.abs ? 'onLabel' : 'offLabel') : dash);
  tileText('t-fw', T.swVer ? ('R' + T.swVer) : dash);
  tileText('t-serial', (T.fin || deviceName) ? (T.fin || deviceName) : dash);
  refreshSettingsInputs();
  refreshGearInputs();
  refreshToggle();
  refreshInfoButtons();
}
function resetTiles() {                                 // no telemetry -> show "-"
  T.lock = null;
  T.have52 = false; T.have53 = false; T.have72 = false; T.cellMv = null; T.errors = null;
  T.ecu1 = null; T.ecu2 = null;
  S.received71 = false;
  T.swVer = null; fwWarned = false;   // a reconnect re-reads the version and may warn again
  renderLive();
}

// Wheel + cruise: editable only once the scooter reported its config (55 71) on the supported 3.4.6.
// Prefilled ONCE with the value the scooter delivers; after that the user edits freely.
let settingsPrefilled = false;
function refreshSettingsInputs() {
  const ready = settingsAllowed();
  const win = $('wheel-in'), cin = $('cruise-in'), bw = $('btn-set-wheel'), bc = $('btn-set-cruise');
  // Wheel size may only be changed while unlocked. Cruise stays settable while locked.
  const locked = ready && T.lock === 'locked';
  [win, bw].forEach(el => { if (el) { el.disabled = !ready || locked; el.title = locked ? t('tipWheelLocked') : ''; } });
  [cin, bc].forEach(el => { if (el) { el.disabled = !ready; el.title = ''; } });
  if (ready && !settingsPrefilled) {
    if (win) win.value = S.wheel.toFixed(1);
    if (cin) cin.value = String(S.cruise);
    settingsPrefilled = true;
  } else if (!ready) {
    settingsPrefilled = false;
  }
}

// --------------------------- error reports + battery info ---------------------------
//
// Two read-only views of what the scooter streams by itself. Nothing is sent for either: 55 54 carries
// the BMS severity array, 55 72 t[10]/t[11] the controller fault bits, 55 52 / 55 53 the pack summary
// and 55 51 / 55 55 / 55 56 the per-cell voltages.

const ERROR_NAMES = [
  'errDischargeOverTemp', 'errDischargeUnderTemp', 'errChargeOverTemp', 'errChargeUnderTemp',
  'errCellOverVolt', 'errCellUnderVolt', 'errPackOverVolt', 'errPackUnderVolt',
  'errDischargeOverCurrent', 'errChargeOverCurrent', 'errCellVoltSpread', 'errCellTempSpread',
  'errChargeLevelLow', 'errMosfet1Temp', 'errMosfet2Temp', 'errChargingState'
];
const ERROR_PACK_FLAG = 16;      // the one index in the array that is a status flag, not a fault
const INFO_REFRESH_MS = 1000;    // how often an open view redraws from the live frames
const CELL_FULL_MV = 3400, CELL_LOW_MV = 2650;

function ecuBit(byte, bit) { return byte != null && ((byte >> bit) & 1) === 1; }

// Active faults only. Over-temperature counts from level 2, every other type from level 3.
function collectErrors() {
  const items = [];
  if (Array.isArray(T.errors)) {
    T.errors.forEach((sev, code) => {
      if (code === ERROR_PACK_FLAG || !(sev > 0)) return;
      const active = (code === 0 || code === 2) ? sev > 1 : sev > 2;
      if (!active) return;
      const key = ERROR_NAMES[code];
      items.push({
        kind: 'bad', battery: true,
        title: key ? t(key) : fmt(t('errUnknown'), { code: code }),
        sub: fmt(t('errSevSub'), { n: sev }),
      });
    });
  }
  if (ecuBit(T.ecu1, 0)) items.push({ kind: 'bad', title: t('errBrakeTitle'), sub: t('errBrakeSub') });
  if (ecuBit(T.ecu1, 3)) items.push({ kind: 'bad', title: t('errWarnTitle'), sub: t('errWarnSub') });
  if (ecuBit(T.ecu1, 4)) items.push({ kind: 'bad', title: t('errWarn2Title'), sub: t('errWarn2Sub') });
  if (ecuBit(T.ecu1, 2)) items.push({ kind: 'caution', title: t('errTailTitle'), sub: t('errTailSub') });
  if (ecuBit(T.ecu1, 7) || ecuBit(T.ecu2, 7)) {
    items.push({ kind: 'info', title: t('errParkTitle'), sub: t('errParkSub') });
  }
  return items;
}

function infoNote(key) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.setAttribute('data-t', key);
  p.textContent = t(key);
  return p;
}
function gridNote(key) {
  const p = infoNote(key);
  p.classList.add('span2');
  return p;
}
function errorBox(item) {
  const box = document.createElement('div');
  box.className = 'verdict ' + item.kind;
  const title = document.createElement('b');
  title.textContent = item.title;
  const sub = document.createElement('span');
  sub.className = 'detail';
  sub.textContent = item.sub;
  box.appendChild(title);
  box.appendChild(sub);
  return box;
}

function renderErrorReports() {
  const host = $('err-list');
  if (!host) return;
  host.replaceChildren();
  if (!connected) { host.appendChild(infoNote('infoConnectFirst')); return; }
  const items = collectErrors();
  if (items.length) { items.forEach(item => host.appendChild(errorBox(item))); return; }
  // A clean bill of health only once BOTH sources have reported: 55 54 (battery) and 55 72 (controller).
  const complete = Array.isArray(T.errors) && T.ecu1 !== null;
  host.appendChild(infoNote(complete ? 'errEmpty' : 'infoWaiting'));
}

function batRow(key, value) {
  const row = document.createElement('div');
  row.className = 'led-row-inline kv';
  const label = document.createElement('label');
  label.setAttribute('data-t', key);
  label.textContent = t(key);
  const val = document.createElement('b');
  val.textContent = value;
  row.appendChild(label);
  row.appendChild(val);
  return row;
}

// Every number the pack reports. A frame that has not arrived leaves its rows on the placeholder.
function batteryRows() {
  const dash = '-';
  const notSent = t('batNotSent');
  const v53 = (val, unit) => T.have53 ? (val + ' ' + unit) : dash;
  const cellV = mv => T.have53 ? ((mv / 1000).toFixed(3) + ' V') : dash;
  // The Blade leaves the smart-BMS 55 52 fields empty: 0 V / -1000 A / -40 degC. Show those sentinels
  // as "not sent", not as a false number. Real (T2) packs land outside the sentinels and show normally.
  const volt = !T.have52 ? dash : (T.volt > 0 ? T.volt.toFixed(1) + ' V' : notSent);
  const curr = !T.have52 ? dash : (T.current > -999.9 ? T.current.toFixed(1) + ' A' : notSent);
  const cTemp = val => !T.have52 ? dash : (val > -40 ? val.toFixed(0) + ' °C' : notSent);
  const mTemp = val => !T.have72 ? dash : (val > 0 ? val + ' °C' : notSent);
  const mCur = val => T.have72 ? val.toFixed(1) + ' A' : dash;
  return [
    batRow('batVolt', volt),
    batRow('batCurrent', curr),
    batRow('batSoc', T.have52 ? (T.soc + ' %') : dash),
    batRow('batSoh', T.have52 ? (T.soh + ' %') : dash),
    batRow('batCapacity', v53(T.capacity, 'Ah')),
    batRow('batCycles', T.have53 ? String(T.chargeCounter) : dash),
    batRow('batMaxCellV', cellV(T.maxCellV)),
    batRow('batMinCellV', cellV(T.minCellV)),
    batRow('batMaxCellT', cTemp(T.maxCellTemp)),
    batRow('batMinCellT', cTemp(T.minCellTemp)),
    batRow('batDelta', v53(T.maxCellV - T.minCellV, 'mV')),
    batRow('batMotorTempR', mTemp(T.mTempR)),
    batRow('batMotorTempF', mTemp(T.mTempF)),
    batRow('batMotorCurR', mCur(T.mCurR)),
    batRow('batMotorCurF', mCur(T.mCurF)),
  ];
}

// One tile per cell, coloured by voltage and outlined while the BMS balances it. The balancing
// bitfield covers the first eight cells only.
function renderBatteryCells(host) {
  host.replaceChildren();
  const cells = T.cellMv;
  if (!cells || !cells.some(mv => mv > 0)) {
    host.appendChild(gridNote(T.have52 && !T.have53 ? 'batNoCells' : 'infoWaiting'));
    return;
  }
  const count = (T.have53 && T.cellCount > 0) ? Math.min(T.cellCount, CELL_SLOTS) : CELL_SLOTS;
  for (let k = 0; k < count; k++) {
    const mv = cells[k] || 0;
    if (mv <= 0) continue;
    const tile = document.createElement('div');
    tile.className = 'tile';
    if (mv > CELL_FULL_MV) tile.classList.add('cell-full');
    else if (mv < CELL_LOW_MV) tile.classList.add('cell-low');
    const balancing = T.have53 && k < 8 && ((T.balance >> k) & 1) === 1;
    if (balancing) tile.classList.add('cell-bal');
    const volt = document.createElement('b');
    volt.textContent = (mv / 1000).toFixed(3) + ' V';
    const name = document.createElement('small');
    name.textContent = fmt(t('batCell'), { n: k + 1 });
    tile.appendChild(volt);
    tile.appendChild(name);
    if (balancing) {
      const tag = document.createElement('small');
      tag.className = 'bal';
      tag.textContent = t('batBalancing');
      tile.appendChild(tag);
    }
    host.appendChild(tile);
  }
}

function renderBatteryInfo() {
  const health = $('bat-health'), pack = $('bat-pack'), cells = $('bat-cells');
  if (!health || !pack || !cells) return;
  health.replaceChildren();
  pack.replaceChildren();
  if (!connected) {
    health.appendChild(infoNote('infoConnectFirst'));
    cells.replaceChildren(gridNote('infoConnectFirst'));
    return;
  }
  if (!Array.isArray(T.errors)) {
    health.appendChild(infoNote('infoWaiting'));
  } else {
    const warnings = collectErrors().filter(item => item.battery).map(item => item.title);
    const box = document.createElement('div');
    box.className = warnings.length ? 'verdict bad' : 'verdict';
    const head = document.createElement('b');
    head.textContent = warnings.length ? fmt(t('batHealthWarn'), { n: warnings.length }) : t('batHealthOk');
    box.appendChild(head);
    if (warnings.length) {
      const list = document.createElement('ul');
      warnings.forEach(w => {
        const li = document.createElement('li');
        li.textContent = w;
        list.appendChild(li);
      });
      box.appendChild(list);
    }
    health.appendChild(box);
  }
  batteryRows().forEach(row => pack.appendChild(row));
  renderBatteryCells(cells);
}

// Both views need a link that is proven to deliver frames.
function refreshInfoButtons() {
  const ready = connected && linkConfirmed;
  ['btn-err', 'btn-bat'].forEach(id => { const b = $(id); if (b) b.disabled = !ready; });
}

let errTimer = null, batTimer = null;
function openInfoView(dialogId, render, stop) {
  const dlg = $(dialogId);
  if (!dlg || !dlg.showModal) { log('this browser cannot show the ' + dialogId + ' view'); return; }
  stop();
  render();
  dlg.showModal();
  return setInterval(render, INFO_REFRESH_MS);
}
function openErrorReports() { errTimer = openInfoView('err', renderErrorReports, stopErrorReports) || null; }
function stopErrorReports() { if (errTimer) { clearInterval(errTimer); errTimer = null; } }
function openBatteryInfo() { batTimer = openInfoView('bat', renderBatteryInfo, stopBatteryInfo) || null; }
function stopBatteryInfo() { if (batTimer) { clearInterval(batTimer); batTimer = null; } }

// --------------------------- language ---------------------------
//
// Every visible string comes from i18n.js: elements carry data-t="key", the run-time strings are
// looked up with t(). German is the default, never browser-detected.

let lang = 'de';

function table() { return (window.I18N && window.I18N[lang]) || {}; }
function t(key) { const v = table()[key]; return (typeof v === 'string') ? v : ''; }
function tList(key) { const v = table()[key]; return Array.isArray(v) ? v : []; }
function fmt(s, vars) { return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)); }
function cruiseName(v) { return [t('cruiseOff'), t('cruiseAuto'), t('cruiseManual')][v] || t('cruiseOff'); }

function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach(n => {
    const v = t(n.getAttribute('data-t'));
    if (/[<&]/.test(v)) n.innerHTML = v; else n.textContent = v;   // scan-ok: our own translation table, only <b>/<a>/<code>
  });
  // Advanced grid gear labels carry a number, so they are formatted rather than plain data-t.
  [1, 2, 3].forEach(n => { const el = $('gear-lbl-' + n); if (el) el.textContent = fmt(t('gearLabel'), { n: n }); });
  { const el = $('wheel-in'); if (el) el.placeholder = t('phWheel'); }
  { const el = $('link-guide'); if (el) el.href = docFile('GUIDE'); }
  { const el = $('link-readme'); if (el) el.href = docFile('README'); }
  { const el = $('link-privacy'); if (el) el.href = docFile('PRIVACY'); }
  { const el = $('link-license'); if (el) el.href = docFile('LICENSE'); }
  { const el = $('link-trademarks'); if (el) el.href = docFile('TRADEMARKS'); }
  { const el = $('langs'); if (el) el.setAttribute('aria-label', t('langGroup')); }
  { const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    const el = $('btn-theme');
    if (el) { el.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); el.title = el.getAttribute('aria-label'); } }
  { const el = $('build-ver'); if (el) el.textContent = t('buildLabel') + ' ' + BUILD; }
  document.querySelectorAll('#langs button').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  });
  { const el = $('status'); setStatus(el ? el.dataset.state : 'disconnected'); }
  renderLive();
}

// --------------------------- theme ---------------------------

const LS_THEME = 'tru_theme';

function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const b = $('btn-theme');
  if (b) {
    b.innerHTML = dark ? '&#9728;' : '&#9790;';   // scan-ok: a fixed character, not user input
    b.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark'));
    b.title = b.getAttribute('aria-label');
  }
  try { localStorage.setItem(LS_THEME, dark ? 'dark' : 'light'); } catch (e) {}
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(LS_THEME); } catch (e) {}
  applyTheme(saved !== 'light');
  const b = $('btn-theme');
  if (b) b.addEventListener('click', () => {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'light');
  });
}

function initLangSwitch() {
  document.querySelectorAll('#langs button').forEach(b => {
    b.addEventListener('click', () => { lang = b.dataset.lang; applyLang(); });
  });
}

// --------------------------- document viewer ---------------------------
// The guide, disclaimer, licence, privacy notice and trademarks are files of this site. They open
// here, so a reader is never handed a raw markdown file or sent off to a code host.

const DOC_TITLES = {
  'GUIDE.de.md': 'footGuide', 'GUIDE.en.md': 'footGuide',
  'PRIVACY.de.md': 'footPrivacy', 'PRIVACY.md': 'footPrivacy',
  'LICENSE.de.md': 'footLicense', 'LICENSE.md': 'footLicense',
  'TRADEMARKS.de.md': 'footTrademarks', 'TRADEMARKS.md': 'footTrademarks',
  'README.md': 'footReadme',
};

const DISCLAIMER_HREF = 'README.md#disclaimer';

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const slug = s => s.toLowerCase().trim()
  .replace(/[^\w\sÀ-ɏ-]/g, '')
  .replace(/ /g, '-');

// Only the markdown these documents use: headings, lists with one level of nesting, tables, fenced
// code, quotes, rules, bold, inline code and links.
function mdToHtml(src) {
  const inline = s => escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, text, href) => {
      if (href === DISCLAIMER_HREF) return `<a href="${href}" data-disclaimer>${text}</a>`;
      if (DOC_TITLES[href]) return `<a href="${href}" data-docfile="${href}">${text}</a>`;
      if (href.startsWith('#')) return `<a href="${href}" data-anchor="${href.slice(1)}">${text}</a>`;
      return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
    });

  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let listKind = null;
  let li = null;
  let para = [];
  let inFence = false;

  const sink = () => (li ? li.parts : out);
  const flushPara = () => { if (para.length) { sink().push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const closeNested = () => { if (li && li.nested) { li.parts.push('</ul>'); li.nested = false; } };
  const closeLi = () => {
    if (!li) return;
    flushPara(); closeNested();
    out.push('<li>' + li.parts.join('\n') + '</li>');
    li = null;
  };
  const closeList = () => { closeLi(); if (listKind) { out.push('</' + listKind + '>'); listKind = null; } };
  const block = () => { flushPara(); closeList(); };
  const openList = kind => {
    flushPara();
    if (listKind !== kind) { closeList(); out.push('<' + kind + '>'); listKind = kind; } else closeLi();
  };
  const cells = l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const body = l.trim();
    const indented = /^ {2,}\S/.test(l);

    if (inFence) {
      if (body.startsWith('```')) { sink().push('</code></pre>'); inFence = false; } else sink().push(escHtml(l));
      continue;
    }
    if (body.startsWith('```')) {
      if (li) { flushPara(); closeNested(); } else block();
      sink().push('<pre><code>');
      inFence = true;
      continue;
    }
    if (body === '') {
      if (li && /^ {2,}\S/.test(lines[i + 1] || '')) flushPara(); else block();
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(body)) { block(); out.push('<hr>'); continue; }

    if (body.startsWith('|') && /^\|[\s:|-]+\|?\s*$/.test((lines[i + 1] || '').trim())) {
      if (li) { flushPara(); closeNested(); } else block();
      sink().push('<div class="doc-table"><table><thead><tr>'
        + cells(body).map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>');
      i++;
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
        sink().push('<tr>' + cells(lines[++i].trim()).map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>');
      }
      sink().push('</tbody></table></div>');
      continue;
    }

    let m;
    if ((m = body.match(/^(#{1,4})\s+(.*)$/))) {
      block();
      const n = m[1].length;
      out.push(`<h${n} id="${slug(m[2])}">${inline(m[2])}</h${n}>`);
      continue;
    }
    if ((m = body.match(/^>\s?(.*)$/))) {
      if (li) { flushPara(); closeNested(); } else block();
      sink().push('<blockquote>' + inline(m[1]) + '</blockquote>');
      continue;
    }
    if (indented && li && (m = body.match(/^[-*]\s+(.*)$/))) {
      flushPara();
      if (!li.nested) { li.parts.push('<ul class="nested">'); li.nested = true; }
      li.parts.push('<li>' + inline(m[1]) + '</li>');
      continue;
    }
    if ((m = body.match(/^[-*]\s+(.*)$/)) && !indented) {
      openList('ul'); li = { parts: [inline(m[1])], nested: false };
      continue;
    }
    if ((m = body.match(/^\d+\.\s+(.*)$/)) && !indented) {
      openList('ol'); li = { parts: [inline(m[1])], nested: false };
      continue;
    }
    if (li && !indented) closeList();
    if (li) closeNested();
    para.push(body);
  }
  if (inFence) sink().push('</code></pre>');
  block();
  return out.join('\n');
}

const docCache = {};

const docFile = name => {
  if (name === 'GUIDE') return `GUIDE.${lang}.md`;
  if (name === 'README') return 'README.md';   // only exists in English
  return lang === 'de' ? `${name}.de.md` : `${name}.md`;
};

function openDoc(name, anchor, titleKey) { openDocFile(docFile(name), anchor, titleKey); }

function openDocFile(file, anchor, titleKey) {
  const dlg = $('doc'), body = $('doc-body');
  if (!dlg || !body) return;
  const mark = (lang === 'de' && !file.includes('.de.')) ? ' ' + t('docEnglish') : '';
  $('doc-title').textContent = (t(titleKey || DOC_TITLES[file] || '') || file) + mark;
  if (typeof dlg.showModal === 'function') dlg.showModal();

  const show = html => {
    body.innerHTML = html;   // scan-ok: markdown of our own documents, rendered by mdToHtml which escapes first
    const h1 = body.querySelector('h1');
    if (h1) { $('doc-title').textContent = h1.textContent.trim() + mark; h1.remove(); }
    body.scrollTop = 0;
    if (!anchor) return;
    const target = body.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(anchor) : anchor));
    if (target) body.scrollTop = target.offsetTop - body.offsetTop;
  };

  if (docCache[file]) { show(docCache[file]); return; }
  body.innerHTML = '<p>' + escHtml(t('docLoading')) + '</p>';   // scan-ok: escaped
  fetch(file + '?v=' + BUILD)
    .then(r => { if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return r.text(); })
    .then(txt => { docCache[file] = mdToHtml(txt); show(docCache[file]); })
    .catch(e => {
      body.innerHTML = '<p>' + escHtml(t('docFail')) + '</p><pre class="err">'   // scan-ok: escaped
                     + escHtml(file + ': ' + (e && e.message ? e.message : e)) + '</pre>';
    });
}

// The footer disclaimer shows the same points as the intro warning, without a confirm button.
function openDisclaimer() {
  const dlg = $('doc'), body = $('doc-body');
  if (!dlg || !body) return;
  $('doc-title').textContent = t('footDisclaimer');
  var html = '<p>' + escHtml(t('discLede')) + '</p><ul>'
           + tList('discPoints').map(p => '<li>' + p + '</li>').join('') + '</ul>';
  body.innerHTML = html;   // scan-ok: lede escaped, list items are our own translation table, not user data
  body.scrollTop = 0;
  if (typeof dlg.showModal === 'function') dlg.showModal();
}

function wireDocViewer() {
  document.addEventListener('click', e => {
    if (!e.target.closest) return;
    const jump = e.target.closest('[data-anchor]');
    if (jump) {
      e.preventDefault();
      const body = $('doc-body');
      const target = body && body.querySelector('#' + CSS.escape(jump.getAttribute('data-anchor')));
      if (target) body.scrollTop = target.offsetTop - body.offsetTop;
      return;
    }
    const a = e.target.closest('[data-doc], [data-docfile], [data-disclaimer]');
    if (!a) return;
    e.preventDefault();
    if (a.hasAttribute('data-disclaimer')) { openDisclaimer(); return; }
    const anchor = a.getAttribute('data-doc-anchor') || '';
    const file = a.getAttribute('data-docfile');
    const titleKey = a.getAttribute('data-t') || '';
    if (file) openDocFile(file, anchor, titleKey); else openDoc(a.getAttribute('data-doc'), anchor, titleKey);
  });
  { const el = $('link-disclaimer');
    if (el) el.addEventListener('click', e => { e.preventDefault(); openDisclaimer(); }); }
  ['doc-x', 'doc-close'].forEach(id => {
    const b = $(id);
    if (b) b.addEventListener('click', () => { const d = $('doc'); if (d) d.close(); });
  });
}

// --------------------------- wiring ---------------------------

window.addEventListener('DOMContentLoaded', () => {
  log('tr-unlock build ' + BUILD);   // so a tester's log shows which deployed version they run
  initLangSwitch();
  initTheme();                       // before applyLang, so the first label is in the right language
  wireDocViewer();
  applyLang();                       // fills every data-t element, German first

  $('btn-conn').addEventListener('click', () => {
    if ($('btn-conn').dataset.act === 'disconnect') disconnectBle(); else pickAndConnect();
  });
  $('btn-toggle').addEventListener('click', () => {
    if ($('btn-toggle').dataset.action === 'unlock') unlock(); else lock();
  });
  $('btn-set-wheel').addEventListener('click', () => { const el = $('wheel-in'); const v = el ? parseFloat(el.value) : NaN; if (!isNaN(v)) setWheel(v); });
  $('btn-set-cruise').addEventListener('click', () => { const el = $('cruise-in'); if (el) setCruise(parseInt(el.value, 10) || 0); });

  // Basic speed fields: a quick "set all gears" shortcut that writes through to the per-gear grid.
  { const so = $('speed-open');
    if (so) so.addEventListener('change', () => {
      const v = parseInt(so.value, 10);
      if (!isNaN(v)) [1, 2, 3].forEach(n => { const el = $('g' + n + '-in'); if (el) el.value = String(Math.min(Math.max(v, 1), 100)); });
    }); }
  { const sl = $('speed-legal');
    if (sl) sl.addEventListener('change', () => {
      const v = parseInt(sl.value, 10);
      if (!isNaN(v)) { [1, 2, 3].forEach(n => { const el = $('g' + n + '-lock'); if (el) el.value = String(clampLock(v)); }); persistLocks(); }
    }); }

  // Per-gear lock speeds: prefill from the saved triple, remember every change.
  { const a = savedLocks();
    [1, 2, 3].forEach(n => { const el = $('g' + n + '-lock'); if (el) {
        if (a) el.value = String(a[n - 1]);
        el.addEventListener('change', persistLocks);
    } }); }

  // Error reports and battery info.
  $('btn-err').addEventListener('click', openErrorReports);
  $('btn-bat').addEventListener('click', openBatteryInfo);
  ['err-close', 'err-close-2'].forEach(id => { const el = $(id); if (el) el.addEventListener('click', () => { const d = $('err'); if (d) d.close(); }); });
  ['bat-close', 'bat-close-2'].forEach(id => { const el = $(id); if (el) el.addEventListener('click', () => { const d = $('bat'); if (d) d.close(); }); });
  ['fwwarn-close', 'fwwarn-close-2'].forEach(id => { const el = $(id); if (el) el.addEventListener('click', () => { const d = $('fwwarn'); if (d) d.close(); }); });
  $('err').addEventListener('close', stopErrorReports);
  $('bat').addEventListener('close', stopBatteryInfo);

  // Log controls + toggles.
  $('btn-copy-log').addEventListener('click', copyLog);
  $('btn-clear-log').addEventListener('click', clearLog);
  $('btn-save-log').addEventListener('click', saveLog);
  { const pl = $('public-log'); if (pl) pl.addEventListener('change', () => { publicLog = pl.checked; renderLog(); }); }
  { const dl = $('diag-log'); if (dl) dl.addEventListener('change', () => { diagLog = dl.checked; }); }

  refreshInfoButtons();      // start disabled; both views need a link that delivers frames
  if (!navigator.bluetooth) log('Web Bluetooth not available. On iOS use the Bluefy browser.', 'log-err');
  if (location.hash.replace('#', '').toLowerCase().startsWith('disclaimer')) openDisclaimer();
  parseDeepLink();                              // read ?do=lock|unlock from a home-screen shortcut
  if (pendingDeepAction) tryAutoReconnect();    // only a shortcut auto-reconnects; a normal open uses the chooser
});
