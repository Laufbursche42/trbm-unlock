# Guide: Laufbursche Blade Mini (eKFV) unlock

> **Feasibility study.** This tool exists to show what a Teverun scooter's firmware makes possible, it is not a finished product. Error-free operation is not promised, there is no warranty of any kind. Whatever you build here and flash, you do at your own risk.

## 1. What you need

Everything happens in the browser over Web Bluetooth: connect, flash a firmware, unlock, lock, set wheel diameter and cruise. There is nothing to install. All it takes is:

**A browser that speaks Web Bluetooth.**

- **iOS:** the **Bluefy** browser (free in the App Store). Safari and every other iOS browser run on the Safari engine, which has no Web Bluetooth at all.
- **Android or desktop:** **Chrome** or another Chromium browser. Web Bluetooth is built in, no extra browser needed.

**A Teverun Blade Mini (eKFV)** with the **IVCU hardware version 5.x** controller. Not the "Ali box".

**A firmware file of your own.** This page carries none. Section 4 covers where it comes from.

---

## 2. Connect

1. Open the page in Bluefy or Chrome.
2. Switch the scooter on. It has to stay within a few metres of the phone.
3. Tap **Connect** and pick your scooter in the browser's chooser. Only scooters show up in that list.
4. Watch the status pill in the top right: `connecting`, then `linking`, then `connected`. It says `connected` only once real telemetry arrives, so it means the link carries data rather than that the radio merely agreed.

The tiles below then fill in:

- **Wheel** and **Cruise**: what the controller currently has.
- **Firmware version**: the version the controller reports, `R5.4.19` on the stock firmware.
- **Laufbursche Version**: the build stamp of a Laufbursche firmware, for example `V44`. It stays at `-` on a stock firmware.

If nothing arrives, the page reports `no-data` and keeps the link open. The scooter was out of range or asleep: wake it up and the tiles fill in on their own. A scooter that sits in update mode after an interrupted flash sends no telemetry either. That is exactly why the link stays: the new flash runs over the same connection. The very first connect always needs the browser chooser. That is a browser security rule no shortcut can skip.

---

## 3. Set Auto-Off to 30 minutes

Do this on the scooter display **before** you flash.

A flash takes about seven minutes. A scooter that switches itself off in the middle of one has to be flashed again before it runs, so give it a timeout that comfortably outlasts the flash. 30 minutes is the setting to pick.

Two more things that keep a flash alive:

- Keep the page in the **foreground** on the phone. The Bluetooth link only lives while the page is in front, there is no background operation.
- Stop the screen from locking during the flash. A locked phone can suspend the page.

---

## 4. Get a firmware file

This page ships no firmware, so you bring the file. If you already have one, skip straight to section 5.

