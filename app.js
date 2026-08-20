// TRBM Unlock: a Web Bluetooth tool for the Teverun Blade Mini (eKFV), derived from Laufbursche's
// trfm-unlock (Fighter Mini). Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42).
// Scope: scan, reconnect, lock/unlock, wheel diameter + cruise, and the transport for ota.js.
// The protocol (CRC-8, 0x18 settings frame, 55 71 parse) is ported 1:1 from the native lb-edition.
//
// DIFFERENCE FROM UPSTREAM: lock/unlock here does NOT use the 0x1B TESTLOCK command (which needs
// patched firmware). Instead it drives the eKFV clamp via the "cruise" (Tempomat) lever inside the
// stock 0x18 settings frame - reverse-engineered from the native Teverun app v2.0.5 (uni.UNI2202FAB),
// which serves both the Fighter Mini EKFV and the Blade Mini EKFV, so the frame format is identical.
//
// Runs in a Web Bluetooth browser: Bluefy on iOS, Chrome on Android/desktop. Safari has no BLE.

'use strict';

const BUILD = 'v102';

// --------------------------- BLE transport constants ---------------------------

// Only real scooters: the BLE name is the FIN, "TDE..." when locked, "T1..." when unlocked. The old
// broad 'T' matched any T-named device (TVs, phones), so the chooser and auto-reconnect could target
// non-scooters. These strict prefixes keep the picker (and getDevices) to actual scooters only.
const NAME_PREFIXES = ['TDE', 'T1'];

// Candidate GATT services the Teverun BLE module exposes. The ISSC (Microchip) Transparent-UART
// service is the usual one; the 0000FFxx family is the fallback. Web Bluetooth needs every service
// we touch listed here up front (optionalServices).
const ISSC_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
const ISSC_NOTIFY  = '49535343-1e4d-4bd9-ba61-23c647249616';
const ISSC_WRITE   = '49535343-aca3-481c-91ec-d85e28a60318';
// Web Bluetooth can only touch services declared up front (the one hard constraint). Cheap BLE-UART
// modules use 16-bit UUIDs in the vendor/member ranges 0xFCxx-0xFFxx (HM-10 0xFFE0, member 0xFExx,
// ISSC alternates, ...), so declare the WHOLE 0xFC00-0xFFFF range plus the known 128-bit UARTs (ISSC,
// Nordic). That covers almost every module WITHOUT knowing its exact UUID. It also makes the real service
// appear in getPrimaryServices() and the log, so a new module is identified from a log line, not by hand.
const VENDOR_16BIT = [];
for (const base of ['fc', 'fd', 'fe', 'ff'])
  for (let i = 0; i < 256; i++)
    VENDOR_16BIT.push('0000' + base + i.toString(16).padStart(2, '0') + '-0000-1000-8000-00805f9b34fb');
const NORDIC_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';   // Nordic UART: a common non-ISSC/FF BLE-UART module
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
// lock/unlock on STOCK firmware via the "cruise" (Tempomat) lever, NOT the 0x1B TESTLOCK command.
// Reverse-engineered from the native Teverun app (v2.0.5, uni.UNI2202FAB): the eKFV clamp and the
// speed scale in the ESC are flipped by the cruise mode carried in the normal 0x18 settings frame
// (cruise bits in bytes a[4] and a[17], see applyCruise/buildSettingFrame). Setting cruise != 0
// lifts the 22 km/h clamp; cruise 0 re-imposes it. No special firmware needed. The value used for
// "unlock" is the cruise "auto" mode (1); manual (2) also lifts the clamp.
const UNLOCK_CRUISE = 1;   // cruise mode written on unlock (1 = auto Tempomat, lifts the eKFV clamp)

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
// wheel + cruise into every gear WITHOUT disturbing that gear's other per-gear settings.
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
  S.systemStatus6 = (sys >> 6) & 1;   // ESC eKFV-clamp bit (1 = clamped/22, 0 = open); diagnostic mirror of cruise
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

// Wheel + cruise are GLOBAL in the firmware (a single 0x2000029D wheel byte / 0x200002D1 cruise byte),
// so ONE 0x18 write for the active gear sets them for every gear. Writing all gears was legacy (built
// when we assumed per-gear wheel); its multi-frame burst could starve the display 0x4c link long enough
// that the VCU flags the display as gone (0x20000306) and the next display frame trips the power-on
// boot-lock: a false LOCK on a settings write. One write also never touches another gear's values.
function writeWheelCruiseAllGears() {
  const cur = S.gear & 0xFF;
  enqueue(buildSettingFrame(2, cur, S.eabsLevel, S.fStartLevel, S.rStartLevel,
                            S.assistSpeedLimit, S.fCurrent, S.rCurrent));
}

// --------------------------- telemetry parse (subset of FrameParser.java) ---------------------------

const ERROR_COUNT = 17;     // 55 54 t[2..18], one severity byte per error type
const CELL_SLOTS = 24;      // 55 51 / 55 55 / 55 56 carry eight cells each

const T = {
  speed: 0, soc: 0, gear: 0, speedRaw: 0, volt: 0, frameNum: '', fin: '', lock: null,
  // Battery detail from 55 52 / 55 53 and the BMS severity array from 55 54. The have* flags say
  // whether that frame has been seen at all, so a view can show the page placeholder instead of a
  // zero the scooter never sent.
  have52: false, have53: false, current: 0, soh: 0, maxCellTemp: 0, minCellTemp: 0,
  capacity: 0, chargeCounter: 0, cellCount: 0, maxCellV: 0, minCellV: 0, balance: 0,
  cellMv: null, errors: null,
  // Controller status bytes 55 72 t[10] / t[11]: the fault bits behind the error report.
  ecu1: null, ecu2: null,
};

function u16(t, i) { return ((t[i] & 0xFF) << 8) | (t[i + 1] & 0xFF); }

// Frame reassembly: a BLE notification is not guaranteed to carry exactly one 20-byte frame (it can
// be fragmented or batched), so we buffer the bytes and pull out every 20-byte frame that starts
// with 0x55 and has a valid CRC. The old code assumed 20-byte-aligned notifications and, on a unit
// that fragments, parsed nothing at all: no telemetry, so the FIN only appeared on disconnect.
let rxBuf = new Uint8Array(0);
let diagNotify = 0;
let diagParsed = false;

// One OTA answer per notification, checked exactly the way ota.js checks it: header 0xCC plus the
// CRC-8 over the ten bytes behind it. Sharing that test means this can never accept a frame the
// engine rejects or reject one it would have accepted.
function isOtaResponse(u) {
  return u.length >= 12 && u[0] === 0xCC && crc8(u.subarray(1, 11), 10) === (u[11] & 0xFF);
}

