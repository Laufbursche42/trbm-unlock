# Anleitung: Laufbursche Blade Mini (eKFV) unlock

> **Machbarkeitsstudie.** Dieses Werkzeug zeigt, was das Bluetooth-Protokoll eines Teverun-Rollers technisch moeglich macht, es ist kein fertiges Produkt. Fehlerfreier Betrieb wird nicht versprochen, es gibt keinerlei Gewaehrleistung. Was du hier tust, tust du auf eigenes Risiko.

## 1. Was du brauchst

Alles passiert im Browser ueber Web Bluetooth: verbinden, entsperren, sperren, Fehler und Batterie auslesen. Es gibt nichts zu installieren. Gebraucht wird nur:

**Einen Browser, der Web Bluetooth kann.**

- **iOS:** den Browser **Bluefy** (kostenlos im App Store). Safari und jeder andere iOS-Browser laufen auf der Safari-Engine, die ueberhaupt kein Web Bluetooth hat.
- **Android oder Desktop:** **Chrome** oder einen anderen Chromium-Browser. Web Bluetooth ist eingebaut, kein Extra-Browser noetig.

**Einen Teverun Blade Mini (eKFV).** Der Blade hat keine IVCU, sondern nur einen ESC mit MCU. Deshalb ist die eKFV-Drosselung dort keine Firmware-Sperre, sondern schlicht der Speed-Wert, den die App pro Gang schreibt.

---

## 2. Verbinden

1. Oeffne die Seite in Bluefy oder Chrome.
2. Schalte den Scooter ein. Er muss ein paar Meter neben dem Handy bleiben.
3. Tippe auf **Connect** und waehle deinen Scooter in der Auswahl des Browsers. In dieser Liste erscheinen nur Scooter.
4. Beobachte die Statusanzeige oben rechts: `connecting`, dann `linking`, dann `connected`. `connected` erscheint erst, wenn echte Telemetrie ankommt. Es heisst also, dass die Verbindung Daten traegt, nicht nur, dass der Funk sich einig war.

Danach fuellen sich die Anzeigen:

- **Speed/Gang:** der Speed-Wert des aktuell gewaehlten Gangs, so wie der Controller ihn meldet.
- **Aktuell gelesen:** die Zeile `Gang X | per-Gang Y | Max Z` zeigt live, was gerade im Controller steht.
- **Firmware version:** die Version, die der Controller meldet, auf der Serienfirmware zum Beispiel `R3.4.6`.

Kommt nichts an, meldet die Seite `no-data` und haelt die Verbindung offen. Der Scooter war dann ausser Reichweite oder im Schlaf: aufwecken, dann bleibt die Anzeige von allein stehen. Das allererste Verbinden braucht immer die Auswahl des Browsers. Das ist eine Sicherheitsregel des Browsers, die keine Verknuepfung ueberspringen kann.

---

## 3. Entsperren und sperren

Das ist der Kern. Der Blade wird nicht ueber die FIN, den Bluetooth-Namen oder ein Statusbit gesperrt, sondern ueber die **Speed-Werte pro Gang**. Die Original-App weigert sich bei einer TDE-FIN, hohe Werte zu schreiben. Diese Seite schreibt sie direkt.

In der Steuerungs-Karte stehen drei Felder fuer die deutschen Gaenge:

- **Gang 1** (Default 45), **Gang 2** (Default 60), **Gang 3** (Default 80).
- Diese drei Felder sind die **entsperrten** Speeds. Du kannst die Werte anpassen.
- Intern sind das die ESC-Gaenge 2, 3 und 4. Gang 1 und Gang 5 gibt es nur in der Auslandsvariante und werden nicht angefasst.

**Entsperren** schreibt die drei Werte auf die Gaenge. **Sperren** setzt alle drei zurueck auf **22**. Der Button traegt die passende Aktion: er heisst **Unlock**, solange gesperrt, und **Lock**, solange offen. Er ist bedienbar, sobald verbunden ist und der erste Telemetrie-Frame (`55 71`) angekommen ist.

