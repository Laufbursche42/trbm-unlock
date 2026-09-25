# Guide: Laufbursche Blade (eKFV) unlock

> **Feasibility study.** This tool shows what a Teverun scooter's Bluetooth protocol makes possible, it is not a finished product. Error-free operation is not promised and there is no warranty of any kind. Whatever you do here, you do at your own risk.

## 1. What you need

Everything happens in the browser over Web Bluetooth: connect, unlock, lock, read faults and battery. There is nothing to install. All you need is:

**A browser that supports Web Bluetooth.**

- **iOS:** the **Bluefy** browser (free on the App Store). Safari and every other iOS browser run on the Safari engine, which has no Web Bluetooth at all.
- **Android or desktop:** **Chrome** or another Chromium browser. Web Bluetooth is built in, no extra browser needed.

**A Teverun Blade / Blade Mini (eKFV).** The Blade has no IVCU, only an ESC with an MCU. On firmware 3.4.6 the eKFV limit is not a firmware clamp, it is simply the speed value the app writes per gear. On 3.4.8 the limiter moved deep into the ESC firmware and ignores every BLE write, so lock/unlock is not possible there.

---

## 2. Connect

1. Open the page in Bluefy or Chrome.
2. Turn the scooter on. It has to stay a few metres from the phone.
3. Tap **Connect** and pick your scooter in the browser's chooser. Only scooters appear in that list.
4. Watch the status top right: `connecting`, then `linking`, then `connected`. `connected` only shows once real telemetry arrives, so it means the link is carrying data, not just that the radio agreed.

Then the live tiles fill in: speed, charge, voltage, current, gear, cruise, wheel size, unit, ABS, firmware and the lock state, read straight from the scooter. All of these are shown on every firmware.

**Detected firmware.** The card near the top shows the version the controller reports and what the tool will let you do with it:

- **3.4.6** - lock/unlock and the settings are available.
- **3.4.8** - lock/unlock is greyed out with a reason: the limiter sits in the ESC firmware and ignores every BLE write.
- **Any other or not-yet-read version** - the tool stays read-only and just shows all the fields.

If nothing arrives the page shows `no-data` and keeps the link open. The scooter was out of range or asleep: wake it and the readout settles on its own. The first-ever connect always needs the browser's chooser. That is a browser security rule no shortcut can skip.

---

## 3. Unlock and lock (firmware 3.4.6)

This is the core, and it only works on firmware **3.4.6**. The Blade is not locked via the FIN, the Bluetooth name or a status bit, but via the **per-gear speed values**. The stock app refuses to write high values for a TDE FIN. This page writes them directly.

The lock/unlock card holds two quick fields:

- **Open speed** and **Legal speed** set all three German gears to one value at once.
- For different values per gear, open **Advanced settings**: a grid with speed, lock value, front/rear start, current and eABS per gear. Internally the German gears are ESC gears 2, 3 and 4; gears 1 and 5 exist only on the international variant and are left untouched.

**Unlock** writes the open speeds to the gears. **Lock** writes the low eKFV lock values back (default 10/15/21 - 21 rather than 22 keeps the start-up peak under the eKFV line). The button carries the matching action: it reads **Unlock** while locked and **Lock** while open. It becomes active once connected, the first telemetry frame (`55 71`) has arrived and the firmware is 3.4.6.

The lock state tile is derived from the live per-gear speed, not from the FIN or the Bluetooth name.

An unlocked scooter belongs on private property. See the [Disclaimer](README.md#disclaimer).

---

## 4. Error reports and battery info

Both views only read along, nothing is sent to the scooter. The buttons become active once connected and frames arrive.

- **Error reports:** the fault codes the controller and BMS stream by themselves.
- **Battery info:** pack voltage, current, cell voltages and temperatures as the controller reports them.

---

## 5. Home-screen shortcut

A shortcut opens the page already set to lock or unlock: a paired scooter reconnects without the chooser and the action runs on its own. Make one shortcut for **Unlock** and one for **Lock**. The unlock shortcut writes the default gear values (45/60/80). On firmware where lock/unlock is not available (3.4.8 or unknown) the shortcut is refused with the same reason as the on-screen button.

### iOS (Bluefy)

Open the **Shortcuts** app, create a shortcut, add the **Open URLs** action, paste the Bluefy link from the page and add the shortcut to the home screen (or give it a Siri phrase). A plain `https` link would open Safari, which has no Bluetooth. The `bluefy://` scheme opens Bluefy.

### Android (Chrome)

Open the link from the page in Chrome, then menu and **Add to Home screen**. Web Bluetooth is built in, so the icon opens straight into the page.

The scooter must be on and in range. The first-ever visit still needs the one-time **Connect** with the chooser.

---

## 6. Limits worth knowing

- **No background operation.** The link lives only while the page is open and in the foreground.
- **Reconnect only within the running session.** If the radio drops while the page is open and foregrounded, it reconnects on its own. After you close the page the link is gone and you tap **Connect** again. Only a shortcut with `?do=lock` or `?do=unlock` reconnects without the chooser on open.
- **iOS: always Bluefy.** A bookmark added to the home screen from Safari opens the Safari engine, which has no Bluetooth. The shortcut with the `bluefy://` link is the way to a home-screen icon.
- **Nothing leaves your device** but the page load itself. Details in the [Privacy policy](PRIVACY.md).

---

## 7. Legal

Read the [Disclaimer](README.md#disclaimer) in full before you unlock a scooter. In short: an unlocked Blade no longer holds the eKFV limit and is therefore not a road-legal eKFV any more, the operating permit and the insurance cover fall away. It belongs on private property. Everything you do here you do at your own risk.
