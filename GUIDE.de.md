# Anleitung: Laufbursche Blade Mini (eKFV) unlock

> **Machbarkeitsstudie.** Dieses Werkzeug zeigt, was in der Firmware eines Teverun-Rollers technisch möglich ist, es ist kein fertiges Produkt. Fehlerfreier Betrieb wird nicht versprochen, es gibt keinerlei Gewährleistung. Was du hier baust und flashst, tust du auf eigenes Risiko.

## 1. Was du brauchst

Alles passiert im Browser über Web Bluetooth: verbinden, Firmware flashen, entsperren, sperren, Raddurchmesser und Tempomat einstellen. Es gibt nichts zu installieren. Gebraucht wird nur:

**Einen Browser, der Web Bluetooth kann.**

- **iOS:** den Browser **Bluefy** (kostenlos im App Store). Safari und jeder andere iOS-Browser laufen auf der Safari-Engine, die überhaupt kein Web Bluetooth hat.
- **Android oder Desktop:** **Chrome** oder einen anderen Chromium-Browser. Web Bluetooth ist eingebaut, kein Extra-Browser nötig.

**Einen Teverun Blade Mini (eKFV)** mit dem Controller der **IVCU-Hardware-Version 5.x**. Nicht die "Ali-Box".

**Eine eigene Firmware-Datei.** Diese Seite bringt keine mit. Woher sie kommt, steht in Abschnitt 4.

---

## 2. Verbinden

1. Öffne die Seite in Bluefy oder Chrome.
2. Schalte den Scooter ein. Er muss ein paar Meter neben dem Handy bleiben.
3. Tippe auf **Connect** und wähle deinen Scooter in der Auswahl des Browsers. In dieser Liste erscheinen nur Scooter.
4. Beobachte die Statusanzeige oben rechts: `connecting`, dann `linking`, dann `connected`. `connected` erscheint erst, wenn echte Telemetrie ankommt. Es heißt also, dass die Verbindung Daten trägt, nicht nur, dass der Funk sich einig war.

Danach füllen sich die Kacheln:

- **Wheel** und **Cruise**: was im Controller aktuell steht.
- **Firmware version**: die Version, die der Controller meldet, auf der Serienfirmware `R5.4.19`.
- **Laufbursche Version**: die Build-Nummer einer Laufbursche-Firmware, zum Beispiel `V44`. Auf einer Serienfirmware bleibt hier `-` stehen.

Kommt nichts an, meldet die Seite `no-data` und hält die Verbindung offen. Der Scooter war dann außer Reichweite oder im Schlaf: aufwecken, dann bleibt die Anzeige von allein stehen. Ein Scooter, der nach einem abgebrochenen Flash im Update-Modus steht, sendet ebenfalls keine Telemetrie. Genau deshalb bleibt die Verbindung stehen: der neue Flash läuft über dieselbe Verbindung. Das allererste Verbinden braucht immer die Auswahl des Browsers. Das ist eine Sicherheitsregel des Browsers, die keine Verknüpfung überspringen kann.

---

## 3. Auto-Off auf 30 Minuten stellen

Das machst du am Display des Scooters, **bevor** du flashst.

Ein Flash dauert etwa sieben Minuten. Ein Scooter, der sich mitten im Flash selbst abschaltet, muss neu geflasht werden, bevor er fährt. Gib ihm also eine Abschaltzeit, die den Flash bequem überdauert. 30 Minuten ist die richtige Wahl.

Zwei Dinge halten einen Flash außerdem am Leben:

- Lass die Seite auf dem Handy im **Vordergrund**. Die Bluetooth-Verbindung lebt nur, solange die Seite vorne ist, es gibt keinen Hintergrundbetrieb.
- Verhindere, dass sich der Bildschirm während des Flashs sperrt. Ein gesperrtes Handy kann die Seite anhalten.

---

## 4. Firmware-Datei besorgen

Diese Seite liefert keine Firmware aus, du bringst die Datei selbst mit. Hast du schon eine, kannst du gleich zu Abschnitt 5 springen.

