'use strict';

// ---------------------------------------------------------------------------
// Firmware update over BLE, the protocol the VCU bootloader speaks.
//
// This is a port of the flasher in tools/lbtool.py, which is itself a port of
// the Android app's OtaEngine. Timer for timer, retry for retry: the controller
// is unforgiving. A flash that stalls halfway leaves a scooter that will not
// run until a flash completes. Nothing here is "simplified".
//
// The caller supplies the transport. Writes must be SERIALISED (one GATT write
// at a time) or the browser rejects them with "operation already in progress".
// ---------------------------------------------------------------------------

(function (global) {

  // -- checksums ------------------------------------------------------------

  function crc8(bytes) {
    let crc = 0;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] & 0xFF;
      for (let b = 0; b < 8; b++) crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xFF : (crc << 1) & 0xFF;
    }
    return crc & 0xFF;
  }

  function crc16Modbus(bytes) {
    let crc = 0xFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] & 0xFF;
      for (let n = 0; n < 8; n++) crc = (crc & 1) ? ((crc >>> 1) ^ 0xA001) : (crc >>> 1);
    }
    return crc & 0xFFFF;
  }

  // -- hex file -------------------------------------------------------------

  const APP_BASE_OFFSET = 0x7000;   // the app starts at 0x08007000; below it is the bootloader

  function isHex(s) {
    return !!s && /^[0-9a-fA-F]+$/.test(s);
  }

  // 3 address bytes from sId (2 hex chars) plus backId (4), right-aligned in 6.
  function addr3(sId, backId) {
    const r = ((sId || '00') + (backId || '0000')).padStart(6, '0');
    return [parseInt(r.slice(0, 2), 16), parseInt(r.slice(2, 4), 16), parseInt(r.slice(4, 6), 16)];
  }

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  // Grouping follows the file, not the addresses: a type-04 record closes the
  // current packet. Reaching linesPerPacket data records closes it too.
  function parseHex(rawLines, linesPerPacket) {
    const res = { packets: [], allData: new Uint8Array(0), fileType: 0, fileCode: 0, fileVer: '', fileCrc: '' };
    const allHex = [];
    let last04 = '00';
    let cur = { sId: '', backId: '', data: '' };
    let data = [];
    let count = 0;
    let sawData = false;

    for (const raw of rawLines) {
      if (raw == null) continue;
      const line = raw.trim();
      if (line.length < 9 || line[0] !== ':') continue;
      const tt = line.slice(7, 9);

      if (tt === '04') {
        if (data.length) {
          cur.data = data.join('');
          res.packets.push(cur);
          allHex.push(cur.data);
          cur = { sId: last04, backId: '', data: '' };
          data = [];
          count = 0;
        }
        if (line.length >= 13 && isHex(line.slice(11, 13))) {
          last04 = line.slice(11, 13);
          cur.sId = last04;
        }
      } else if (tt === '00') {
        if (!isHex(line.slice(1, 3))) continue;
        const ll = parseInt(line.slice(1, 3), 16);
        const end = 9 + 2 * ll;
        if (line.length < end || !isHex(line.slice(1, end))) continue;   // truncated record
        if (count === 0) cur.backId = line.slice(3, 7);
        data.push(line.slice(9, end));
        count++;
        sawData = true;
        if (count >= linesPerPacket) {
          cur.data = data.join('');
          res.packets.push(cur);
          allHex.push(cur.data);
          cur = { sId: cur.sId, backId: '', data: '' };
          data = [];
          count = 0;
        }
      }

      // Vendor trailer ":07AAA555..": uId, proId, version, CRC16, checksum.
      if (line.length >= 25 && line.slice(1, 9) === '07AAA555' && isHex(line.slice(9, 23))) {
        res.fileType = parseInt(line.slice(9, 11), 16);
        res.fileCode = parseInt(line.slice(11, 13), 16);
        res.fileVer = parseInt(line.slice(13, 15), 16) + '.' + parseInt(line.slice(15, 17), 16)
          + '.' + parseInt(line.slice(17, 19), 16);
        res.fileCrc = line.slice(19, 23);
      }
    }

    if (data.length) {
      cur.data = data.join('');
      res.packets.push(cur);
      allHex.push(cur.data);
    }
    if (!sawData) res.packets = [];
    res.allData = hexToBytes(allHex.join(''));
    return res;
  }

  // Every gate runs before a single byte goes out. Throws with a plain-language
  // reason, which is what the page shows.
  function checkImage(text, name) {
    name = (name || '').trim();
    const isVcu = !name.toUpperCase().startsWith('AWE');
    const packLen = isVcu ? 512 : 1024;
    const linesPerPacket = packLen / 16;

    const res = parseHex(text.split('\n'), linesPerPacket);
    if (!res.packets.length || !res.fileCrc) {
      throw new Error('not a firmware file: no data records or no vendor trailer');
    }

    const calc = crc16Modbus(res.allData).toString(16).toUpperCase().padStart(4, '0');
    if (calc !== res.fileCrc.toUpperCase()) {
      throw new Error('the file is damaged: CRC ' + calc + ' does not match the trailer '
        + res.fileCrc.toUpperCase());
    }

    const a = addr3(res.packets[0].sId, res.packets[0].backId);
    const firstAddr = (a[0] << 16) | (a[1] << 8) | a[2];
    if (isVcu && firstAddr < APP_BASE_OFFSET) {
      throw new Error('this is not controller app firmware: the first packet targets 0x'
        + firstAddr.toString(16).toUpperCase() + ', below the app base');
    }

    return {
      name: name, isVcu: isVcu, res: res, calcCrc: calc, firstAddr: firstAddr,
      packLen: packLen, linesPerPacket: linesPerPacket,
      bytes: res.allData.length, packets: res.packets.length, version: res.fileVer
    };
  }

  // -- wire format ----------------------------------------------------------

  function otaConfig(isVcu) {
    const idHi = 0x07;
    const lo = isVcu ? 0x10 : 0x00;
    return {
      START: [idHi, lo], START_RESP: [idHi, lo + 0x40],
      FINISH: [idHi, lo + 0x01], FINISH_RESP: [idHi, lo + 0x41],
      INFO: [idHi, lo + 0x02], INFO_RESP: [idHi, lo + 0x42],
      PACKINFO: [idHi, lo + 0x03], PACKINFO_RESP: [idHi, lo + 0x43],
      PACKDATA: [idHi, lo + 0x04], PACKDATA_RESP: [idHi, lo + 0x44]
    };
  }

  function otaFrame(fid, payload8) {
    const out = [fid[0], fid[1]];
    for (let i = 0; i < 8; i++) out.push(payload8[i] & 0xFF);
    return out;
  }

  // 0xBB [10 bytes] crc8
  function otaWire(frame10) {
    const out = new Uint8Array(12);
    out[0] = 0xBB;
    for (let i = 0; i < 10; i++) out[1 + i] = frame10[i] & 0xFF;
    out[11] = crc8(frame10);
    return out;
  }

  // 0xAA 04 03 FF*16 plus CRC-8. The VCU covers the 0xAA in the CRC, the BMS does not.
  function prepareFrame(isVcu) {
    if (isVcu) {
      const p = [0xAA, 0x04, 0x03].concat(new Array(16).fill(0xFF));
      return new Uint8Array(p.concat([crc8(p)]));
    }
    const q = [0x04, 0x03].concat(new Array(16).fill(0xFF));
    return new Uint8Array([0xAA].concat(q, [crc8(q)]));
  }

  // -- timings, taken from the app --------------------------------------------

  const PREPARE_TO_START_MS = 1500;
  const START_RETRY_MS = 1000;
  const START_MAX_RETRIES = 9;      // 10 START sends in total
  const STEP_RESEND_MS = 3000;
  const GLOBAL_WATCHDOG_MS = 1800000;
  const STUCK_RECOVERY_MS = 5000;
  const FINISH_CHECK_MS = 10000;
  const CORRUPT_NUDGE_MS = 100;
  const PACKDATA_ERR_RETRY_MS = 200;
  const INTERFRAME_MS = 30;
  const PACKET_STALL_TICKS = 2;
  const PACKET_MAX_RETRIES = 5;
  const MAX_RESTARTS = 2;

  const PACKDATA_REASONS = { 1: 'receive timeout', 2: 'frame loss', 3: 'flash write failed' };

  // -- engine ---------------------------------------------------------------

  function OtaEngine(chk, io) {
    this.chk = chk;
    this.io = io;                       // { write, log, progress, finished }
    this.config = otaConfig(chk.isVcu);
    this.packets = chk.res.packets;
    this.allData = chk.res.allData;

    this.running = false;
    this.upGradeType = false;           // START has gone out for this attempt
    this.upGradeState = 0;              // 0 idle, 1 success, 2 no START, 3 flashing
    this.backIndex = 0;
    this.retryCount = 0;
    this.restarts = 0;
    this.packetRetries = 0;
    this.hasBreak = false;
    this.phase = 'prepare';
    this.framesSent = 0;

    this._handles = new Set();
    this._pending = [];
    this._startRetry = null;
    this._stepResend = null;
    this._stuck = null;
    this._watchdog = null;
    this._finishCheck = null;
  }

  OtaEngine.prototype._log = function (line) {
    if (this.io.log) this.io.log(line);
  };

  OtaEngine.prototype._progress = function (phase) {
    if (!this.io.progress) return;
    const count = this.packets.length;
    const pkt = Math.min(this.backIndex + 1, count);
    const percent = count ? Math.min(100, Math.floor((this.backIndex + 1) * 100 / count)) : 0;
    this.io.progress({ percent: percent, packet: pkt, count: count, phase: phase });
  };

  OtaEngine.prototype._later = function (ms, fn) {
    const self = this;
    const h = setTimeout(function () {
      self._handles.delete(h);
      if (!self.running) return;
      fn();
    }, ms);
    this._handles.add(h);
    return h;
  };

  OtaEngine.prototype._cancel = function (h) {
    if (h != null) { clearTimeout(h); this._handles.delete(h); }
  };

  OtaEngine.prototype._clearAllTimers = function () {
    this._handles.forEach(function (h) { clearTimeout(h); });
    this._handles.clear();
    this._startRetry = this._stepResend = this._stuck = null;
    this._watchdog = this._finishCheck = null;
  };

  OtaEngine.prototype._clearPending = function () {
    for (const h of this._pending) { clearTimeout(h); this._handles.delete(h); }
    this._pending = [];
  };

  OtaEngine.prototype._armStepResend = function (action) {
    this._cancel(this._stepResend);
    this._stepResend = this._later(STEP_RESEND_MS, action);
  };

  OtaEngine.prototype._armWatchdog = function () {
    const self = this;
    this._cancel(this._watchdog);
    this._watchdog = this._later(GLOBAL_WATCHDOG_MS, function () {
      if (self.upGradeState === 3) self._fail('the update timed out after 30 minutes');
    });
  };

  OtaEngine.prototype._write = function (frame) {
    this.framesSent++;
    this.io.write(frame);
  };

  OtaEngine.prototype.start = function () {
    const self = this;
    this.running = true;
    this.phase = 'prepare';
    this._log('Ready for upgrade');
    this._log((this.chk.isVcu ? 'VCU' : 'BMS') + ' image, ' + this.packets.length + ' packets, '
      + this.allData.length + ' bytes, CRC ' + this.chk.calcCrc);
    // Step 0: prepare and erase. No response is expected, START follows after 1500 ms.
    this._write(prepareFrame(this.chk.isVcu));
    this._log('Wait for system');
    this._later(PREPARE_TO_START_MS, function () { self._cilpPackage(); });
  };

  OtaEngine.prototype.cancel = function () {
    if (!this.running) return;
    this._log('Cancelled. Flash again before riding, the scooter is in update mode.');
    this._finish(false, 'cancelled');
  };

  OtaEngine.prototype.onDisconnect = function () {
    if (this.running) this._fail('the scooter disconnected');
  };

  OtaEngine.prototype._cilpPackage = function () {
    const self = this;
    this._cancel(this._stepResend);
    this.retryCount = 0;
    if (this.upGradeType) return;
    this.upGradeType = true;
    this.phase = 'START';

    function tick() {
      self._write(otaWire(otaFrame(self.config.START, new Array(8).fill(0xAA))));
      if (self.retryCount < START_MAX_RETRIES) {
        self.retryCount++;
        self._startRetry = self._later(START_RETRY_MS, tick);
      } else {
        self.upGradeState = 2;
        self.retryCount = 0;
        self._fail('no response to the update request. Is the scooter on and in range?');
      }
    }
    tick();
  };

  OtaEngine.prototype.onNotify = function (value) {
    try {
      this._handleNotify(value);
    } catch (e) { /* a malformed frame must never kill the flash */ }
  };

  OtaEngine.prototype._handleNotify = function (v) {
    if (!v || v.length < 12) return;
    const mid = Array.prototype.slice.call(v, 1, 11);
    const crcOk = crc8(mid) === v[11];
    if (v[0] === 0xCC && crcOk) { this._handleResponse(mid); return; }
    // A corrupted 0xcc during an active flash re-drives the current packet.
    if (this.upGradeType && v[0] === 0xCC && !crcOk) {
      const self = this;
      this._later(CORRUPT_NUDGE_MS, function () { self._sendNextBack(); });
    }
  };

  function idIs(n, pair) { return n[0] === pair[0] && n[1] === pair[1]; }

  OtaEngine.prototype._handleResponse = function (n) {
    const self = this;
    const status = n[2], reason = n[3];
    const cfg = this.config;

    if (idIs(n, cfg.START_RESP) && status === 0x55) {
      // Stop the START retry loop. Leaving it running keeps re-sending START and
      // aborts the flash a few packets in.
      this._cancel(this._startRetry);
      this._startRetry = null;
      this._log('Update start accepted');
      this.upGradeState = 3;
      this._armWatchdog();
      this._cancel(this._stepResend);
      this._later(200, function () { self._sendInfo(); });
      return;
    }

    if (idIs(n, cfg.INFO_RESP)) {
      this._log('Info accepted, sending ' + this.packets.length + ' packets');
      this._cancel(this._stepResend);
      this.backIndex = 0;
      this.packetRetries = 0;
      this._progress('sending');
      this._sendPackInfo();
      return;
    }

    if (idIs(n, cfg.PACKINFO_RESP)) {
      this._cancel(this._stepResend);
      this._pumpPackData();
      return;
    }

    if (idIs(n, cfg.PACKDATA_RESP)) {
      if (status === 0xAA) {
        this.backIndex++;
        this.packetRetries = 0;
        this._sendNextBack();
      } else {
        const why = PACKDATA_REASONS[reason] || ('reason 0x' + reason.toString(16));
        this._log('Packet ' + (this.backIndex + 1) + ' error (status 0x'
          + status.toString(16) + ', ' + why + ')');
        this.hasBreak = true;
        if (this.packetRetries >= PACKET_MAX_RETRIES) {
          this._fail('packet ' + (this.backIndex + 1) + '/' + this.packets.length
            + ' failed repeatedly');
          return;
        }
        this.packetRetries++;
        this._later(PACKDATA_ERR_RETRY_MS, function () { self._sendNextBack(); });
      }
      return;
    }

    if (idIs(n, cfg.FINISH_RESP)) {
      this._cancel(this._stepResend);
      if (status === 0xAA) {
        this._log('CRC correct, refresh complete');
        this.upGradeState = 1;
        this._succeed();
      } else if (status === 0x55) {
        this._startCheckUpgrade('CRC error, upgrade failure');
      } else if (status === 0xA5) {
        this._startCheckUpgrade('timeout error');
      } else {
        this._startCheckUpgrade('');
      }
    }
  };

  OtaEngine.prototype._sendInfo = function () {
    const self = this;
    this.phase = 'INFO';
    const p0 = this.packets[0];
    const a = addr3(p0.sId, p0.backId);
    const total = this.allData.length;
    const crc = crc16Modbus(this.allData);
    const frame = otaWire(otaFrame(this.config.INFO, [
      a[0], a[1], a[2],
      (total >> 16) & 0xFF, (total >> 8) & 0xFF, total & 0xFF,
      (crc >> 8) & 0xFF, crc & 0xFF
    ]));
    this._log('Start upgrade');
    this._write(frame);
    this._armStepResend(function () { self._write(frame); });
  };

  OtaEngine.prototype._sendPackInfo = function () {
    const self = this;
    if (this.backIndex < 0 || this.backIndex >= this.packets.length) return;
    this.phase = 'PACKINFO';
    const p = this.packets[this.backIndex];
    const a = addr3(p.sId, p.backId);
    const plen = p.data.length / 2;
    const frame = otaWire(otaFrame(this.config.PACKINFO, [
      a[0], a[1], a[2],
      (plen >> 16) & 0xFF, (plen >> 8) & 0xFF, plen & 0xFF,
      this.backIndex & 0xFF, this.packets.length & 0xFF
    ]));
    this._write(frame);
    this._armStepResend(function () { self._write(frame); });
  };

  OtaEngine.prototype._pumpPackData = function () {
    const self = this;
    if (this.backIndex < 0 || this.backIndex >= this.packets.length) return;
    this.phase = 'PACKDATA';
    this.hasBreak = false;
    this._clearPending();
    const data = hexToBytes(this.packets[this.backIndex].data);
    const frameCount = Math.floor(data.length / 7) + 1;
    this._progress('packet data');
    let pos = 0;
    for (let m = 0; m < frameCount; m++) {
      const payload = [m & 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];
      for (let k = 0; k < 7 && pos < data.length; k++) payload[1 + k] = data[pos++];
      const out = otaWire(otaFrame(this.config.PACKDATA, payload));
      const h = this._later((m + 1) * INTERFRAME_MS, function () {
        if (self.running && !self.hasBreak) self._write(out);
      });
      this._pending.push(h);
    }
    // The controller answers once, when it has the whole packet.
  };

  OtaEngine.prototype._sendNextBack = function () {
    const self = this;
    if (!this.running) return;
    this._cancel(this._stuck);
    this._stuck = null;
    this._clearPending();
    this._progress('sending');
    if (this.backIndex < this.packets.length) {
      this._sendPackInfo();
      this._armStuck(this.backIndex);
    } else {
      this.phase = 'FINISH';
      this._log('Finishing');
      const finish = otaWire(otaFrame(this.config.FINISH, new Array(8).fill(0xAA)));
      this._write(finish);
      this._armStepResend(function () {
        self._write(finish);
        self._startCheckUpgrade('');
      });
    }
  };

  // Per-packet watchdog: re-drive on an error or after about 10 s of silence.
  OtaEngine.prototype._armStuck = function (pkt) {
    const self = this;
    let ticks = 0;
    function tick() {
      if (self.backIndex !== pkt) return;   // packet advanced, stale timer
      let stalled = self.hasBreak;
      if (!stalled) { ticks++; stalled = ticks >= PACKET_STALL_TICKS; }
      if (!stalled) { self._stuck = self._later(STUCK_RECOVERY_MS, tick); return; }
      if (self.packetRetries >= PACKET_MAX_RETRIES) {
        self._fail('packet ' + (pkt + 1) + '/' + self.packets.length
          + ' got no response. Is the scooter on and in range?');
        return;
      }
      self.packetRetries++;
      self._log('Packet ' + (pkt + 1) + ' stuck, re-sending (attempt ' + (self.packetRetries + 1) + ')');
      self._sendNextBack();
    }
    this._stuck = this._later(STUCK_RECOVERY_MS, tick);
  };

  OtaEngine.prototype._startCheckUpgrade = function (msg) {
    const self = this;
    if (msg) this._log(msg);
    this._cancel(this._finishCheck);
    this._finishCheck = this._later(FINISH_CHECK_MS, function () {
      if (self.upGradeState === 1) return;
      if (self.restarts >= MAX_RESTARTS) { self._fail(msg || 'the upgrade failed'); return; }
      self.restarts++;
      self._log('Retrying upgrade (attempt ' + (self.restarts + 1) + ')');
      self._later(1000, function () {
        self.upGradeType = false;
        self._cilpPackage();
      });
    });
  };

  OtaEngine.prototype._succeed = function () {
    this._log('Upgrade over');
    this._progress('done');
    this._finish(true, 'firmware updated');
  };

  OtaEngine.prototype._fail = function (message) {
    this._finish(false, message);
  };

  OtaEngine.prototype._finish = function (success, message) {
    if (!this.running) return;
    this.running = false;
    this._clearAllTimers();
    this._clearPending();
    if (this.io.finished) this.io.finished(success, message, this.phase);
  };

  global.OTA = {
    checkImage: checkImage,
    OtaEngine: OtaEngine,
    crc8: crc8,
    crc16Modbus: crc16Modbus
  };

})(window);