function onNotify(value) {                       // value: DataView
  const len = value.byteLength;
  const u = new Uint8Array(len);
  for (let i = 0; i < len; i++) u[i] = value.getUint8(i);
  const otaResp = isOtaResponse(u);
  if (otaResp) confirmLink();                    // an answer from the controller proves the link
  // A running flash owns the link: the engine gets the raw notification, exactly as the native app
  // and lbtool.py hand it over. A garbled answer has to reach it too, its 100 ms nudge is the
  // recovery path for one.
  if (otaEngine) { otaEngine.onNotify(u); return; }
  // A scooter waiting in update mode streams no telemetry, it only answers on the OTA path, so an
  // OTA answer is the only link proof it can give (see the phantom-link timer in connectGatt).
  if (otaResp) return;
  if (diagNotify < 3) {                          // log the first raw notifications for diagnosis
    diagNotify++;
    let h = '';
    for (let i = 0; i < Math.min(len, 12); i++) h += u[i].toString(16).padStart(2, '0') + ' ';
    log('rx ' + len + 'B: ' + h.trim());
  }
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
// bonded device far out of range. Telemetry and OTA answers both count.
function confirmLink() {
  if (linkConfirmed) return;
  linkConfirmed = true;
  if (linkTimer) { clearTimeout(linkTimer); linkTimer = null; }
  setStatus('connected');
  maybeRunDeepAction();
}

// The unlock (per-gear speed values) was reverse-engineered on firmware 3.4.6. Other firmwares (e.g.
// 3.4.8) behave differently, so if the controller reports anything else we warn once and name the
// version. The version comes from the 55 43 frame (t[2].t[3].t[4]) parsed in dispatch().
const SUPPORTED_FW = '3.4.6';
let fwWarned = false;
function checkFwVersion() {
  if (fwWarned || !T.swVer || T.swVer === SUPPORTED_FW) return;
  fwWarned = true;
  const t348 = isFw348();
  const titleEl = $('fwwarn-title');
  if (titleEl) titleEl.textContent = t(t348 ? 'fw348Title' : 'fwWarnTitle');
  const msg = $('fwwarn-msg');
  if (msg) {
    // Build the message with safe DOM nodes (no innerHTML): the version goes into a span styled by
    // CSS (.fw-ver), the rest is plain text split around the {ver} placeholder.
    while (msg.firstChild) msg.removeChild(msg.firstChild);
    const parts = t(t348 ? 'fw348Msg' : 'fwWarnMsg').split('{ver}');
    msg.appendChild(document.createTextNode(parts[0] || ''));
    const ver = document.createElement('span');
    ver.className = 'fw-ver';
    ver.textContent = T.swVer;
    msg.appendChild(ver);
    if (parts.length > 1) msg.appendChild(document.createTextNode(parts.slice(1).join('{ver}')));
  }
  const dlg = $('fwwarn');
  if (dlg && dlg.showModal && !dlg.open) dlg.showModal();
  log('firmware ' + T.swVer + (t348 ? ' -> 3.4.8 test mode active' : ' is not the supported ' + SUPPORTED_FW));
}

function dispatch(t) {
  if (!diagParsed) { diagParsed = true; log('telemetry ok, first frame 0x' + (t[1] & 0xFF).toString(16)); }
  confirmLink();                 // first real frame proves the device is truly here -> now "connected"
  switch (t[1]) {
    case 0x71:
      updateFrom71(t);
      // On the Blade the lock state is NOT readable from telemetry: cruise (t[4]) and systemStatus6
      // (t[17] bit6) stayed identical locked vs unlocked, and the global speed limit reads 100 either
      // way. What actually differs is the per-gear speed the app writes. So we do NOT derive T.lock
      // from telemetry - it latches on the user's Entsperren/Sperren action. The live per-gear + max
      // values are shown as status so the rider sees exactly what is set.
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
      T.mCurF = u16(t, 4) * 0.1;     // Motorstrom vorn  = 0.1 * (Byte4:5)
      T.mCurR = u16(t, 12) * 0.1;    // Motorstrom hinten = 0.1 * (Byte12:13)
      T.mTempF = t[9] & 0xFF;        // Motortemp vorn (roh, 0 = nicht gemeldet)
      T.mTempR = t[17] & 0xFF;       // Motortemp hinten (roh)
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
      // A T2 pack carries the rated capacity in t[10] instead of t[8]. The name is the only source
      // for that. A device granted before the picker was narrowed can still be a T2.
      T.capacity = deviceName.startsWith('T2') ? u16(t, 10) : u16(t, 8);
      T.chargeCounter = u16(t, 12);
      T.cellCount = t[14] & 0xFF;
      T.maxCellV = u16(t, 15);
      T.minCellV = u16(t, 17);
      T.have53 = true;
      break;
    case 0x54: {
      // Severity per error type: the index is the type, the byte its level. Kept raw here, the
      // thresholds that decide what counts as active live in collectErrors.
      const errs = new Array(ERROR_COUNT);
      for (let i = 0; i < ERROR_COUNT; i++) errs[i] = t[i + 2] & 0xFF;
      T.errors = errs;
      break;
    }
    case 0x42: T.frameNum = ascii(t, 2, 18); updateFin(); break;
    case 0x43:
      // 55 43 version frame: t[2..4] = base VCU sw version (e.g. 5.4.19); t[6] = a build number some
      // patched firmwares stamp into the hwVer major byte. On stock firmware t[6] is usually 0.
      if ((t[2] & 0xFF) > 0) T.swVer = (t[2] & 0xFF) + '.' + (t[3] & 0xFF) + '.' + (t[4] & 0xFF);
      checkFwVersion();      // warn once if this is not the supported 3.4.6
      break;
    default: break;
  }
  renderLive();
}

// 55 51 / 55 55 / 55 56 each carry eight cell voltages as big-endian millivolts, no scaling.
// base is the index of the first cell in the frame.
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
  if (!navigator.bluetooth) { log('Web Bluetooth not available. Use Bluefy (iOS) or Chrome.'); return; }
  try {
    userDisconnect = false;
    log('scanning...');
    const dev = await navigator.bluetooth.requestDevice({
      filters: NAME_PREFIXES.map(p => ({ namePrefix: p })),
      optionalServices: OPTIONAL_SERVICES,
    });
    log('selected: ' + (dev.name || '') + ' [' + dev.id + ']');
    await connectGatt(dev);                      // adopts the device, see adoptDevice
  } catch (e) {
    log('scan/connect cancelled: ' + e);
  }
}

// Named handler: an anonymous one leaves a second listener behind on a re-entered connect. Two
// listeners deliver every response twice, which makes the engine count one ack as two.
function onCharacteristicValue(ev) {
  try { onNotify(ev.target.value); } catch (e) {}
}

