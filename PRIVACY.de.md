# Datenschutzerklärung

Diese Webanwendung ist darauf gebaut, deine Daten auf deinem Gerät zu halten. Diese Erklärung sagt genau, was sie mit deinen Daten tut und was nicht.

## Kurz gefasst

Die Anwendung sammelt nichts. Es gibt keine Anmeldung, keine Statistik, keine Telemetrie, keine Verfolgung, keine Werbung, keine Cookies und keine Skripte von Dritten. Nichts geht an den Entwickler oder an ein Backend des Herstellers.

## Welche Daten die Anwendung verarbeitet und wo sie bleiben

Alles Folgende bleibt auf deinem Gerät und wird nirgendwohin hochgeladen:

- Die Telemetrie des Scooters, live über Bluetooth LE gelesen: Geschwindigkeit, Raddurchmesser, Tempomat, FIN und so weiter.
- Deine gespeicherten Einstellungen, also Raddurchmesser und Tempomat, im `localStorage` des Browsers. Sie liegen nur auf deinem Gerät und dienen dazu, die Werte nach einem Entsperren wiederherzustellen.
- Das Protokoll auf dem Bildschirm. Es lebt nur in der offenen Seite während deiner Sitzung, wird nicht gespeichert und nicht hochgeladen.

## Die einzige Netzverbindung

Die Anwendung baut in genau zwei Fällen eine Verbindung auf, in keinem anderen:

### 1. Laden der Seite

Wenn du die Seite öffnest oder neu lädst, holt dein Browser die statischen Dateien vom Anbieter, also `index.html`, `app.js`, `ota.js`, `i18n.js`, `styles.css` und das Symbol. Das ist zum Beispiel GitHub Pages. Der Anbieter sieht dabei zwei Dinge: deine **IP-Adresse** und welche Datei du abgerufen hast. Das sind die üblichen Zugriffsprotokolle, die jede Website hat. Er sieht **nie** Daten des Scooters, Einstellungen oder die FIN, weder beim Laden noch beim Neuladen noch sonst wann. Diese Daten erreichen überhaupt keinen Server. Sie liegen nur auf deinem Gerät und wandern nur über die lokale Bluetooth-Verbindung, siehe unten.

Die Seite liefert keine Firmware aus. Eine Firmware-Datei, die du zum Flashen auswählst, liest der Browser auf deinem Gerät und schickt sie über Bluetooth an den Scooter. Sie wird nirgendwohin hochgeladen.

### 2. Bluetooth LE zum Scooter

Eine lokale Funkverbindung zu deinem Scooter über Web Bluetooth. Das ist keine Internetverbindung, dafür verlassen keine Daten dein Gerät über das Netz. Telemetrie, Einstellungen, die FIN und die Befehle zum Sperren und Entsperren laufen ausschließlich zwischen deinem Browser und dem Scooter.

## Kein Backend des Entwicklers oder des Herstellers

Nichts geht an den Entwickler oder an ein Backend des Herstellers. Es gibt kein Konto in einer Cloud und keinen Server dieses Projekts, der deine Daten annimmt. Zum Vergleich: die Original-App von Teverun lädt Standortdaten, Fahrten und Fehlercodes zum Backend des Herstellers. Diese Anwendung tut nichts davon.

## Kontakt

Bei Fragen zum Datenschutz wende dich an den Autor (Laufbursche) auf GitHub: https://github.com/Laufbursche42
