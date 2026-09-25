> 🚨 **This tool is moving.** This repository is **no longer maintained** - please switch to the new tool: **[lb-tool-web.pages.dev](https://lb-tool-web.pages.dev/)**. Trouble switching? Open an [issue on GitHub](https://github.com/Laufbursche42/Laufbursche42/issues/new) or send a [PM on the eScooter-Stammtisch forum](https://www.escooter-stammtisch.de/index.php?user/6497-laufbursche/).

# Laufbursche Blade (eKFV) unlock

A static web page that talks to a Teverun Blade / Blade Mini (eKFV) over Web Bluetooth. It reads the full telemetry and, on the supported firmware, lifts and re-imposes the speed limit live, straight from the browser. Nothing to install: no app store, no signing, no developer account. It runs in **Bluefy** on iOS and in **Chrome** on Android or desktop.

**Firmware gate.** Lock and unlock are only verified on firmware **3.4.6**, so that is the only version where the write controls are active. On **3.4.8** they are greyed out with a reason (the limiter sits deep in the ESC firmware and ignores every BLE write). On any other or not-yet-read firmware the tool stays **read-only** and simply shows every field the Blade Mini shows. The detected firmware is displayed at the top.

> **This is a feasibility study.** It exists to show what a Teverun scooter's Bluetooth protocol makes possible, not to be a finished product. Error-free operation is not promised and there is no warranty of any kind. Whatever you do with it, you do at your own risk. Read the [Disclaimer](#disclaimer) before you connect a scooter.

**Open the web app: [laufbursche42.github.io/trbm-unlock](https://laufbursche42.github.io/trbm-unlock/)**

Or run it yourself, no build step, no dependencies: clone the repo and serve the folder over a local HTTP server. Opening `index.html` directly as a `file://` URL will not work, the page fetches its own documents and browsers block that over `file://`.

```
git clone https://github.com/Laufbursche42/trbm-unlock.git
cd trbm-unlock
npx serve .
```

Any static server works. Without Node, Python's own one does the same job:

```
python -m http.server 8000
```

Then open the printed address in a browser that supports Web Bluetooth.

**Guide: [Deutsch](GUIDE.de.md) | [English](GUIDE.en.md)** covers everything step by step, from the first connect to lock and unlock.

## What it does

- **Unlock and lock live** over Bluetooth (firmware 3.4.6 only). Unlock writes a high speed to the German gears (internal ESC gears 2, 3, 4), lock writes the low eKFV values back. The values are editable, per gear in the advanced settings. Unrelated to the FIN or the Bluetooth name.
- **Live telemetry:** speed, charge, voltage, current, gear, cruise, wheel size, unit, ABS and the lock state, read straight from the scooter.
- **Error reports:** read the fault codes the controller and BMS stream by themselves.
- **Battery info:** pack voltage, current, SOC/SOH, capacity, cycles, cell voltages and temperatures the controller reports.
- **Detected firmware version**, shown at the top and used to decide what the tool allows.
- **Basic + advanced settings:** wheel diameter, cruise/Tempomat, and a per-gear expert grid (speed, lock value, start levels, current, eABS).
- **Full log** with timestamped TX/RX hex, copy, clear and save, plus a public (anonymized) and a verbose diagnostics toggle.
- **Home-screen shortcuts** that open the page already set to lock or unlock (refused on firmware where lock/unlock is not available).

Hardware: the Teverun **Blade Mini (eKFV)** - an ESC with an MCU, no IVCU. Gears 1 and 5 exist only on the non-German (international) variant and are left untouched.

## Disclaimer

**Please read this in full before you unlock a scooter.**

- **This is a feasibility study**, not a finished product. It shows what the scooter's Bluetooth protocol makes possible. Nothing here promises that it works with your scooter, your phone or your browser. Nothing promises it still works after the next controller firmware or browser release.
- **Unlocking ends the road approval.** A Blade that no longer holds the eKFV limit is not a road-legal eKFV any more under the eKFV regulation and the StVZO. The operating permit (Betriebserlaubnis) is void, and the insurance cover goes with it.
- **Ride it on private property only**, on closed grounds that are not public traffic space. Riding a derestricted scooter in public traffic is a criminal offence in Germany: no operating permit, no insurance. The liability is entirely yours.
- **No liability**, as far as the law allows, for any damage caused by or with this page: damage to the scooter, to people or to third parties, fines, legal consequences or any other disadvantage.
- **No warranty** of function, correctness or fitness for a particular purpose.
- Everything you do with this page is **at your own risk**.

By using this page you accept these terms.

## License

PolyForm Noncommercial 1.0.0 with two additional terms, in full in [LICENSE.md](LICENSE.md).

## Privacy

Nothing leaves your device but the page load itself. The details are in [PRIVACY.md](PRIVACY.md).

## Trademarks

An independent project, not affiliated with Teverun. "Teverun" and other product names are trademarks of their respective owners and are used here only to say which scooters this page works with. See [TRADEMARKS.md](TRADEMARKS.md).
