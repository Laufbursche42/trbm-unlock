# Guide: Laufbursche Blade Mini (eKFV) unlock

> **Feasibility study.** This tool shows what a Teverun scooter's Bluetooth protocol makes possible, it is not a finished product. Error-free operation is not promised and there is no warranty of any kind. Whatever you do here, you do at your own risk.

## 1. What you need

Everything happens in the browser over Web Bluetooth: connect, unlock, lock, read faults and battery. There is nothing to install. All you need is:

**A browser that supports Web Bluetooth.**

- **iOS:** the **Bluefy** browser (free on the App Store). Safari and every other iOS browser run on the Safari engine, which has no Web Bluetooth at all.
- **Android or desktop:** **Chrome** or another Chromium browser. Web Bluetooth is built in, no extra browser needed.

**A Teverun Blade Mini (eKFV).** The Blade has no IVCU, only an ESC with an MCU. So the eKFV limit there is not a firmware clamp, it is simply the speed value the app writes per gear.

---

## 2. Connect

1. Open the page in Bluefy or Chrome.
2. Turn the scooter on. It has to stay a few metres from the phone.
3. Tap **Connect** and pick your scooter in the browser's chooser. Only scooters appear in that list.
4. Watch the status top right: `connecting`, then `linking`, then `connected`. `connected` only shows once real telemetry arrives, so it means the link is carrying data, not just that the radio agreed.

Then the readouts fill in:

- **Speed/gear:** the speed value of the currently selected gear, as the controller reports it.
- **Currently read:** the line `Gang X | per-Gang Y | Max Z` shows live what the controller holds right now.
- **Firmware version:** the version the controller reports, on stock firmware for example `R3.4.6`.

If nothing arrives the page shows `no-data` and keeps the link open. The scooter was out of range or asleep: wake it and the readout settles on its own. The first-ever connect always needs the browser's chooser. That is a browser security rule no shortcut can skip.

---

## 3. Unlock and lock

This is the core. The Blade is not locked via the FIN, the Bluetooth name or a status bit, but via the **per-gear speed values**. The stock app refuses to write high values for a TDE FIN. This page writes them directly.

The control card holds three fields for the German gears:

- **Gang 1** (default 45), **Gang 2** (default 60), **Gang 3** (default 80).
- These three fields are the **unlocked** speeds. You can change the values.
- Internally these are ESC gears 2, 3 and 4. Gears 1 and 5 exist only on the international variant and are left untouched.

**Unlock** writes the three values to the gears. **Lock** sets all three back to **22**. The button carries the matching action: it reads **Unlock** while locked and **Lock** while open. It is actionable once connected and the first telemetry frame (`55 71`) has arrived.

A note on state: the Blade does not report the locked/unlocked state cleanly in telemetry. So the feedback you get is the actual values in the **Currently read** line (per-gear speed), not a guessed lock icon.

An unlocked scooter belongs on private property. See the [Disclaimer](README.md#disclaimer).

---

## 4. Error reports and battery info

Both views only read along, nothing is sent to the scooter. The buttons become active once connected and frames arrive.

- **Error reports:** the fault codes the controller and BMS stream by themselves.
- **Battery info:** pack voltage, current, cell voltages and temperatures as the controller reports them.

---

## 5. Home-screen shortcut

A shortcut opens the page already set to lock or unlock: a paired scooter reconnects without the chooser and the action runs on its own. Make one shortcut for **Unlock** and one for **Lock**. The unlock shortcut writes the default gear values (45/60/80).

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
