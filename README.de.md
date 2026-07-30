# tGD Pi Web

<p align="center">
  <a href="https://github.com/yhwangtw/tgd-pi-web/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/yhwangtw/tgd-pi-web/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=nextdotjs">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react">
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-TW.md">繁體中文</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.de.md"><strong>Deutsch</strong></a>
</p>

<p align="center">
  <a href="https://github.com/yhwangtw/tgd-pi-web/releases">Releases</a> ·
  <a href="https://github.com/yhwangtw/tgd-pi-web/issues">Fehler melden</a> ·
  <a href="https://github.com/yhwangtw/tgd-pi-web/issues">Funktion vorschlagen</a>
</p>

**Ein Browser-Arbeitsbereich für den Pi Coding Agent und den vollständigen tGD-Auslieferungsprozess.**

tGD Pi Web verwandelt lokale Pi-Sessions in ein visuelles Engineering-Cockpit: Unterhalte dich in Echtzeit mit dem Agenten, prüfe Dateien und Git-Änderungen, navigiere zwischen Branches, stelle Snapshots wieder her und verfolge den gesamten Weg von Map bis Release im Browser.

![Chat-Oberfläche von tGD Pi Web](./docs/screenshots/02-hero-chat.png)

## Warum tGD Pi Web?

Die Terminal-Oberfläche von Pi ist schnell und fokussiert. Dieses Projekt ergänzt den visuellen Kontext, der für längere oder parallele Arbeiten hilfreich ist:

- Streaming-Ausgabe, Laufstatus, verstrichene Zeit, Fehler, Nachrichtenwarteschlange und Context-Auslastung auf einen Blick.
- Alle lokalen Pi-Sessions durchsuchen, ohne eine AgentSession zu starten.
- Dateien, Diffs, Tool-Aufrufe und Git-Änderungen direkt neben dem Gespräch prüfen.
- tGD-Artefakte und alle sieben Auslieferungsphasen im selben Arbeitsbereich verfolgen.
- Lange Gespräche mit Suche, Lesezeichen, Minimap und Branches navigieren.
- Auf Smartphone und Desktop komfortabel arbeiten – mit Safe-Area-Navigation, kompakter Pipeline und touch-freundlichen Nachrichtenaktionen.
- Local-first: Zur Laufzeit sendet die Anwendung keine externen Anfragen außer an den von dir konfigurierten Modell-Endpunkt.

## Für wen ist das gedacht?