// The listener lives on the characteristic, so it has to be released BEFORE the reference to that
// characteristic is dropped: otherwise the old one keeps delivering into this page for as long as its
// GATT link lasts. Every response would then arrive twice.
function detachNotify() {
  const nc = notifyChar;
  notifyChar = null;
  if (!nc) return;
  try { nc.removeEventListener('characteristicvaluechanged', onCharacteristicValue); } catch (e) {}
  // Not awaited: with the listener gone nothing can arrive either way. Waiting for a CCCD write on a
  // device that may already be gone would only hold up the connect.
  try { const p = nc.stopNotifications(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}

// The one place where a device becomes THE device: the old notify listener goes first, then the
// reference, so a replaced device cannot leave a live listener behind.
function adoptDevice(dev) {
  if (!dev || dev === device) return;
  detachNotify();
  // The replaced device's disconnect handler goes with it: a drop on a scooter this page no longer
  // talks to would otherwise reset the page state and end a running flash on the new one.
  try { if (device) device.removeEventListener('gattserverdisconnected', onDisconnected); } catch (e) {}
  device = dev;
  deviceName = device.name || '';
  updateFin();
  device.addEventListener('gattserverdisconnected', onDisconnected);
}

async function connectGatt(next) {
  const target = next || device;
  // Several paths can arrive here at once: a drop during an in-flight reconnect, reconnect()'s own
  // retry on top of the one onDisconnected scheduled, auto-reconnect racing a tap on Connect.
  if (connecting) { log('connect already in progress'); return; }
  // The guard has to test the device this call is about to connect to, not the one already held.
  if (connected && target && target.gatt && target.gatt.connected) { log('already connected'); return; }
  connecting = true;
  try {
    adoptDevice(target);
    setStatus('connecting');
    notifyReady = false; connected = false;
    rxBuf = new Uint8Array(0);
    diagNotify = 0; diagParsed = false;                            // fresh frame buffer + diagnostics
    server = await device.gatt.connect();
    const svc = await pickService(server);
    if (!svc) { setStatus('no-service'); log('no matching GATT service'); return; }
    await pickCharacteristics(svc);
    if (!notifyChar || !writeChar) { setStatus('no-char'); log('notify/write characteristic missing'); return; }
    await notifyChar.startNotifications();
    notifyChar.removeEventListener('characteristicvaluechanged', onCharacteristicValue);
    notifyChar.addEventListener('characteristicvaluechanged', onCharacteristicValue);
    notifyReady = true; connected = true; linkConfirmed = false;
    reconnectDelay = RECONNECT_BASE_MS;
    // The GATT link is up, but iOS reports success even for a bonded device that is far out of range
    // (a phantom link). Do NOT show "connected" yet: wait for a REAL frame (see confirmLink). The
    // keep-alive below asks the scooter to stream; if nothing arrives in time it was a phantom.
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

// Silence is not proof of a dead link: a scooter left in update mode by a half-finished flash answers
// on the OTA path only. That is the state a re-flash has to recover, so this reports the silence and
// keeps the link plus auto-reconnect intact. It never tears a usable link down.
function onLinkTimeout() {
  linkTimer = null;
  if (flashOwnsLink()) return;             // a flash owns the link and answers on its own path
  if (linkConfirmed || !connected) return;
  log('no data yet: out of range or sitting in update mode. Link kept, flashing still possible.');
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
    // Direct fetch of the same ISSC/FF set the native app matches. Works even when enumeration is empty.
    const d = await direct(COMMON_SERVICES);
    if (d) return d;
    if (attempt === 0) { log('no service yet, waiting for GATT discovery, retrying'); await sleep(1500); }
  }
  return await direct(VENDOR_16BIT);   // last resort: batched direct-fetch over the whole declared 0xFCxx-0xFFxx range
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
  if (otaEngine) otaEngine.onDisconnect();   // ends the flash and restores the UI through finished()
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
function clearWriteQueue() { writeQueue.length = 0; }

// The flasher writes on its own chain, so the normal queue has to stay off the characteristic for the
// whole flash: two GATT writes in flight on one characteristic and the browser rejects the loser.
function enqueue(frame) {
  if (flashOwnsLink()) return;
  writeQueue.push(frame);
  drain();
}
async function drain() {
  if (writing || !notifyReady || flashOwnsLink()) return;
  writing = true;
  while (writeQueue.length) {
    if (flashOwnsLink()) { clearWriteQueue(); break; }   // a flash took over between two writes
    const f = writeQueue.shift();
    try { await doWrite(f); } catch (e) { log('write error: ' + e); }
    await sleep(WRITE_GAP_MS);
  }
  writing = false;
}
// A write that is already in flight cannot be recalled, so the flash waits for it to land. Bounded:
// on a dead link the write never settles and the flash still has to be able to start. Returns false
// when the cap expired with a write still out, which the caller has to report.
async function waitWriteIdle() {
  for (let i = 0; i < 40 && writing; i++) await sleep(25);
  return !writing;
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

// --------------------------- OTA transport ---------------------------
//
// The flasher does its own timing (30 ms between packet-data frames), so its writes must NOT go
// through the 200 ms telemetry queue. They still have to be strictly serialised: two GATT writes in
// flight give "operation already in progress" and the packet is lost. One promise chain does both.

const OTA_RETRY_MS = 25;
const OTA_SETTLE_MS = 500;            // how long a frame may stay in flight before the wait is logged
const OTA_FIRST_TRIES = 40;           // 40 x 25 ms, inside the 1500 ms ota.js waits before START

let otaEngine = null;                 // non-null while a flash runs: notifications route to it
let otaChain = Promise.resolve();     // serialises OTA writes without adding a gap
let otaEpoch = 0;                     // bumped on start, cancel and finish, see otaWrite
let flashPending = false;             // set while a flash is being armed, before the engine exists
let otaFirstFrame = false;            // armed at flash start for the prepare frame, see otaWrite

// True from the moment a flash is armed until its write chain is idle again. The normal write path and
// the deep-link actions are fenced off for exactly that window.
function flashOwnsLink() { return !!otaEngine || flashPending; }

// A frame already handed to the characteristic cannot be recalled, so both the start and the end of a
// run wait here until the chain is genuinely idle: a normal write on top of an in-flight OTA frame is
// the one the browser rejects. OTA_SETTLE_MS only decides when the wait is worth a log line.
function otaChainIdle(chain) {
  const done = chain ? chain.catch(() => {}) : Promise.resolve();
  let idle = false;
  done.then(() => { idle = true; });
  sleep(OTA_SETTLE_MS).then(() => { if (!idle) log('an OTA frame is still in flight, waiting for it'); });
  return done;
}

// Reassigning otaChain does not unqueue the writes already chained onto the old one: they still reach
// the characteristic. Each write carries the epoch it was queued in then drops out once that run is
// over, so no frame from a cancelled run can enter the next one.
function otaWrite(frame) {
  const epoch = otaEpoch;
  // The prepare/erase frame goes out ONCE and no retry path re-sends it, so the first frame of a run
  // retries until the characteristic takes it: a browser rejection would otherwise cost the whole run.
  // Every later frame has the engine's own resend behind it, so one quick retry is enough there.
  const tries = otaFirstFrame ? OTA_FIRST_TRIES : 2;
  otaFirstFrame = false;
  otaChain = otaChain.then(async () => {
    for (let i = 0; i < tries; i++) {
      if (epoch !== otaEpoch) return;
      try { await otaWriteOnce(frame); return; } catch (e) { if (i + 1 >= tries) throw e; }
      await sleep(OTA_RETRY_MS);
    }
  }).catch(e => { log('ota write dropped: ' + e); });   // keep the chain alive for the next frame
}

// Opposite preference to doWrite: without-response has no per-frame acknowledgement round trip, which
// is what keeps the packet stream inside the controller's receive window.
async function otaWriteOnce(frame) {
  const wc = writeChar;
  if (!wc) throw new Error('no write characteristic');
  if (wc.properties.writeWithoutResponse && wc.writeValueWithoutResponse) return wc.writeValueWithoutResponse(frame);
  if (wc.writeValueWithResponse) return wc.writeValueWithResponse(frame);
  return wc.writeValue(frame);
}

// --------------------------- lock / unlock + wheel / cruise ---------------------------
//
// Wheel diameter + cruise are the ONLY user prefs we persist (localStorage). The scooter keeps
// neither: on lock the wheel is forced to 10 (eKFV), so the app is the sole place the real value
// survives. On unlock, after the rename-reconnect brings a fresh 55 71, we re-apply both.

const LS_WHEEL = 'trbm_wheel', LS_CRUISE = 'trbm_cruise', LS_DEVICE = 'trbm_device';
let pendingRestore = false;     // set on unlock; consumed by the first 55 71 after the reconnect
let restoreArmed = false;       // set once the rename-drop actually happened

function savedWheel() { const v = parseFloat(localStorage.getItem(LS_WHEEL)); return isNaN(v) ? null : v; }
function savedCruise() { const v = parseInt(localStorage.getItem(LS_CRUISE), 10); return isNaN(v) ? null : v; }

function persistWheel(v) { localStorage.setItem(LS_WHEEL, String(v)); }
function persistCruise(v) { localStorage.setItem(LS_CRUISE, String(v)); }

// User sets the wheel diameter (open mode). Save it, then write the full 0x18 with the new wheel.
function setWheel(v) {
  if (!requireReady() || !requireUnlocked('wheel size')) return;
  S.wheel = v;
  persistWheel(v);
  writeWheelCruiseAllGears();
  log('wheel set to ' + v + ' (saved)');
}

// User sets cruise directly: 0 off (locked/22), 1 auto, 2 manual (both lift the eKFV clamp). This is
// the same lever as lock/unlock, just with the mode choice exposed, so it stays settable while locked
// (it IS how you unlock). Save it, then write the full 0x18.
function setCruise(v) {
  if (!requireReady()) return;
  S.cruise = v;
  persistCruise(v);
  writeWheelCruiseAllGears();
  T.lock = (v === 0) ? 'locked' : 'unlocked';   // optimistic; streamed 55 71 cruise confirms
  refreshToggle();
  log('cruise set to ' + v + ' (saved)');
}

// Lock/unlock on the Blade (ESC + MCU, NO IVCU): the eKFV limit is not a firmware clamp, it is just
// the speed values the app writes. So unlock = write a HIGH per-gear speed + max speed on every gear,
// lock = write the low eKFV values. The MCU applies whatever it is told. This mirrors what the pimped
// stock app does (it only removes the UI gate so the app sends high values). Cruise / systemStatus6
// are NOT the lever on the Blade (both stayed identical locked vs unlocked in the captures).

function readNum(id, dflt) {
  const el = $(id);
  const v = el ? parseInt(el.value, 10) : NaN;
  return (isNaN(v) || v < 0) ? dflt : Math.min(v, 100);
}

// Start level (Anfahrts-Level) test field: the value is the low nibble of a[8]/a[9], so 0..15 fit on
// the wire. The native app caps the UI at 5; here it goes to 15 to test whether the firmware accepts
// more. Empty field returns null -> the mirrored (unchanged) level is written.
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
// else (eabs/start levels, currents, global max via S.speedLimit) is mirrored from the last 55 71.
// vals[i] is the speed for DE_GEARS[i]. Confirmed lever from the captures: Byte10 = 22 locked, 60 open.
function isFw348() { return typeof T.swVer === 'string' && T.swVer.indexOf('3.4.8') === 0; }

function writeGearSpeeds(vals, forceCruise) {
  // vals = [g1, g2, g3] = the three entered speeds (rider gears 1/2/3 = internal ESC 2/3/4).
  // 3.4.8 test mode: the 3.4.6-style write to gears 2/3/4 did nothing on 3.4.8, and a 3.4.8 blade
  // was seen running gears 2 and 3 with very low per-gear bytes. So on 3.4.8 we write ALL FIVE
  // internal gears, mapping the three fields across them, to cover whatever gear the blade uses.
  const t348 = isFw348();
  // plan: [internalGear, speed, riderFieldNumber(0 = no dedicated level field)]
  const plan = t348
    ? [[1, vals[0], 1], [2, vals[0], 1], [3, vals[1], 2], [4, vals[2], 3], [5, vals[2], 3]]
    : [[2, vals[0], 1], [3, vals[1], 2], [4, vals[2], 3]];
  const notes = [];
  const curDefaults = [20, 25, 30];
  // 3.4.8-Test: der per-Gang-Speed allein wird vom harten Klemm-Cap ueberschrieben. Die
  // urspruengliche Erkenntnis war, dass der Tempomat (cruise=2) im ESC die Klemme kippt. Also
  // beim Entsperren auf 3.4.8 cruise=2 in a[4]/a[17] mitschreiben. Beim Sperren nicht.
  const prevCruise = S.cruise;
  const clampTest = t348 && forceCruise;
  if (clampTest) { S.cruise = 2; log('3.4.8 Klemm-Test: cruise=2 (Tempomat) wird mitgeschrieben, a[4] Bit2.'); }
  for (const [g, spd, rider] of plan) {
    const c = gearCache[g] || {};
    const eabsIn = rider ? readLevel('g' + rider + '-eabs') : null;   // null (empty) = default 2
    const eabs = (eabsIn != null) ? eabsIn : 2;
    const fsIn = rider ? readLevel('g' + rider + '-fs') : null;       // null (empty) = default 5
    const rsIn = rider ? readLevel('g' + rider + '-rs') : null;
    const fs = (fsIn != null) ? fsIn : 5;
    const rs = (rsIn != null) ? rsIn : 5;
    const cur = rider ? readNum('g' + rider + '-cur', curDefaults[rider - 1] || 25) : 25;
    enqueue(buildSettingFrame(2, g, eabs, fs, rs, spd & 0xFF, cur, cur));
    if (fsIn != null || rsIn != null || eabsIn != null) notes.push('Gang ' + rider + ' Anfahrt v=' + fs + ' h=' + rs + ' eABS=' + eabs + ' Strom=' + cur);
  }
  if (clampTest) S.cruise = prevCruise;
  if (t348) log('3.4.8-Testmodus aktiv: alle Gaenge 1-5 geschrieben (' + vals.join('/') + ').');
  if (notes.length) log('Anfahrts-Level Test: ' + notes.join(' | '));
}

function unlock() {
  if (!requireReady()) return;
  const v = [readNum('g1-in', 45), readNum('g2-in', 60), readNum('g3-in', 80)];
  writeGearSpeeds(v, true);
  T.lock = 'unlocked';
  log('entsperrt: Gang 1/2/3 (ESC 2/3/4) = ' + v.join(' / '));
  refreshToggle();
}

function lock() {
  if (!requireReady()) return;
  writeGearSpeeds([22, 22, 22], false);
  T.lock = 'locked';
  log('gesperrt: alle DE-Gänge = 22');
  refreshToggle();
}

// Called on every 55 71. When a restore is armed (unlock happened, link dropped and came back),
// re-apply the saved wheel + cruise once, exactly like the native maybeRestoreFinSettings.
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

function requireReady() {
  if (!connected) { log('connect first'); return false; }
  if (!S.received71) { log('waiting for telemetry (55 71) before writing settings'); return false; }
  return true;
}

// Wheel size and cruise are only settable on an UNLOCKED scooter: the firmware discards the write
// otherwise. The inputs are already disabled while locked; this is the second guard so a deep-link,
// a stale page or a console call cannot push a write the controller would silently drop.
function requireUnlocked(what) {
  if (T.lock === 'locked') { log('unlock the scooter first to change the ' + what); return false; }
  return true;
}

// --------------------------- firmware flasher (ota.js) ---------------------------
//
// This page ships no firmware: the user supplies the file, ota.js checks it and runs the flash.

let fwText = null;      // the text of the accepted file, kept until the flash starts
let fwCheck = null;     // the window.OTA.checkImage result for it
// The file the open dialog describes and the flash then runs, captured when the dialog opens. The
// picker stays disabled from that moment, so what the user confirms is what goes on the wire.
let flashChk = null;
let flashArmed = false; // the confirmation dialog is open and waiting for an answer

// Controls that must not fire while a flash runs: an extra frame or a disconnect breaks the stream.
const FLASH_LOCK_IDS = ['btn-conn', 'btn-toggle', 'wheel-in', 'btn-set-wheel', 'cruise-in', 'btn-set-cruise',
                        'btn-err', 'btn-bat'];

// Blob.text() is missing on older WebKit, where Bluefy still has to work.
function readFileText(file) {
  if (file.text) return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsText(file);
  });
}

// The verdict is kept, not just drawn: a language switch has to redraw the same result.
let fwVerdict = null;   // { key, ok, chk } for an accepted file, { key, ok, name, err } for a refused one

function showFwVerdict(v) { fwVerdict = v; renderFwVerdict(); }

// Built as DOM nodes, not markup: the headline and the detail carry a user-supplied file name.
function renderFwVerdict() {
  const host = $('fw-check');
  if (!host || !fwVerdict) return;
  const v = fwVerdict;
  const detail = v.chk
    ? (v.chk.name + '  ' + t('fwVersion') + ' ' + (v.chk.version || '?') + '  '
       + v.chk.bytes + ' ' + t('fwBytes') + '  ' + v.chk.packets + ' ' + t('fwPackets')
       + '  CRC ' + v.chk.calcCrc)
    : (v.name + ': ' + v.err);
  host.textContent = '';
  const box = document.createElement('div');
  box.className = v.ok ? 'verdict' : 'verdict bad';
  const b = document.createElement('b');
  b.textContent = t(v.key);
  const d = document.createElement('span');
  d.className = 'detail';
  d.textContent = detail;
  box.appendChild(b);
  box.appendChild(d);
  host.appendChild(box);
}

async function onFwFile(file) {
  if (!file) return;
  fwText = null; fwCheck = null;
  refreshFlashButtons();
  let text;
  try {
    text = await readFileText(file);
  } catch (e) {
    showFwVerdict({ ok: false, key: 'fwReadFail', name: file.name, err: String(e) });
    return;
  }
  try {
    const chk = window.OTA.checkImage(text, file.name);
    fwText = text; fwCheck = chk;
    showFwVerdict({ ok: true, key: chk.isVcu ? 'fwOkVcu' : 'fwOkBms', chk: chk });
    log('firmware file ready: ' + chk.name + ' v' + chk.version + ' ' + chk.bytes + ' bytes CRC ' + chk.calcCrc);
  } catch (e) {
    const why = (e && e.message) ? e.message : String(e);
    showFwVerdict({ ok: false, key: 'fwBad', name: file.name, err: why });
    log('firmware file rejected: ' + why);
  }
  refreshFlashButtons();
}

// Choose file needs a link, Flash needs a checked file as well. While a flash runs the Flash button
// is the only way out, so it turns into Cancel.
function refreshFlashButtons() {
  const pick = $('btn-pick'), flash = $('btn-flash'), file = $('fw-file');
  // The open confirmation counts as busy: picking a second file must not change what is flashed.
  const busy = flashOwnsLink() || flashArmed;
  if (pick) pick.disabled = !connected || busy;
  if (file) file.disabled = busy;
  if (!flash) return;
  if (otaEngine) {
    flash.textContent = t('btnCancel');
    flash.dataset.act = 'cancel';
    flash.disabled = false;
    return;
  }
  flash.textContent = t('btnFlash');
  flash.dataset.act = 'flash';
  flash.disabled = !connected || !fwText;
}

function setControlsForFlash(flashing) {
  FLASH_LOCK_IDS.forEach(id => { const el = $(id); if (el) el.disabled = flashing; });
  if (!flashing) { refreshToggle(); refreshSettingsInputs(); refreshInfoButtons(); }
}

// Both the progress line and the result line are kept as values, so a language switch
// mid-flash redraws them instead of leaving the old language on screen.
let fwProgress = null;   // { percent, packet, count, phase }
let fwResult = null;     // { success, message, phase }

function setFwProgress(percent, packet, count, phase) {
  fwProgress = { percent: percent, packet: packet, count: count, phase: phase };
  fwResult = null;
  renderFwProgress();
}

function renderFwProgress() {
  if (!fwProgress) return;
  const p = fwProgress;
  const prog = $('fw-progress');
  if (prog) prog.hidden = false;
  const bar = $('fw-bar');
  if (bar) bar.style.width = Math.max(0, Math.min(100, p.percent)) + '%';
  const ph = $('fw-phase');
  if (ph) {
    ph.textContent = p.count
      ? fmt(t('progPacket'), { n: p.packet, m: p.count, phase: tPhase(p.phase) })
      : tPhase(p.phase);
  }
}

function renderFwResult() {
  const ph = $('fw-phase');
  if (!ph || !fwResult) return;
  ph.textContent = fwResult.success
    ? t('fwDone')
    : fmt(t('fwStopped'), { phase: tPhase(fwResult.phase), msg: tMessage(fwResult.message) });
}

// The dialog names the file it is about to flash. Text, not markup: the name comes from the user.
function renderDlgFile() {
  const el = $('dlg-file');
  if (!el) return;
  el.textContent = flashChk
    ? fmt(t('dlgFile'), { name: flashChk.name, version: flashChk.version || '?',
                          bytes: flashChk.bytes, packets: flashChk.packets })
    : '';
}

// The confirm button stays dead until the rider says they read the disclaimer.
function syncFlashConsent() {
  const consent = $('dlg-consent'), ok = $('btn-warn-ok');
  if (ok) ok.disabled = !(consent && consent.checked);
}

function askFlash() {
  if (!connected || !fwCheck || flashOwnsLink() || flashArmed) return;
  const dlg = $('flash-warn');
  if (!dlg || !dlg.showModal) { log('this browser cannot show the confirmation, flashing not started'); return; }
  // The file is captured HERE and the picker is disabled until the dialog is answered, so the file the
  // dialog describes is the one startFlash hands to the engine.
  flashChk = fwCheck;
  flashArmed = true;
  renderDlgFile();
  // Asked fresh every time: the tick from the previous dialog never carries over.
  const consent = $('dlg-consent');
  if (consent) consent.checked = false;
  syncFlashConsent();
  refreshFlashButtons();
  // Stopped here, not at flash start: a connect-code frame enqueued while the dialog is open could
  // still be in flight when the first OTA frame goes out. Restarted from the dialog's close event.
  stopKeepAlive();
  dlg.showModal();
}

async function startFlash() {
  if (!connected || !flashChk || flashOwnsLink()) return;
  flashPending = true;                                 // fence the normal write path before anything else
  try {
    stopKeepAlive();
    clearWriteQueue();      // a connect-code frame inside the packet stream breaks the flash
    if (linkTimer) { clearTimeout(linkTimer); linkTimer = null; }   // no telemetry comes during a flash
    otaEpoch++;             // nothing queued before this moment may reach the characteristic
    const settling = otaChain;
    otaChain = Promise.resolve();
    const idle = await waitWriteIdle();
    await otaChainIdle(settling);     // a frame of the previous run may still be in flight
    // As the native app: the flag is dropped so a write whose promise never settles cannot keep the
    // normal queue blocked for the rest of the session.
    writing = false;
    if (!idle) log('a normal write is still in flight, the update request goes out with retries');
    if (!connected) { log('link lost before the flash started'); flashPending = false; refreshFlashButtons(); return; }
    setControlsForFlash(true);
    setFwProgress(0, 0, 0, 'preparing');
    const engine = new window.OTA.OtaEngine(flashChk, {
      write: otaWrite,
      log: log,
      progress: p => setFwProgress(p.percent, p.packet, p.count, p.phase),
      finished: onFlashFinished,
    });
    otaEngine = engine;     // set before start(): the first response must already route to the engine
    refreshFlashButtons();
    log('flashing ' + flashChk.name + ', keep the scooter on and stay in range');
    otaFirstFrame = true;   // the engine's first write is the prepare frame, which may not be lost
    engine.start();
  } catch (e) {
    flashPending = false;
    log('flash could not start: ' + e);
    setControlsForFlash(false);
    refreshFlashButtons();
  }
}

function onFlashFinished(success, message, phase) {
  otaEngine = null;                   // the engine is done; the fence stays up until its chain is idle
  otaEpoch++;                         // frames still queued from this run must not reach the next one
  const settling = otaChain;
  otaChain = Promise.resolve();
  rxBuf = new Uint8Array(0);          // drop OTA bytes so telemetry parsing resyncs cleanly
  if (success) {
    setFwProgress(100, flashChk ? flashChk.packets : 0, flashChk ? flashChk.packets : 0, 'done');
    log('flash finished: ' + message + '. Switch the scooter off and on again to run the new firmware.');
  } else {
    log('flash stopped in ' + phase + ': ' + message
      + '. The scooter stays in update mode until a flash completes, so flash again before riding.');
  }
  // The log keeps the wording ota.js produced (English, the way the guide quotes it);
  // the line under the bar is the translated one.
  fwResult = { success: success, message: message, phase: phase };
  renderFwResult();
  // The controls and the keep-alive come back only once the chain is idle: a tap or a settings restore
  // would otherwise put a normal frame on the wire while the last OTA frame is still in flight.
  otaChainIdle(settling).then(() => {
    flashPending = false;
    setControlsForFlash(false);
    refreshFlashButtons();
    if (connected && notifyReady && !flashOwnsLink()) startKeepAlive();
  });
}

// --------------------------- shortcut deep-link + auto-reconnect ---------------------------
//
// A home-screen shortcut (iOS Shortcuts / Android home-screen icon) opens the page with ?do=lock or
// ?do=unlock. On load we reconnect to the last granted scooter via getDevices(): no chooser, works
// in Bluefy (iOS) and Chrome. Then the action runs once connected. getDevices()/auto-connect need no
// fresh picker, but the scooter must be on and in range; otherwise the user just taps Connect.

let pendingDeepAction = null;     // 'lock' | 'unlock' parsed from the URL, run once after connect

function parseDeepLink() {
  try {
    let a = (new URLSearchParams(location.search).get('do') || '').toLowerCase();
    if (!a && location.hash) a = (new URLSearchParams(location.hash.replace(/^#/, '')).get('do') || '').toLowerCase();
    if (a === 'lock' || a === 'unlock') { pendingDeepAction = a; log('shortcut: ' + a + ' requested'); }
  } catch (e) {}
}

function maybeRunDeepAction() {
  // A flash owns the link, so the shortcut waits: it runs on the first telemetry frame afterwards.
  if (!pendingDeepAction || !connected || flashOwnsLink()) return;
  if (pendingDeepAction === 'unlock') {
    if (!S.received71) return;               // unlock writes a full 0x18, needs a 55 71 first
    pendingDeepAction = null;
    log('shortcut: auto-unlock');
    unlock();
  } else if (pendingDeepAction === 'lock') {
    if (!S.received71) return;               // lock needs a 55 71 first
    pendingDeepAction = null;
    log('shortcut: auto-lock');
    lock();
  }
}

// Reconnect to a previously paired scooter without showing the chooser (Web Bluetooth getDevices()).
// A first-time visitor has nothing granted yet, so nothing happens and the user taps Connect.
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
    log('auto-reconnect: ' + (dev.name || dev.id));
    await connectGatt(dev);                      // adopts the device, see adoptDevice
  } catch (e) {
    setStatus('disconnected');
    log('auto-reconnect skipped: ' + e);
  }
}

// --------------------------- UI ---------------------------

function $(id) { return document.getElementById(id); }
function setStatus(s) {
  const el = $('status'); if (el) { el.textContent = s; el.dataset.state = s; }
  // Single Connect/Disconnect control: reads "Disconnect" while connected or connecting, "Connect" otherwise.
  const cb = $('btn-conn');
  if (cb) {
    // "no-data" keeps the GATT link, so the control has to offer Disconnect there as well.
    const on = (s === 'connecting' || s === 'linking' || s === 'connected' || s === 'no-data');
    cb.textContent = on ? t('btnDisconnect') : t('btnConnect');
    cb.dataset.act = on ? 'disconnect' : 'connect';
  }
  refreshFlashButtons();   // both flasher buttons need a link and every state change decides that
  refreshInfoButtons();    // the two info views need one as well
}
function log(m) {
  const el = $('log'); if (!el) return;
  el.textContent = ('[' + new Date().toLocaleTimeString() + '] ' + m + '\n') + el.textContent;
}
// The single lock/unlock control reflects the current state: "Unlock" when the scooter is locked,
// "Lock" when it is open. The state is driven ONLY by the real IVCU value streamed in 55 71 t[2]
// (T.lock). It is NEVER inferred from the FIN / BLE name: the FIN does not reflect the real lock and
// lying about it is worse than admitting we do not know yet. Until a real 55 71 sets T.lock the state
// is shown as unknown ("reading...") and the button is disabled.
function refreshToggle() {
  const btn = $('btn-toggle');
  if (!btn) return;
  if (otaEngine) { btn.disabled = true; return; }   // a flash owns the link, no lock frames meanwhile
  // The Blade gives no readable lock state, so the button is NOT gated on one: it is actionable as
  // soon as a 55 71 arrived (a per-gear write needs the mirrored state). The label follows the
  // user-latched T.lock; unknown defaults to "unlock" (a fresh eKFV Blade is the locked one).
  const locked = (T.lock !== 'unlocked');
  btn.textContent = locked ? t('btnUnlock') : t('btnLock');
  btn.dataset.action = locked ? 'unlock' : 'lock';
  btn.disabled = !(connected && S.received71);
}
function renderLive() {
  if ($('t-swver')) $('t-swver').textContent = T.swVer ? ('R' + T.swVer) : '-';
  refreshSettingsInputs();
  refreshToggle();
  refreshInfoButtons();
}
function resetTiles() {                                 // no telemetry -> show "-"
  // Drop cached telemetry so a reconnect can NEVER show a pre-reboot lock state. Without this, T.lock
  // keeps its last value and refreshToggle shows it until a fresh 55 71 arrives. Cleared to null,
  // refreshToggle shows "reading..." (unknown) until the next real 55 71 gives the true state.
  T.lock = null;
  // Battery and fault data belongs to the link that streamed it: after a drop the two info views
  // show the placeholder again until the new link delivers its own frames.
  T.have52 = false; T.have53 = false; T.cellMv = null; T.errors = null; T.ecu1 = null; T.ecu2 = null;
  S.received71 = false;
  T.swVer = null; fwWarned = false;   // a reconnect re-reads the version and may warn again
  if ($('t-swver')) $('t-swver').textContent = '-';
  refreshToggle();
}
// Wheel + cruise: editable only once the scooter reported its config (55 71). Prefilled ONCE with
// the value the scooter delivers; after that the user edits freely (no per-frame overwrite).
let settingsPrefilled = false;
function refreshSettingsInputs() {
  if (otaEngine) return;     // a running flash keeps these disabled until it reports finished
  const ready = connected && S.received71;
  const win = $('wheel-in'), cin = $('cruise-in'), bw = $('btn-set-wheel'), bc = $('btn-set-cruise');
  // Wheel size may only be changed while UNLOCKED (a locked, road-legal scooter keeps an honest
  // speedometer). Cruise, however, IS the unlock lever on stock firmware, so it stays settable while
  // locked - that dropdown is how the clamp is lifted. Both need a 55 71 first.
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
// Two read-only views of what the scooter streams by itself. Nothing is sent for either of them:
// 55 54 carries the BMS severity array, 55 72 t[10]/t[11] the controller fault bits, 55 52 / 55 53
// the pack summary and 55 51 / 55 55 / 55 56 the per-cell voltages.

// Our wording per BMS error index. Index 16 is deliberately absent: the pack reports it as a status
// flag rather than a fault, so it is filtered out below.
const ERROR_NAMES = [
  'errDischargeOverTemp', 'errDischargeUnderTemp', 'errChargeOverTemp', 'errChargeUnderTemp',
  'errCellOverVolt', 'errCellUnderVolt', 'errPackOverVolt', 'errPackUnderVolt',
  'errDischargeOverCurrent', 'errChargeOverCurrent', 'errCellVoltSpread', 'errCellTempSpread',
  'errChargeLevelLow', 'errMosfet1Temp', 'errMosfet2Temp', 'errChargingState'
];
const ERROR_PACK_FLAG = 16;      // the one index in the array that is a status flag, not a fault
const INFO_REFRESH_MS = 1000;    // how often an open view redraws from the live frames
// A cell reads full above 3400 mV and low below 2650 mV; in between it is simply working.
const CELL_FULL_MV = 3400, CELL_LOW_MV = 2650;

function ecuBit(byte, bit) { return byte != null && ((byte >> bit) & 1) === 1; }

// Active faults only. Over-temperature while discharging or charging counts from level 2, every
// other type from level 3, which is what keeps a resting low charge level out of the list.
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

// A translated one-liner in place of a list, for the states where there is nothing to show yet. The
// data-t attribute keeps it in step with the language switch.
function infoNote(key) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.setAttribute('data-t', key);
  p.textContent = t(key);
  return p;
}

// The same note for the cell grid: a child of a grid container is a grid item, so without the
// page's full-width utility it would sit in one 5.5rem column.
function gridNote(key) {
  const p = infoNote(key);
  p.classList.add('span2');
  return p;
}

// One verdict box per finding: the flasher's box already carries a severity colour on its left edge.
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
  // A clean bill of health may only be given once BOTH sources have reported: 55 54 for the battery
  // and 55 72 for the controller. Until then the honest answer is that nothing is known yet.
  const complete = Array.isArray(T.errors) && T.ecu1 !== null;
  host.appendChild(infoNote(complete ? 'errEmpty' : 'infoWaiting'));
}

// Label plus value, the pair the live card on the page already uses for its firmware rows.
function batRow(key, value) {
  const row = document.createElement('div');
  row.className = 'led-row-inline kv';   // the row shape is the page's, only the value type is new
  const label = document.createElement('label');
  label.setAttribute('data-t', key);
  label.textContent = t(key);
  const val = document.createElement('b');
  val.textContent = value;
  row.appendChild(label);
  row.appendChild(val);
  return row;
}

// Every number the pack reports, in the order the app lists them. A frame that has not arrived
// leaves its rows on the page placeholder rather than on a zero.
function batteryRows() {
  const dash = '-';
  const notSent = t('batNotSent');
  const v53 = (val, unit) => T.have53 ? (val + ' ' + unit) : dash;
  const cellV = mv => T.have53 ? ((mv / 1000).toFixed(3) + ' V') : dash;
  // Der Blade fuellt die Smart-BMS-Felder im 0x52 nicht: leer ergibt 0V / -1000A / -40 Grad.
  // Solche Sentinel-Werte als "nicht gesendet" ausweisen statt als Falschzahl. Bei echten
  // (T2-)Packs liegen die Werte ausserhalb der Sentinels und werden normal angezeigt.
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
// bitfield covers the first eight cells only, which is all the frame carries.
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
    if (mv <= 0) continue;     // a slot the pack has not reported is left out, not drawn as 0.000 V
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
  // The health box is the battery half of the error report, so the two views can never disagree
  // about what counts as active.
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

// Both views need a link that is proven to deliver frames. During a flash no telemetry arrives at
// all, so the buttons follow the same rule as the other scooter controls.
function refreshInfoButtons() {
  const ready = connected && linkConfirmed && !flashOwnsLink();
  ['btn-err', 'btn-bat'].forEach(id => { const b = $(id); if (b) b.disabled = !ready; });
}

// While a view is open it redraws from the live frames; closing it stops that again.
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
// Every visible string comes from i18n.js: elements carry data-t="key", the run-time
// strings are looked up with t(). German is the default, never browser-detected, so the
// page reads the same on every device until the reader picks EN.

let lang = 'de';

function table() { return (window.I18N && window.I18N[lang]) || {}; }
function t(key) { const v = table()[key]; return (typeof v === 'string') ? v : ''; }
function tList(key) { const v = table()[key]; return Array.isArray(v) ? v : []; }
function fmt(s, vars) { return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)); }
function cruiseName(v) { return [t('cruiseOff'), t('cruiseAuto'), t('cruiseManual')][v]; }

// Flasher phase names come from ota.js, so an unknown one falls back to its raw name.
function tPhase(p) { return (table().phase || {})[p] || String(p); }

// Result messages come from ota.js too. The two carrying packet numbers are matched by
// pattern; anything unmapped is shown as the engine worded it.
function tMessage(m) {
  const msg = table().msg || {};
  if (msg[m]) return msg[m];
  let hit = /^packet (\d+)\/(\d+) failed repeatedly$/.exec(m);
  if (hit && msg.packetFailed) return fmt(msg.packetFailed, { n: hit[1], m: hit[2] });
  hit = /^packet (\d+)\/(\d+) got no response\./.exec(m);
  if (hit && msg.packetNoAnswer) return fmt(msg.packetNoAnswer, { n: hit[1], m: hit[2] });
  return String(m);
}

function renderList(hostId, key) {
  const host = $(hostId);
  if (!host) return;
  host.textContent = '';
  tList(key).forEach(item => {
    const li = document.createElement('li');
    li.innerHTML = item;   // scan-ok: our own translation table, the only markup is <b>
    host.appendChild(li);
  });
}

function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach(n => {
    const v = t(n.getAttribute('data-t'));
    // Only strings with emphasis, a link or an escaped character go in as markup.
    if (/[<&]/.test(v)) n.innerHTML = v; else n.textContent = v;   // scan-ok: our own translation table
  });
  renderList('dlg-list', 'dlgPoints');
  { const el = $('wheel-in'); if (el) el.placeholder = t('phWheel'); }
  // href is only the fallback for opening in a new tab; the click opens the viewer.
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
  // Everything drawn from state has to be redrawn in the new language.
  renderFwVerdict();
  renderDlgFile();
  if (fwResult) renderFwResult(); else renderFwProgress();
  { const el = $('status'); setStatus(el ? el.dataset.state : 'disconnected'); }
  renderLive();
}

// --------------------------- theme ---------------------------
// Dark is the default. The choice is remembered. The icon shows what a tap would DO: a sun
// while the page is dark, a moon while it is light.

const LS_THEME = 'tru_theme';

function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const b = $('btn-theme');
  if (b) {
    b.innerHTML = dark ? '&#9728;' : '&#9790;';   // scan-ok: a fixed character, not user input
    b.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark'));
    b.title = b.getAttribute('aria-label');
  }
  // Guarded like every other stored preference here: a browser in private mode throws on write.
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
// The guide, the disclaimer, the licence, the privacy notice and the trademarks
// are files of this site. They open here, so a reader is never handed a raw
// markdown file or sent off to a code host.

const DOC_TITLES = {
  'GUIDE.de.md': 'footGuide', 'GUIDE.en.md': 'footGuide',
  'PRIVACY.de.md': 'footPrivacy', 'PRIVACY.md': 'footPrivacy',
  'LICENSE.de.md': 'footLicense', 'LICENSE.md': 'footLicense',
  'TRADEMARKS.de.md': 'footTrademarks', 'TRADEMARKS.md': 'footTrademarks',
  'README.md': 'footReadme',
};

const DISCLAIMER_HREF = 'README.md#disclaimer';

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// GitHub's heading slugs, so an anchor written inside a document keeps working here.
// One space becomes one dash, runs are NOT collapsed: a code host drops the punctuation
// first, so "Disclaimer & Trademarks" ends up with two dashes and an anchor written for
// that host has to find the same id here.
const slug = s => s.toLowerCase().trim()
  .replace(/[^\w\sÀ-ɏ-]/g, '')
  .replace(/ /g, '-');

// Only the markdown these documents use: headings, lists with one level of
// nesting, tables, fenced code, quotes, rules, bold, inline code and links.
// Indented content stays inside its list item, so the numbering of the steps
// after it keeps counting.
function mdToHtml(src) {
  const inline = s => escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, text, href) => {
      // The disclaimer link reads well on a code host and opens our own terms here.
      if (href === DISCLAIMER_HREF) return `<a href="${href}" data-disclaimer>${text}</a>`;
      if (DOC_TITLES[href]) return `<a href="${href}" data-docfile="${href}">${text}</a>`;
      // An anchor belongs to the document being read, so it scrolls instead of opening a
      // tab on an address that answers to nothing.
      if (href.startsWith('#')) return `<a href="${href}" data-anchor="${href.slice(1)}">${text}</a>`;
      return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
    });

  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let listKind = null;   // the open top-level list, 'ul' or 'ol'
  let li = null;         // { parts: [], nested: bool } of the open list item
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
    // A blank line inside a list item only ends its paragraph: the item goes on
    // as long as the next line is indented.
    if (body === '') {
      if (li && /^ {2,}\S/.test(lines[i + 1] || '')) flushPara(); else block();
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(body)) { block(); out.push('<hr>'); continue; }

    // A header row followed by a divider row starts a table.
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
    // An indented bullet is a sub-list of the open item.
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
    // Indented prose belongs to the open item; anything else is a new paragraph.
    if (li && !indented) closeList();
    if (li) closeNested();
    para.push(body);
  }
  if (inFence) sink().push('</code></pre>');
  block();
  return out.join('\n');
}