Ein Hinweis zum Zustand: der Blade meldet den gesperrt/entsperrt-Zustand nicht sauber in der Telemetrie. Deshalb siehst du als Rueckmeldung die tatsaechlichen Werte in der Zeile **Aktuell gelesen** (per-Gang-Speed), nicht ein geratenes Schloss-Symbol.

Ein entsperrter Scooter gehoert auf Privatgelaende. Siehe den [Haftungsausschluss](README.md#disclaimer).

---

## 4. Fehlerberichte und Batterie-Infos

Beide Ansichten lesen nur mit, es wird nichts an den Scooter gesendet. Die Buttons werden aktiv, sobald verbunden ist und Frames ankommen.

- **Fehlerberichte:** die Fehlercodes, die Controller und BMS von selbst melden.
- **Batterie-Infos:** Pack-Spannung, Strom, Zellspannungen und Temperaturen, so wie der Controller sie berichtet.

---

## 5. Verknuepfung auf dem Startbildschirm

Eine Verknuepfung oeffnet die Seite bereits auf Sperren oder Entsperren gestellt: ein gekoppelter Scooter verbindet sich ohne Auswahl und die Aktion laeuft von selbst. Mach eine Verknuepfung fuer **Unlock** und eine fuer **Lock**. Der Entsperren-Shortcut schreibt die Default-Gangwerte (45/60/80).

### iOS (Bluefy)

Oeffne die App **Kurzbefehle**, erstelle einen Kurzbefehl, fuege die Aktion **URLs oeffnen** hinzu, setze den Link fuer Bluefy von der Seite ein und lege den Kurzbefehl auf den Startbildschirm oder gib ihm einen Siri-Satz. Ein reiner `https`-Link wuerde Safari oeffnen, das kein Bluetooth hat. Das Schema `bluefy://` oeffnet Bluefy.

### Android (Chrome)

Oeffne den Link von der Seite in Chrome, dann Menue und **Zum Startbildschirm hinzufuegen**. Web Bluetooth ist eingebaut, das Symbol oeffnet also direkt die Seite.

Der Scooter muss an und in Reichweite sein. Der allererste Besuch braucht weiterhin das einmalige **Connect** mit der Auswahl.

---

## 6. Grenzen, die man kennen sollte

- **Kein Hintergrundbetrieb.** Die Verbindung lebt nur, solange die Seite offen und im Vordergrund ist.
- **Wiederverbinden nur in der laufenden Sitzung.** Bricht die Funkstrecke ab, waehrend die Seite offen und im Vordergrund ist, verbindet sie von selbst neu. Nach dem Schliessen der Seite ist die Verbindung weg und du musst wieder **Connect** druecken. Nur eine Verknuepfung mit `?do=lock` oder `?do=unlock` verbindet beim Oeffnen ohne Auswahl neu.
- **iOS: immer Bluefy.** Ein Lesezeichen, das in Safari auf den Startbildschirm gelegt wird, oeffnet die Safari-Engine, die kein Bluetooth hat. Der Kurzbefehl mit dem `bluefy://`-Link ist der Weg zu einem Symbol auf dem Startbildschirm.
- **Nichts verlaesst dein Geraet** ausser dem Laden der Seite selbst. Einzelheiten in der [Datenschutzerklaerung](PRIVACY.de.md).

---

## 7. Recht

Lies den [Haftungsausschluss](README.md#disclaimer) vollstaendig, bevor du einen Scooter entsperrst. Kurz gefasst: ein entsperrter Blade haelt die eKFV-Grenze nicht mehr ein und ist damit keine strassenzugelassene eKFV mehr, die Betriebserlaubnis und der Versicherungsschutz entfallen. Der Scooter gehoert damit auf Privatgelaende. Alles, was du hier tust, tust du auf eigenes Risiko.
