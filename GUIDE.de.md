# Anleitung: Laufbursche Blade Mini (eKFV) unlock

> **Machbarkeitsstudie.** Dieses Werkzeug zeigt, was das Bluetooth-Protokoll eines Teverun-Rollers technisch möglich macht, es ist kein fertiges Produkt. Fehlerfreier Betrieb wird nicht versprochen, es gibt keinerlei Gewährleistung. Was du hier tust, tust du auf eigenes Risiko.

## 1. Was du brauchst

Alles passiert im Browser über Web Bluetooth: verbinden, entsperren, sperren, Fehler und Batterie auslesen. Es gibt nichts zu installieren. Gebraucht wird nur:

**Einen Browser, der Web Bluetooth kann.**

- **iOS:** den Browser **Bluefy** (kostenlos im App Store). Safari und jeder andere iOS-Browser laufen auf der Safari-Engine, die überhaupt kein Web Bluetooth hat.
- **Android oder Desktop:** **Chrome** oder einen anderen Chromium-Browser. Web Bluetooth ist eingebaut, kein Extra-Browser nötig.

**Einen Teverun Blade Mini (eKFV).** Der Blade hat keine IVCU, sondern nur einen ESC mit MCU. Deshalb ist die eKFV-Drosselung dort keine Firmware-Sperre, sondern schlicht der Geschwindigkeitswert, den die App pro Gang schreibt.

---

## 2. Verbinden

1. Öffne die Seite in Bluefy oder Chrome.
2. Schalte den Scooter ein. Er muss ein paar Meter neben dem Handy bleiben.
3. Tippe auf **Connect** und wähle deinen Scooter in der Auswahl des Browsers. In dieser Liste erscheinen nur Scooter.
4. Beobachte die Statusanzeige oben rechts: `connecting`, dann `linking`, dann `connected`. `connected` erscheint erst, wenn echte Telemetrie ankommt. Es heißt also, dass die Verbindung Daten trägt, nicht nur, dass der Funk sich einig war.

Danach füllen sich die Anzeigen:

- **Speed aktueller Gang:** der Geschwindigkeitswert des gerade gewählten Gangs, so wie der Controller ihn meldet.
- **Firmware version:** die Version, die der Controller meldet, auf der Serienfirmware zum Beispiel `R3.4.6`.

Kommt nichts an, meldet die Seite `no-data` und hält die Verbindung offen. Der Scooter war dann außer Reichweite oder im Schlaf: aufwecken, dann bleibt die Anzeige von allein stehen. Das allererste Verbinden braucht immer die Auswahl des Browsers. Das ist eine Sicherheitsregel des Browsers, die keine Verknüpfung überspringen kann.

---

## 3. Entsperren und sperren

Das ist der Kern. Der Blade wird nicht über die FIN, den Bluetooth-Namen oder ein Statusbit gesperrt, sondern über die **Geschwindigkeitswerte pro Gang**. Die Original-App weigert sich bei einer TDE-FIN, hohe Werte zu schreiben. Diese Seite schreibt sie direkt.

In der Steuerungs-Karte stehen drei Felder für die deutschen Gänge:

- **Gang 1** (Standard 45), **Gang 2** (Standard 60), **Gang 3** (Standard 80).
- Diese drei Felder sind die **entsperrten** Geschwindigkeiten. Du kannst die Werte anpassen.
- Intern sind das die ESC-Gänge 2, 3 und 4. Gang 1 und Gang 5 gibt es nur in der Auslandsvariante und werden nicht angefasst.

**Entsperren** schreibt die drei Werte auf die Gänge. **Sperren** setzt alle drei zurück auf **22**. Der Knopf trägt die passende Aktion: er heißt **Unlock**, solange gesperrt, und **Lock**, solange offen. Er ist bedienbar, sobald verbunden ist und der erste Telemetrie-Frame (`55 71`) angekommen ist.

Ein Hinweis zum Zustand: der Blade meldet den Sperr-Zustand nicht sauber in der Telemetrie. Als Rückmeldung siehst du deshalb den tatsächlichen Geschwindigkeitswert des aktuellen Gangs, nicht ein geratenes Schloss-Symbol.

Ein entsperrter Scooter gehört auf Privatgelände. Siehe den [Haftungsausschluss](README.md#disclaimer).

---

## 4. Fehlerberichte und Batterie-Infos

Beide Ansichten lesen nur mit, es wird nichts an den Scooter gesendet. Die Knöpfe werden aktiv, sobald verbunden ist und Frames ankommen.

- **Fehlerberichte:** die Fehlercodes, die Controller und BMS von selbst melden.
- **Batterie-Infos:** Pack-Spannung, Strom, Zellspannungen und Temperaturen, so wie der Controller sie berichtet.

---

## 5. Verknüpfung auf dem Startbildschirm

Eine Verknüpfung öffnet die Seite bereits auf Sperren oder Entsperren gestellt: ein gekoppelter Scooter verbindet sich ohne Auswahl und die Aktion läuft von selbst. Mach eine Verknüpfung für **Unlock** und eine für **Lock**. Der Entsperren-Shortcut schreibt die Standard-Gangwerte (45/60/80).

### iOS (Bluefy)

Öffne die App **Kurzbefehle**, erstelle einen Kurzbefehl, füge die Aktion **URLs öffnen** hinzu, setze den Link für Bluefy von der Seite ein und lege den Kurzbefehl auf den Startbildschirm oder gib ihm einen Siri-Satz. Ein einfacher `https`-Link würde Safari öffnen, das kein Bluetooth hat. Das Schema `bluefy://` öffnet Bluefy.

### Android (Chrome)

Öffne den Link von der Seite in Chrome, dann Menü und **Zum Startbildschirm hinzufügen**. Web Bluetooth ist eingebaut, das Symbol öffnet also direkt die Seite.

Der Scooter muss an und in Reichweite sein. Der allererste Besuch braucht weiterhin das einmalige **Connect** mit der Auswahl.

---

## 6. Grenzen, die man kennen sollte

- **Kein Hintergrundbetrieb.** Die Verbindung lebt nur, solange die Seite offen und im Vordergrund ist.
- **Wiederverbinden nur in der laufenden Sitzung.** Bricht die Funkstrecke ab, während die Seite offen und im Vordergrund ist, verbindet sie von selbst neu. Nach dem Schließen der Seite ist die Verbindung weg und du musst wieder **Connect** drücken. Nur eine Verknüpfung mit `?do=lock` oder `?do=unlock` verbindet beim Öffnen ohne Auswahl neu.
- **iOS: immer Bluefy.** Ein Lesezeichen, das in Safari auf den Startbildschirm gelegt wird, öffnet die Safari-Engine, die kein Bluetooth hat. Der Kurzbefehl mit dem `bluefy://`-Link ist der Weg zu einem Symbol auf dem Startbildschirm.
- **Nichts verlässt dein Gerät** außer dem Laden der Seite selbst. Einzelheiten in der [Datenschutzerklärung](PRIVACY.de.md).

---

## 7. Recht

Lies den [Haftungsausschluss](README.md#disclaimer) vollständig, bevor du einen Scooter entsperrst. Kurz gefasst: ein entsperrter Blade hält die eKFV-Grenze nicht mehr ein und ist damit keine straßenzugelassene eKFV mehr, die Betriebserlaubnis und der Versicherungsschutz entfallen. Der Scooter gehört damit auf Privatgelände. Alles, was du hier tust, tust du auf eigenes Risiko.