const docCache = {};

// Every document exists in German as well. English keeps the plain name, because
// LICENSE.md is the file GitHub reads and the binding wording of the licence.
const docFile = name => {
  if (name === 'GUIDE') return `GUIDE.${lang}.md`;
  if (name === 'README') return 'README.md';   // only exists in English
  return lang === 'de' ? `${name}.de.md` : `${name}.md`;
};

function openDoc(name, anchor, titleKey) { openDocFile(docFile(name), anchor, titleKey); }

function openDocFile(file, anchor, titleKey) {
  const dlg = $('doc'), body = $('doc-body');
  if (!dlg || !body) return;
  // A document in the other language is labelled as such, so nobody wonders why
  // the licence suddenly reads English.
  const mark = (lang === 'de' && !file.includes('.de.')) ? ' ' + t('docEnglish') : '';
  // The link label carries the loading state; the document's own heading takes over
  // as soon as it is rendered.
  $('doc-title').textContent = (t(titleKey || DOC_TITLES[file] || '') || file) + mark;
  if (typeof dlg.showModal === 'function') dlg.showModal();

  const show = html => {
    body.innerHTML = html;   // scan-ok: markdown of our own documents, rendered by mdToHtml which escapes first
    // The heading becomes the window title instead of standing twice on screen.
    const h1 = body.querySelector('h1');
    if (h1) { $('doc-title').textContent = h1.textContent.trim() + mark; h1.remove(); }
    body.scrollTop = 0;
    if (!anchor) return;
    const target = body.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(anchor) : anchor));
    if (target) body.scrollTop = target.offsetTop - body.offsetTop;
  };

  if (docCache[file]) { show(docCache[file]); return; }
  body.innerHTML = '<p>' + escHtml(t('docLoading')) + '</p>';   // scan-ok: escaped
  // Same marker the script tags carry: without it a document stays in the browser cache
  // across builds and a reader keeps seeing the text from the first time they opened it.
  fetch(file + '?v=' + BUILD)
    .then(r => { if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return r.text(); })
    .then(txt => { docCache[file] = mdToHtml(txt); show(docCache[file]); })
    .catch(e => {
      body.innerHTML = '<p>' + escHtml(t('docFail')) + '</p><pre class="err">'   // scan-ok: escaped
                     + escHtml(file + ': ' + (e && e.message ? e.message : e)) + '</pre>';
    });
}