Sonst baust du sie dir mit dem [Laufbursche Firmware Patcher](https://laufbursche42.github.io/tr-fw/). Du wählst dort das Serienabbild deines eigenen Scooters aus, der Patcher wendet die Patches im Browser an und gibt dir eine flashbare Intel-HEX zurück, benannt wie `AWIVCU_APP_R5_4_19_V44.hex`. Die Datei verlässt dein Gerät dabei nicht.

---

## 5. Firmware flashen

1. **Erst verbinden** (Abschnitt 2). Der Flash läuft über dieselbe Bluetooth-Verbindung.
2. Tippe im Bereich **Flash firmware** auf **Choose file** und wähle deine `.hex`.
3. **Lies, was die Seite über die Datei sagt.** Sie nennt die Firmware-Version aus dem Dateianhang, die Größe der Nutzdaten, die Anzahl der zu sendenden Pakete sowie die Prüfsumme, die sie berechnet hat. Ist die Datei nicht brauchbar, sagt sie in klaren Worten warum, zum Beispiel:
   - `not a firmware file: no data records or no vendor trailer`
   - `the file is damaged: CRC 1234 does not match the trailer 5678`
   - `this is not controller app firmware: the first packet targets 0x..., below the app base`

   Jede dieser Prüfungen läuft, bevor ein einziges Byte hinausgeht. Eine abgelehnte Datei lässt den Scooter also völlig unberührt.
4. Tippe auf **Flash**. Es öffnet sich eine Nachfrage mit dem, was gleich passiert. Setze darin das Häkchen, dass du den Haftungsausschluss gelesen hast, erst danach lässt sich **Verstanden, flashen** drücken. Den Text selbst öffnest du aus derselben Nachfrage heraus, ohne sie zu schließen.
5. Ab hier gilt: Scooter an, Seite offen und im Vordergrund, Handy neben dem Scooter.
6. Warte etwa sieben Minuten. Der Balken füllt sich, der Paketzähler steigt und das Log hält jeden Schritt fest.
7. Der Flash ist durch, wenn im Log `CRC correct, refresh complete` steht, gefolgt von `Upgrade over`.
8. Schalte den Scooter aus und wieder ein, verbinde erneut und lies die Zeile **Laufbursche Version**. Dort muss der Build stehen, den du geflasht hast. **Firmware version** bleibt auf `R5.4.19`, denn eine Laufbursche-Firmware ist genau diese Version mit angewendeten Patches.

### Was Fortschritt und Log dir sagen

Der Balken zeigt die Prozente und welches Paket von wie vielen unterwegs ist. Die Zeile darunter nennt den Schritt, in dem der Flasher steckt.

Das Log ist die ausführliche Mitschrift, die neueste Zeile oben. Ein gesunder Lauf sieht so aus, hier von alt nach neu:

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

Zeilen wie `Packet 57 stuck, re-sending (attempt 2)` oder `Packet 57 error (status 0x55, frame loss)` dazwischen sind der Flasher, der einen verlorenen Frame auf einer belegten Funkstrecke auffängt. Ein oder zwei davon sind kein Problem. Ein einzelnes Paket bekommt bis zu fünf Versuche und der ganze Lauf wird bis zu zwei Mal neu gestartet. Meldet der Flasher am Ende einen Fehler, sind ihm wirklich die Mittel ausgegangen.

---

## 6. Wenn ein Flash scheitert

**Der Zustand des Scooters:** der Controller steckt im Update-Modus und der Scooter fährt nicht, bis ein Flash durchläuft. Das holt man mit einem neuen Flash zurück. Dasselbe gilt nach einem Tipp auf **Cancel**, den das Log als `Cancelled. Flash again before riding, the scooter is in update mode.` festhält.

**Was zu tun ist:**

1. Lass den Scooter eingeschaltet. Hat er sich selbst abgeschaltet, schalte ihn wieder ein und prüfe, ob Auto-Off auf 30 Minuten steht.
2. Halte das Handy direkt neben den Scooter.
3. Tippe **Connect**, falls die Verbindung weg ist, dann **Choose file** und **Flash** mit derselben Datei.
4. Wiederhole das, bis ein Lauf durchgeht. Wie oft ein Controller geflasht werden darf, ist nicht begrenzt.

**Worauf die Fehlermeldung zeigt:**

| Meldung | Was sie meist bedeutet |
| --- | --- |
| `no response to the update request. Is the scooter on and in range?` | Der Controller hat den Start nie angenommen: Scooter aus, im Schlaf, zu weit weg oder nicht die IVCU-5.x-Hardware. |
| `the scooter disconnected` | Die Bluetooth-Verbindung ist mitten im Lauf abgerissen: Auto-Off, Abstand, gesperrter Handy-Bildschirm oder die Seite ist in den Hintergrund gerutscht. |
| `packet 57/182 failed repeatedly` oder `packet 57/182 got no response. Is the scooter on and in range?` | Zu viele verlorene Frames an dieser Stelle. Handy näher heran, dann neu flashen. |
| `the update timed out after 30 minutes` | Der Lauf steht endgültig. Fang bei Schritt 1 neu an. |

Hat die Seite stattdessen die Datei abgelehnt, ist nichts gesendet worden. Hol dir eine funktionierende Datei (Abschnitt 4), dann fang neu an.

---

## 7. Entsperren und sperren

Ein Button trägt die Aktion für den aktuellen Zustand. Er heißt **Unlock**, solange der Scooter gesperrt ist. Er heißt **Lock**, solange er offen ist.

- Der Zustand kommt live vom Scooter, nicht aus einer Vermutung. Bis der erste Telemetrie-Frame ihn liefert, steht auf dem Button `reading...` und er lässt sich nicht drücken.
- Sperren und Entsperren sind ein direkter Bluetooth-Befehl an den Controller (cmd 0x1B). Sie haben nichts mit der FIN, dem Bluetooth-Namen oder irgendeiner Identität zu tun.

Ein entsperrter Scooter gehört auf Privatgelände. Siehe den [Haftungsausschluss](README.md#disclaimer).

---

## 8. Raddurchmesser und Tempomat

Beides sitzt im Bereich **Settings**. Es wird bedienbar, sobald der Scooter seine Konfiguration gemeldet hat und **entsperrt** ist. Im gesperrten Zustand verwirft die Firmware so einen Schreibvorgang, deshalb bleiben die Felder inaktiv, statt einen Schreibvorgang vorzutäuschen.

**Wheel diameter**, in Zoll mit einer Dezimalstelle. Trage deinen echten Wert ein, dann **Set wheel**. Es ist ein einziger globaler Wert im Controller, ein Schreibvorgang gilt also für jeden Gang. Er kalibriert nur Tacho und Kilometerzähler, nie den Motorcontroller, deine echte Geschwindigkeit ändert sich dadurch nicht. Stell ihn hier oder in der [Laufbursche Edition App](https://github.com/Laufbursche42/tr-lb-edition) ein, nicht in der Original-App von Teverun.

**Cruise:** `Off`, `Auto` oder `Manual`, dann **Set cruise**. Die allermeisten Scooter können nur `Auto`, also stell es darauf. `Auto` hält das Tempo von selbst, sobald du es eine Weile gleich hältst.

Beide Werte liegen in diesem Browser auf diesem Gerät und werden nach einem Entsperren automatisch zurückgeschrieben. Nichts davon wird irgendwohin hochgeladen.

---

## 9. Verknüpfung auf dem Startbildschirm

Eine Verknüpfung öffnet die Seite bereits auf Sperren oder Entsperren gestellt: ein gekoppelter Scooter verbindet sich ohne Auswahl und die Aktion läuft von selbst. Mach eine Verknüpfung für **Unlock** und eine für **Lock**.

**Mach vorher einen sauberen Durchgang ohne Verknüpfung:** verbinden, einmal **Unlock** und **Lock** benutzen, einmal Raddurchmesser und Tempomat setzen. Erst ein solcher Durchgang legt diese Werte in den Browser, die das Entsperren der Verknüpfung dann zurückholt.

### iOS (Bluefy)

Öffne die App **Kurzbefehle**, erstelle einen Kurzbefehl, füge die Aktion **URLs öffnen** hinzu, setze den Link für Bluefy von der Seite ein und lege den Kurzbefehl auf den Startbildschirm oder gib ihm einen Siri-Satz. Ein reiner `https`-Link würde Safari öffnen, das kein Bluetooth hat. Das Schema `bluefy://` öffnet Bluefy.

### Android (Chrome)

Öffne den Link von der Seite in Chrome, dann Menü und **Zum Startbildschirm hinzufügen**. Web Bluetooth ist eingebaut, das Symbol öffnet also direkt die Seite.

Der Scooter muss an und in Reichweite sein. Der allererste Besuch braucht weiterhin das einmalige **Connect** mit der Auswahl.

---

## 10. Grenzen, die man kennen sollte

- **Kein Hintergrundbetrieb.** Die Verbindung lebt nur, solange die Seite offen und im Vordergrund ist.
- **Wiederverbinden nur in der laufenden Sitzung.** Bricht die Funkstrecke ab, während die Seite offen und im Vordergrund ist, verbindet sie von selbst neu. Nach dem Schließen der Seite ist die Verbindung weg und du musst wieder **Connect** drücken. Nur eine Verknüpfung mit `?do=lock` oder `?do=unlock` verbindet beim Öffnen ohne Auswahl neu.
- **iOS: immer Bluefy.** Ein Lesezeichen, das in Safari auf den Startbildschirm gelegt wird, öffnet die Safari-Engine, die kein Bluetooth hat. Der Kurzbefehl mit dem `bluefy://`-Link ist der Weg zu einem Symbol auf dem Startbildschirm.
- **Nichts verlässt dein Gerät** außer dem Laden der Seite selbst. Einzelheiten in der [Datenschutzerklärung](PRIVACY.de.md).

---

## 11. Recht

Lies den [Haftungsausschluss](README.md#disclaimer) vollständig, bevor du irgendetwas flashst. Kurz gefasst: eine gepatchte Firmware beendet die Betriebserlaubnis und den Versicherungsschutz, der Scooter gehört damit auf Privatgelände. Ein abgebrochener Flash hinterlässt einen Scooter, der nicht fährt, bis ein Flash durchläuft. Alles, was du hier tust, tust du auf eigenes Risiko.
