# Mineview

Local control panel for a Minecraft Java Edition server. It runs on your PC, talks to a server directory you choose, and does not replace or modify that installation unless you confirm the action.

## Requirements

- Windows 10 or later (the folder picker and “Open in Explorer” actions use Windows)
- Node.js 22 or newer
- A Minecraft Java server you already have (Paper, Purpur, Spigot, Bukkit, Folia, Fabric, Forge, NeoForge, or Vanilla)
- A Java runtime compatible with that Minecraft version

## Install and run

From this folder:

```powershell
npm install
npm test
npm run dev
```

Open `http://127.0.0.1:5173`. The API listens on `127.0.0.1:3847`. Vite proxies `/api` and `/ws` to it.

The first launch writes a password to `data/initial-password.txt` unless you set `MINEVIEW_INITIAL_PASSWORD` (at least 10 characters) before starting. Change it in Settings after you sign in. Copy `.env.example` to `.env` only if you want a different port or data directory.

Production, after a client build:

```powershell
npm run build
npm start
```

Then open `http://127.0.0.1:3847`.

## First-time setup

1. Sign in.
2. Enter the server directory, or scan common locations. Scanning only lists folders; it does not download or change a server.
3. Confirm the detected JAR (or Forge `win_args.txt`), Java executable, and memory.
4. Mineview does not set `eula=true`. Edit `eula.txt` yourself if you accept Mojang’s EULA.

Each profile stores its own directory, JAR, Java path, JVM arguments, and launch arguments.

## What the panel does

- Start, graceful stop, restart, and emergency kill for processes Mineview launched
- Live console over WebSockets, with commands written to the server’s stdin
- Dashboard metrics from the process, `server.properties`, logs, and the filesystem. Missing values stay “Unavailable”
- Modrinth, Hangar, and Spigot search. Spigot results come from the public Spiget index of SpigotMC. A release is Compatible only when that repository lists both this server platform and Minecraft version. Related platforms are Possibly compatible. Missing data stays Unknown. JARs download into `plugins` or `mods` and are not executed.
- Manual JAR upload (zip header check only; the JAR is never executed by the panel)
- Installed plugin list from the real plugin folder, including Open in Explorer
- Kick, ban, temporary ban, pardon, teleport, and private message through Minecraft commands when the console is attached
- Whitelist and operator edits, using the server command or the JSON files when the server is stopped
- Configuration editor with backups and a conflict check
- File manager limited to the server directory
- World listing, zip export, backup, and confirmed deletion while stopped
- Full, world, plugin, and config backups outside the server directory, plus restore
- Scheduled restart, backup, shutdown, startup, and console commands
- Optional crash restart and Discord webhook notifications
- Diagnostics for Java, directories, and backup storage

## Security

The panel binds to `127.0.0.1` until you enable remote access in Settings and restart. Non-loopback binding requires that confirmation. Sessions use an httpOnly cookie and a CSRF token. Filesystem operations are resolved inside the configured server directory or the backup folder. Downloads are limited to the Modrinth, GitHub, and Hangar hosts used by those repositories. Plugin JARs are not executed during install.

Do not put the panel on the public internet. A password is not a substitute for keeping the port on localhost.

## Limits

- Commands, kicks, and bans through the live console work only while Mineview still owns the process stdin. If the server was started outside Mineview, or Mineview was restarted while the server kept running, the panel tails `logs/latest.log` and will not send commands or kill that process unless the saved command line still matches a launch Mineview recorded.
- Temporary bans are a vanilla `ban` plus a scheduled `pardon`. Vanilla has no temporary-ban command.
- TPS, MSPT, and entity counts are not shown. The panel does not invent them.
- Permission plugins are detected by filename only. Their group files are not edited.
- LuckPerms-style permissions, Forge mixin graphs, and other server-specific APIs are not integrated beyond launch detection and the `plugins` or `mods` folder.
- “Open folder” uses `explorer.exe` on Windows.
- `multer` 1.4.5-lts.2 is still the upload parser. `npm audit` reports a high-severity advisory in the tree; the suggested fix is a breaking upgrade and has not been applied.

## Tests

```powershell
npm test
npm run typecheck
```

`npm test` covers path confinement, log parsing, the HTTP API against a fixture server directory, and the process lifecycle with a stand-in Java process. It does not download a Minecraft server JAR or join a public game.