- Entwicklerinnen und Entwickler, die bereits den [Pi Coding Agent](https://github.com/earendil-works/pi) verwenden.
- Teams mit tGD-Workflow, deren Artefakte in einem benachbarten Verzeichnis `<project>-tGD/` liegen.
- Engineers, die eine Browser-Oberfläche zur Kontrolle und Prüfung lokaler Agentenläufe wünschen.
- Offline- und Unternehmensumgebungen mit internem Modell-Gateway und npm-Registry.

## Schnellstart

### Voraussetzungen

- Node.js 22 oder neuer
- npm
- Eine funktionierende Pi-Einrichtung mit `~/.pi/agent/`
- Git

Dieses Projekt wird als GitHub-Quellcode verteilt und **nicht auf npm veröffentlicht**.

> [!IMPORTANT]
> tGD Pi Web kann Dateien in erlaubten Workspaces lesen und bearbeiten, Git-Repositories prüfen und Shell-Befehle ausführen. Verwende es standardmäßig nur auf localhost. Für Remote-Zugriff müssen `PIWEB_ACCESS_PASSWORD` gesetzt und der Dienst hinter einem authentifizierten privaten Netzwerk oder Access Proxy betrieben werden. Weitere Informationen stehen im [Deployment-Leitfaden](./deploy/README.md).

Verwende für die unterstützte Ein-Schritt-Installation einen eigenen Checkout:

```bash
git clone https://github.com/yhwangtw/tgd-pi-web.git
cd tGD-pi-web
bash setup.sh
```

In einem Git-Checkout ersetzt das Setup-Skript zuerst die lokale Quelle durch `origin/main`. Danach prüft es Node.js und npm, installiert Abhängigkeiten, führt die TypeScript-Validierung aus, erstellt den Production-Build und kann den Production-Server starten. Bei Quellarchiven werden bekannte veraltete Dateien vor dem Build nach `~/.tgd-pi-web-backups/` verschoben; der Pfad lässt sich mit `TGD_SETUP_BACKUP_DIR` ändern.

> [!WARNING]
> Für Git-Installationen von Endanwendern ist `origin/main` die einzige Quelle der Wahrheit. `bash setup.sh` führt `git reset --hard origin/main` und `git clean -fd` aus. Lokale Commits, getrackte Änderungen und nicht ignorierte untracked Dateien werden verworfen. Ignorierter Runtime-State wie `.env`, `node_modules` und `.next` bleibt erhalten.

Manuelle Einrichtung:

```bash
npm install
npm run build
npm start
```

Öffne [http://localhost:30141](http://localhost:30141).

### Vorhandenen Checkout aktualisieren

```bash
bash setup.sh
```

Für einen bewusst offline verwendeten Git-Checkout überspringt `TGD_SETUP_OFFLINE=1 bash setup.sh` die Remote-Synchronisierung.

## tGD-Workflow im Browser

Die Phasenleiste bleibt über der aktiven Session sichtbar:

```text
Map → Define → Plan → Develop → Verify → Review → Release
```

- **Artefaktbasierter Status** — Map, Define und Plan werden anhand echter Dateien auf dem Datenträger abgeschlossen, nicht anhand eines optimistischen UI-Status.
- **Feature-bezogener Fortschritt** — die Leiste folgt dem Feature aus dem letzten `/tgd-*`-Befehl oder dem zuletzt aktualisierten Feature.
- **Artefakt-Explorer** — durchsuche kuratierte Phasendokumente oder das vollständige benachbarte tGD-Verzeichnis einschließlich Scans, Wiki-Seiten und Prototypen.
- **Phasenaktionen mit Vorschau** — ein Klick auf eine Phase setzt den zugehörigen Befehl in den Composer, sodass du ihn vor dem Senden prüfen kannst.
- **Git-Wiederherstellungspunkte** — vor jedem Lauf wird ein Git-basierter Snapshot erstellt, ohne deinen Index oder `HEAD` zu verändern.

Erwartete Verzeichnisstruktur:

```text
parent/
├── your-project/
└── your-project-tGD/
    ├── CONTEXT.md
    ├── TRACKING-PLAN.md
    ├── wiki/
    └── feature-name/
        ├── PRD.md
        ├── SPEC.md
        ├── DESIGN.md
        ├── TASKS.md
        ├── METRICS.md
        └── prototype/
```

Setze `TGD_DIR`, wenn das Artefaktverzeichnis an einem anderen Ort liegt.

## Oberfläche

<p align="center">
  <img src="./docs/screenshots/11-mobile-chat.png" alt="Responsive mobile Gesprächsansicht" width="390">
</p>

Das mobile Layout hält aktive Phase, Gespräch, Composer, Modellsteuerung und Hauptnavigation in Daumenreichweite und berücksichtigt die Safe Areas des Geräts.

| Session- und Datei-Arbeitsbereich | Befehlspalette |
|---|---|
| ![Code-Session](./docs/screenshots/03-code-session.png) | ![Befehlspalette](./docs/screenshots/04-command-palette.png) |

| Dunkelmodus | Leerer Zustand |
|---|---|
| ![Dunkelmodus](./docs/screenshots/10-dark-mode.png) | ![Leerer Zustand](./docs/screenshots/01-empty-state.png) |

<details>
<summary><strong>Alle fünf Appearance-Skins anzeigen</strong></summary>

| Editorial | Terminal | Aurora |
|---|---|---|
| ![Editorial skin](./docs/screenshots/05-skin-editorial.png) | ![Terminal skin](./docs/screenshots/06-skin-terminal.png) | ![Aurora skin](./docs/screenshots/07-skin-aurora.png) |

| Industrial | Glass |
|---|---|
| ![Industrial skin](./docs/screenshots/08-skin-industrial.png) | ![Glass skin](./docs/screenshots/09-skin-glass.png) |

</details>

## Hauptfunktionen

### Agenten-Chat

- SSE-Livestreaming mit Verbindungsaufbau vor dem Prompt.
- Prompt, Steer, Follow-up-Warteschlange, Retry, Bash und Context Compaction.
- Direkter Shell-Modus mit `!command`; `!!command` lässt das Ergebnis aus dem Modellkontext.
- Wechsel von Modell und Thinking Level während einer Session.
- Integriertes `ask_user`-Tool sowie Pi-Extension-Dialoge (`select`, `confirm`, `input` und `editor`), Benachrichtigungen, Statusanzeigen und Text-Widgets; ausstehende Entscheidungen bleiben bei einer Neuverbindung erhalten.
- Fehlerkarten pro Lauf, Stall-Warnungen, Benachrichtigungen, Abschlusston und Tab-Status.
- Frühere Turns bearbeiten, vom vorherigen Verzweigungspunkt erneut ausführen, unabhängige Forks und In-Session-Branches.

### Geplante Agenten

- Das Schedule Center in der linken Leiste unterstützt einmalige, tägliche, wöchentliche und fünfteilige Cron-Zeitpläne mit expliziter IANA-Zeitzone.
- Projekt, Prompt, Modell, Thinking Level, Tool-Zugriff, Verhalten bei verpassten Läufen und Aktivierung lassen sich festlegen; Pausieren, Fortsetzen, Sofortausführung, Wiederholung und Verlauf befinden sich in einem Panel.
- Jeder Lauf erzeugt eine normale lokale Pi-Session. Benötigt `ask_user` eine Entscheidung, wechselt der Lauf auf **Wartet auf Eingabe** und öffnet direkt diese Session.
- Der Scheduler läuft im lokalen Node-Server, der aktiv bleiben muss. Nach einem Neustart wird je nach Richtlinie einmal nachgeholt oder übersprungen; überlappende Läufe werden nie gestartet.

### Sessions und Navigation

- Inkrementeller, schreibgeschützter Index lokaler Pi-`.jsonl`-Dateien.
- Suche, Tags, Pins, Archiv, automatische Benennung, HTML/Markdown-Export und Nutzungsanalyse.
- Gesprächssuche, User-Turn-Navigation, Lesezeichen, Minimap, Einklappen langer Nachrichten und optionaler Always-follow-Stream.
- Project Switcher mit zuletzt verwendeten Projekten, Pins, Discovery, Dateisystem-Vervollständigung und verknüpften Git-Worktrees.
- Wiederverwendbare Prompt-Vorlagen zusammen mit integrierten `/tgd-*`-Befehlen.

### Dateien und Git

- Projektbaum, rekursive Dateinamensuche, Textbearbeitung, Markdown/HTML/Bildvorschau und anklickbare Dateipfade im Chat.
- Git-Status-Badges, Working-Tree-Übersicht, Statistiken je Datei und Diffs zwischen `HEAD` und Worktree.
- Darstellung von `edit`- und `write`-Tool-Aufrufen als Diff oder Dateiinhalt statt als Roh-JSON.
- Allowed-root-Prüfungen, Pfadschutz, Git-Aufrufe mit `execFile` und Größenlimits für Datei- und Git-APIs.
- Snapshot Restore wendet nur das genaue Delta an und überschreibt weder den Benutzerindex noch `HEAD`.

### Darstellung und Erscheinungsbild

- GitHub Flavored Markdown, Tabellen, Task-Listen, KaTeX, Mermaid und verzögert geladenes Syntax-Highlighting.
- Editorial, Terminal, Industrial, Aurora und Glass, jeweils mit hellem und dunklem Modus.
- Mitgelieferte Schriften Inter, JetBrains Mono und Noto Sans TC ohne CDN-Abhängigkeit.
- UI-Sprachen der Anwendung: English und 繁體中文. Diese Projektdokumentation ist zusätzlich auf Japanisch und Deutsch verfügbar.

## Tastenkürzel

| Tasten | Aktion |
|---|---|
| `⌘/Ctrl + K` | Befehlspalette öffnen |
| `⌘/Ctrl + P` | Project Switcher öffnen |
| `⌘/Ctrl + F` | Im Gespräch suchen |
| `⌥ + ↑` / `⌥ + ↓` | Vorheriger / nächster User Turn |
| `⇧⌘M` | Models öffnen |
| `⌘/Ctrl + /` | Skills öffnen |
| `⌘/Ctrl + B` | Kontextpanel umschalten |
| `⌘/Ctrl + \` | Rechtes Dateipanel umschalten |
| `↑` im leeren Composer | Vorherige Nachricht abrufen |
| `Esc` | Aktiven Dialog schließen |

## Befehle

| Befehl | Zweck |
|---|---|
| `bash setup.sh` | Lokalen Quellstand durch `origin/main` ersetzen, prüfen, installieren, bauen und Production optional starten |
| `npm run dev` | Optional den Entwicklungsserver auf Port `30141` starten |
| `node_modules/.bin/tsc --noEmit` | Typecheck |
| `npx eslint .` | Lint |
| `npm test` | Vitest Unit Tests ausführen |
| `npm run test:e2e` | Build erstellen und Playwright E2E auf Port `30177` ausführen |
| `npm run build` | Production Build erstellen |
| `npm run start` | Production Server starten |

> [!WARNING]
> Beende `npm run dev`, bevor du `npm run build` oder `npm run test:e2e` ausführst. Ein gleichzeitiger Next.js Build beschädigt das vom Entwicklungsserver verwendete `.next/`-Verzeichnis.

Playwright wird absichtlich ad hoc installiert und nicht in `package.json` gespeichert:

```bash
npm i -D --no-save @playwright/test
npm run test:e2e
```

Für einen lokalen Container mit vorinstalliertem Chromium:

```bash
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e
```

## Konfiguration

| Einstellung | Verhalten |
|---|---|
| `PI_CODING_AGENT_DIR` | Überschreibt das Standardverzeichnis `~/.pi/agent` |
| `PIWEB_ACCESS_PASSWORD` | Aktiviert das integrierte gemeinsame Passwort-Gate für alle Routes |
| `TGD_DIR` | Überschreibt das benachbarte Artefaktverzeichnis `<project>-tGD/` |
| `models.json` | Modell-/Provider-Katalog einschließlich benutzerdefinierter `baseUrl`-Werte |
| `auth.json` | Von Pi verwaltete API-Zugangsdaten je Provider |
| Project Picker | Wählt und validiert das aktive Working Directory |

Session-Dateien bleiben im nativen Pi-Format:

```text
~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

## Architektur

```text
Browser                    Next.js server                 AgentSession
  │                              │                            │
  ├─ GET /api/sessions ─────────▶│ incremental .jsonl cache   │
  ├─ POST /api/agent/[id] ──────▶│ startRpcSession() ────────▶│
  ├─ GET /events (SSE) ─────────▶│◀──── session events ───────│
  ├─ GET /api/files/* ──────────▶│ allowed-root file access   │
  ├─ GET /api/git/* ────────────▶│ guarded git inspection     │
  └─ GET /api/tgd/artifacts ────▶│ sibling tGD directory      │
```

Beim schreibgeschützten Browsen werden Session-Dateien analysiert, ohne eine `AgentSession` zu erstellen. Erst beim Senden einer Nachricht erzeugt der Server einen In-Process-Wrapper pro aktiver Session und streamt Ereignisse über SSE.

## Projektstruktur

```text
app/api/        Sessions, Agent Commands/Events, Zeitpläne, Dateien, Git, tGD, Config
components/     Layout, Chat, Sidebar, Modals und gemeinsame UI
hooks/          Agent Orchestration, Streaming, Scrolling, Sessions, Theme
lib/            RPC Lifecycle, Scheduling, Session Parsing, Security, i18n, Snapshots
e2e/            Playwright Production-Server-Szenarien
docs/           Screenshots und Projektdokumentation
public/fonts/   Mitgelieferte lokale Schriften
```

Ausführliche Architektur, Invarianten und Entwicklungsfallen stehen in [`AGENTS.md`](./AGENTS.md).

## Offline- und Air-Gapped-Betrieb

Die Browser-Anwendung stellt zur Laufzeit keine externen Anfragen. Schriften und UI-Assets sind enthalten. Nur der konfigurierte LLM-Endpunkt muss erreichbar sein.

- **Interne npm registry:** Repository klonen oder ein Quellarchiv aus einem GitHub Release verwenden, npm für die interne Registry konfigurieren und `npm ci && npm run build` ausführen.
- **Portables Verzeichnis:** auf einem vernetzten System mit gleichem Betriebssystem und gleicher Architektur `npm ci && npm run build` ausführen, das gesamte Verzeichnis kopieren und anschließend `npm run start` starten.
- **Internes oder lokales Modell:** in `models.json` eine benutzerdefinierte Provider-`baseUrl` setzen.

`npm ci` bleibt für reproduzierbare CI- und Offline-Builds erhalten; interaktive Entwicklung verwendet `npm install`.

## FAQ

### Wird dieses Projekt als npm-Paket veröffentlicht?

Nein. Installiere und aktualisiere es aus dem GitHub-Repository oder einem GitHub-Release-Quellarchiv.

### Ersetzt es Pi?

Nein. Es ist eine lokale Browser-Oberfläche über Pi-Session-Dateien und die Agent Runtime. Pi bleibt der zugrunde liegende Coding Agent.

### Lädt die Anwendung meine Sessions hoch?

Das Projekt enthält kein gehostetes Session-Backend. Es liest lokale Pi-Dateien und kontaktiert nur die von dir konfigurierten Modell- oder Provider-Endpunkte.

### Laufen Zeitpläne weiter, wenn tGD Pi Web beendet ist?

Nein. Der Scheduler läuft im lokalen Node-Server. Für pünktliche Ausführungen muss `npm start` aktiv bleiben. Nach einem Neustart holt jeder Zeitplan gemäß seiner Richtlinie einmal nach oder überspringt den verpassten Lauf.

### Warum steht Playwright nicht in `package.json`?

Sein transitives Postinstall kann Browser-Binärdateien herunterladen und `npm ci` in Offline- oder Nexus-Umgebungen beschädigen. CI installiert es vor E2E mit `--no-save`.

### Warum bleibt eine Session-Datei nach dem Compact lang?

Compaction fügt eine Zusammenfassung hinzu und behält den neuesten Teil der Unterhaltung. Die ursprüngliche Historie wird nicht aus der `.jsonl`-Datei gelöscht. Die UI folgt dem aktiven Branch und dem Compaction Entry von Pi.

## Mitwirken

Issues und Pull Requests sind willkommen.

1. Repository forken und einen fokussierten Branch erstellen.
2. Für die Entwicklung `npm install` verwenden.
3. Typecheck, Lint und Tests ausführen.
4. Bei Verhaltensänderungen Tests ergänzen oder aktualisieren.
5. Bei Änderungen an Setup oder sichtbaren Funktionen alle vier README-Dateien synchron halten.

Übersetzungen der Anwendung liegen in `lib/i18n.tsx`. Neue Skins müssen semantische Design-Tokens verwenden, statt Farben in Komponenten fest zu codieren.

## Release

Nachdem ein PR die CI bestanden hat und gemergt wurde, wird der schnelle Release-Ablauf gestartet:

```bash
gh workflow run release.yml -f tag=vYYYY.MM.DD
```

Ein einzelner Workflow aktualisiert `package.json` und `package-lock.json`, erstellt den Release-Commit und ein annotiertes Tag und veröffentlicht anschließend das GitHub Release. Sein authentifizierter Push startet keinen weiteren CI-Lauf. Das Pushen eines bereits versionierten `v*`-Tags wird weiterhin unterstützt. Der Workflow veröffentlicht **nicht auf npm**.

## Lizenz

MIT — siehe [`LICENSE`](./LICENSE).