// The footer disclaimer shows the same points as the warning before a flash, but
// without a confirm button: reading the terms must never start a flash.
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
  // Delegated: the guide link inside a translated hint is rebuilt on every switch.
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
  // Error reports and battery info. Esc closes a dialog too, so the refresh is stopped from the
  // close event rather than from the buttons.
  $('btn-err').addEventListener('click', openErrorReports);
  $('btn-bat').addEventListener('click', openBatteryInfo);
  ['err-close', 'err-close-2'].forEach(id => {
    $(id).addEventListener('click', () => { const d = $('err'); if (d) d.close(); });
  });
  ['bat-close', 'bat-close-2'].forEach(id => {
    $(id).addEventListener('click', () => { const d = $('bat'); if (d) d.close(); });
  });
  ['fwwarn-close', 'fwwarn-close-2'].forEach(id => {
    const el = $(id); if (el) el.addEventListener('click', () => { const d = $('fwwarn'); if (d) d.close(); });
  });
  $('err').addEventListener('close', stopErrorReports);
  $('bat').addEventListener('close', stopBatteryInfo);

  // Firmware flashing is removed on the Blade build (the Blade cannot be flashed this way). The OTA
  // internals in this file stay inert (otaEngine is always null), so the link/queue guards keep working.

  refreshInfoButtons();      // start disabled; both views need a link that delivers frames
  if (!navigator.bluetooth) log('Web Bluetooth not available. On iOS use the Bluefy browser.');
  // Someone arriving at .../#disclaimer meant the terms, an address written in the documents.
  if (location.hash.replace('#', '').toLowerCase().startsWith('disclaimer')) openDisclaimer();
  parseDeepLink();                              // read ?do=lock|unlock from a home-screen shortcut
  if (pendingDeepAction) tryAutoReconnect();    // only a shortcut auto-reconnects; a normal open uses the chooser
});
