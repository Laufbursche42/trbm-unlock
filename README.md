# Laufbursche Blade Mini (eKFV) unlock

A static web page that talks to a Teverun Blade Mini (eKFV) over Web Bluetooth. It toggles the speed lock live, sets wheel diameter and cruise and flashes firmware to the controller, straight from the browser. Nothing to install: no app store, no signing, no developer account. It runs in **Bluefy** on iOS and in **Chrome** on Android or desktop.

> **Lock/unlock mechanism (differs from the upstream trfm-unlock).** This build does NOT use the
> `0x1B` TESTLOCK command that needs patched firmware. It lifts/re-imposes the eKFV speed clamp via
> the scooter's own **cruise ("Tempomat") lever**, carried in the stock `0x18` settings frame (cruise
> bits in bytes 4 and 17). This was reverse-engineered from the native Teverun app v2.0.5
> (`uni.UNI2202FAB`), which serves both the Fighter Mini and Blade Mini eKFV, so the frame format is
> identical. Unlock writes cruise = auto (1); lock writes cruise = 0. It therefore works on **stock
> firmware**. This is unverified on hardware here — confirm on your own scooter.

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

**Guide: [Deutsch](GUIDE.de.md) | [English](GUIDE.en.md)** covers everything step by step, from the first connect to a flashed firmware.

## What it does

- **Unlock and lock live** over Bluetooth. A direct command to the controller, unrelated to the FIN or the Bluetooth name.
- **Flash firmware over Bluetooth**, in the browser, in about seven minutes. Every check on the file runs before the first byte leaves.
- **Wheel diameter and cruise**, stored on your device and written back automatically after an unlock.
- **Read what the controller reports:** its firmware version plus the build stamp of a Laufbursche firmware.
- **Home-screen shortcuts** that open the page already set to lock or unlock.

Hardware: the **IVCU hardware version 5.x** controller. Not the "Ali box".

## No firmware here

This repository ships no firmware. You bring the file: build one from the stock image of your own scooter with the [Laufbursche Firmware Patcher](https://laufbursche42.github.io/tr-fw/) or use a file you already have.

The manufacturer's firmware is the manufacturer's copyrighted work, so it is not ours to hand out. What the page does instead is check the file you supply (vendor trailer, checksum, target address) and refuse it in plain language before anything is sent to the scooter.

## Disclaimer

**Please read this in full before you flash anything or unlock a scooter.**

- **This is a feasibility study**, not a finished product. It shows what the scooter's Bluetooth protocol makes possible. Nothing here promises that it works with your scooter, your phone or your browser. Nothing promises it still works after the next controller firmware or browser release.
- **This page provides no firmware.** You choose the file, so nobody here can vouch for what you flash, where it came from or what it does to your scooter.
- **A patched firmware ends the road approval.** A scooter that no longer holds the eKFV limit is not a road-legal eKFV any more under the eKFV regulation and the StVZO. The operating permit (Betriebserlaubnis) is void. The insurance cover goes with it.
- **Ride it on private property only**, on closed grounds that are not public traffic space. Riding a derestricted scooter in public traffic is a criminal offence in Germany: no operating permit, no insurance. The liability is entirely yours.
- **An interrupted flash leaves a scooter that will not run** until a flash completes. It is recovered by flashing again. Keep the scooter on, the page open and the phone in range for the whole run.
- **Flashing can damage the controller.** Wrong file, wrong hardware or plain bad luck.
- **No liability**, as far as the law allows, for any damage caused by or with a firmware flashed through this page: damage to the scooter, to people or to third parties, fines, legal consequences or any other disadvantage.
- **No warranty** of function, correctness or fitness for a particular purpose.
- Everything you do with this page is **at your own risk**.

By flashing a firmware through this page and by using it, you accept these terms.

## License

PolyForm Noncommercial 1.0.0 with two additional terms, in full in [LICENSE.md](LICENSE.md).

## Privacy

Nothing leaves your device but the page load itself. The details are in [PRIVACY.md](PRIVACY.md).

## Trademarks

An independent project, not affiliated with Teverun. "Teverun" and other product names are trademarks of their respective owners and are used here only to say which scooters this page works with. See [TRADEMARKS.md](TRADEMARKS.md).
