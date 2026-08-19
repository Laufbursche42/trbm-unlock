# Privacy Policy

This web app is built to keep your data on your device. This policy explains exactly what it does and does not do with your data.

## The short version

The app collects nothing. There are no accounts, no analytics, no telemetry, no tracking, no ads, no cookies and no third-party scripts. Nothing is ever sent to the developer or to any manufacturer backend.

## What data the app handles and where it stays

All of the following stays on your device and is never uploaded anywhere:

- Live scooter telemetry read over Bluetooth LE (speed, wheel diameter, cruise, FIN, etc.).
- Your saved settings: wheel diameter and cruise, stored in the browser's `localStorage` (only on your phone, for the restore-on-unlock feature).
- The on-screen log. It exists only in the open page during your session, is never stored and is never uploaded.

## The only network connection

The app makes network connections in exactly two cases and no others:

### 1. Loading the page

When you open or reload the page, your browser fetches the static files (`index.html`, `app.js`, `ota.js`, `i18n.js`, `styles.css` and the favicon) from the host (for example GitHub Pages). The host sees only two things: your **IP address** and which file you requested. Those are the normal web-server logs every website has. It **never** sees any scooter data, settings or FIN: not at page load, not at reload, not at any time. That data never reaches any server at all; it exists only on your phone and travels only over the local Bluetooth link (see below).

The page ships no firmware. A firmware file you pick for a flash is read by the browser on your device and sent to the scooter over Bluetooth. It is never uploaded anywhere.

### 2. Bluetooth LE to your scooter

A local radio link to your scooter over Web Bluetooth. This is not an internet connection: no data leaves your phone over the network for this. Telemetry, settings, the FIN and the lock/unlock commands travel only between your browser and the scooter.

## No developer or manufacturer backend

Nothing is ever sent to the developer or to any manufacturer backend. There is no cloud account and no server operated by this project that receives your data. For comparison: the original Teverun app uploads GPS, rides and error codes to the manufacturer backend. This app does none of that.

## Contact

For privacy questions, contact the author (Laufbursche) on GitHub: https://github.com/Laufbursche42
