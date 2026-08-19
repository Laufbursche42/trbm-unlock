# Laufbursche Blade Mini (eKFV) unlock

A static web page that talks to a Teverun Blade Mini (eKFV) over Web Bluetooth. It lifts and re-imposes the speed limit live, straight from the browser. Nothing to install: no app store, no signing, no developer account. It runs in **Bluefy** on iOS and in **Chrome** on Android or desktop.

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

- **Unlock and lock live** over Bluetooth. Unlock writes a high speed to the German gears (internal ESC gears 2, 3, 4), lock sets them all back to 22 km/h. The values are editable. Unrelated to the FIN or the Bluetooth name.
- **Error reports:** read the fault codes the controller and BMS stream by themselves.
- **Battery info:** pack voltage, current, cell voltages and temperatures the controller reports.
- **Controller firmware version**, as the controller reports it.
- **Home-screen shortcuts** that open the page already set to lock or unlock.

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