Otherwise you build it with the [Laufbursche Firmware Patcher](https://laufbursche42.github.io/tr-fw/). You supply the stock image of your own scooter, the patcher applies the patch set in the browser and hands you a flashable Intel HEX back, named like `AWIVCU_APP_R5_4_19_V44.hex`. The file never leaves your device.

---

## 5. Flash the firmware

1. **Connect first** (section 2). The flash runs over that same Bluetooth link.
2. Tap **Choose file** in the **Flash firmware** card and pick your `.hex`.
3. **Read what the page says about the file.** It reports the firmware version out of the file trailer, the payload size, the number of packets it will send and the checksum it calculated. If the file is not usable it says why in plain language, for example:
   - `not a firmware file: no data records or no vendor trailer`
   - `the file is damaged: CRC 1234 does not match the trailer 5678`
   - `this is not controller app firmware: the first packet targets 0x..., below the app base`

   Every one of these checks runs before a single byte goes out, so a refused file leaves the scooter completely untouched.
4. Tap **Flash**. A confirmation opens with what is about to happen. Tick the box saying you read the disclaimer: only then does **I understand, flash** become pressable. The text itself opens out of that same confirmation, which stays open behind it.
5. From here on: scooter on, page open and in the foreground, phone next to the scooter.
6. Wait about seven minutes. The bar fills, the packet counter climbs and the log records each step.
7. The flash is through when the log says `CRC correct, refresh complete` followed by `Upgrade over`.
8. Switch the scooter off and on again, connect once more and read the **Laufbursche Version** line. It must show the build you just flashed. **Firmware version** stays at `R5.4.19`, because a Laufbursche firmware is that same version with patches applied.

### What the progress and the log tell you

The bar shows the percentage and which packet of how many is on the wire. The line under it names the step the flasher is in.

The log is the detailed record, newest line on top. A healthy run reads like this, oldest first:

```
Ready for upgrade
VCU image, 182 packets, 92924 bytes, CRC 3693
Wait for system
Update start accepted
Start upgrade
Info accepted, sending 182 packets
Finishing
CRC correct, refresh complete
Upgrade over
```

Lines like `Packet 57 stuck, re-sending (attempt 2)` or `Packet 57 error (status 0x55, frame loss)` in between are the flasher recovering from a lost frame over a busy radio link. One or two of them are not a problem. A single packet gets up to five attempts and the whole run gets restarted up to two times, so a reported failure means the flasher really has run out of options.

---

## 6. When a flash fails

**The state of the scooter:** the controller sits in update mode and the scooter will not run until a flash completes. That is recoverable by flashing again. The same applies after you tap **Cancel**, which the log states as `Cancelled. Flash again before riding, the scooter is in update mode.`

**What to do:**

1. Leave the scooter switched on. If it powered itself off, switch it back on and check that Auto-Off is at 30 minutes.
2. Bring the phone right next to the scooter.
3. Tap **Connect** again if the link dropped, then **Choose file** and **Flash** with the same file.
4. Repeat until a run completes. There is no limit on how often a controller can be flashed.

**What the failure message points at:**

| Message | What it usually means |
| --- | --- |
| `no response to the update request. Is the scooter on and in range?` | The controller never accepted the start: scooter off, asleep, too far away or not the IVCU 5.x hardware. |
| `the scooter disconnected` | The Bluetooth link dropped mid-run: Auto-Off, distance, a locked phone screen or the page going to the background. |
| `packet 57/182 failed repeatedly` or `packet 57/182 got no response. Is the scooter on and in range?` | Too many lost frames at that point. Move the phone closer, then flash again. |
| `the update timed out after 30 minutes` | The run stalled for good. Start over from step 1. |

If the page refused the file instead, nothing was sent. Get a working file (section 4), then start again.

---

## 7. Unlock and lock

One button carries the action for the current state: it reads **Unlock** while the scooter is locked, **Lock** while it is open.

- The state comes live from the scooter, not from a guess. Until the first telemetry frame delivers it, the button reads `reading...` and stays disabled.
- Lock and unlock are a direct Bluetooth command to the controller (cmd 0x1B). They have nothing to do with the FIN, the Bluetooth name or any identity.

An unlocked scooter belongs on private ground. See the [disclaimer](README.md#disclaimer).

---

## 8. Wheel diameter and cruise

Both sit in the **Settings** card. They become editable once the scooter has reported its configuration and is **unlocked**. The firmware discards such a write while locked, so the page keeps the inputs disabled instead of pretending.

**Wheel diameter**, in inches with one decimal. Type your real value, then tap **Set wheel**. It is a single global value in the controller, so one write covers every gear. It calibrates the speedometer and the odometer only, never the motor controller, so your actual speed does not change. Set it here or in the [Laufbursche Edition App](https://github.com/Laufbursche42/tr-lb-edition), not in the original Teverun app.

**Cruise:** `Off`, `Auto` or `Manual`, then **Set cruise**. Almost every scooter handles `Auto` only, so set it to that. `Auto` holds the pace by itself once you keep it steady for a while.

Both values are stored in this browser on this device and written back automatically after an unlock. Nothing is uploaded anywhere.

---

## 9. Home-screen shortcut

A shortcut opens the page already set to lock or unlock: a paired scooter reconnects without the chooser and the action runs by itself. Make one shortcut for **Unlock** and one for **Lock**.

**Do one clean run without the shortcut first:** connect, use **Unlock** and **Lock** once, set wheel diameter and cruise once. Only a prior manual run puts those values in the browser, which the shortcut's unlock then restores.

### iOS (Bluefy)

Open the **Shortcuts** app, create a shortcut, add the action **Open URLs**, paste one of the links below, then add the shortcut to the home screen or give it a Siri phrase. A plain `https` link would open Safari, which has no Bluetooth. The `bluefy://` scheme opens Bluefy.

### Android (Chrome)

Open the link from the page in Chrome, then use the menu and **Add to Home screen**. Web Bluetooth is built in, so the icon opens straight into the page.

The scooter has to be on and in range. The first-ever visit still needs the one-time **Connect** with the chooser.

---

## 10. Limits worth knowing

- **No background operation.** The link lives only while the page is open and in the foreground.
- **Reconnect only inside the running session.** If the radio link drops while the page is open and in the foreground, it reconnects by itself. Once the page is closed the link is gone and you press **Connect** again. Only a shortcut carrying `?do=lock` or `?do=unlock` reconnects without the chooser on open.
- **iOS: always Bluefy.** A home-screen bookmark made in Safari opens the Safari engine, which has no Bluetooth. The Shortcut with the `bluefy://` link is the way to a home-screen icon.
- **Nothing leaves your device** but the page load itself. Details in the [privacy notice](PRIVACY.md).

---

## 11. Legal

Read the [disclaimer](README.md#disclaimer) in full before you flash anything. In short: a patched firmware ends the road approval and the insurance cover, so the scooter belongs on private property. An interrupted flash leaves a scooter that will not run until a flash completes. Everything you do here is at your own risk.
