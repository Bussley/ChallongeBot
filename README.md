![N|Solid](https://github.com/Darkspine77/Challonge-Bot/blob/master/challongebot.png)

# Challonge-Bot by Darkspine77 (v 1.0)
A Discord bot that lets you create and run Challonge tournaments from your server.

Powered by the [Challonge API](https://api.challonge.com/v1) and [discord.js v14](https://discord.js.org). Needs Node.js 18 or newer.

## Files

| File | What it is |
| --- | --- |
| `index.js` | The bot |
| `challonge.js` | Talks to the Challonge API |
| `time.js` | Reads start times in your time zone |
| `config.example.json` | Copy to `config.json` and fill in your keys |
| `index.old.js` | The original 2017 version, kept for reference (not used) |

## Setup

1. **Create the bot.** In the [Discord Developer Portal](https://discord.com/developers/applications), click New Application. On the **Bot** tab, click Reset Token and copy the token, then turn on **Message Content Intent**.
2. **Get a Challonge API key** at Challonge → Settings → Developer API.
3. **Make `config.json`.** Copy `config.example.json` to `config.json` and paste in both keys. `timeZone` is the time zone the start times you type are read in (e.g. `America/New_York`). Never share or commit `config.json`.
   You can use the environment variables `DISCORD_TOKEN`, `CHALLONGE_API_KEY` and `TIMEZONE` instead of the file.
4. **Run it.** `npm install`, then `npm start`. The console prints an invite link with the right permissions. Open it to add the bot to your server.

### Hosting on bot-hosting.net
- Create a **Node.js** server (Node 18 or newer).
- Upload `index.js`, `challonge.js`, `time.js`, `package.json` and `config.json` in the File Manager. Don't upload `node_modules`; the host installs packages from `package.json`.
- Set the startup file to `index.js` and press Start.

## Using it

When the bot joins a server it creates:
- a **Tournament Manager** role. Only people with this role, or server admins, can create tournaments.
- a **#tournament-commands** channel. The bot only answers commands posted there.

In Server Settings → Roles, keep the bot's own role **above** the roles it creates, otherwise it can't hand them out.

Each tournament gets an **Owner - (name)** role, given to whoever created it, and a **Participant - (name)** role. The owner, or a server admin, can start, edit, delete and report scores. When the last match is reported, the tournament is finalized on Challonge, the champion gets a **Winner - (name)** role, and the owner and participant roles are removed.

## Commands
Use `_` in place of spaces in names, e.g. `Brawlhalla_Tourney`. Times are Year-Month-Day-Hour-Minute on a 24-hour clock.

| Command | Example |
| --- | --- |
| `c!help` | |
| `c!create (Name) (Game) (Start time) (limit-N \| free)` | `c!create Brawlhalla_Tourney Brawlhalla 2026-11-07-18-30 limit-16` |
| `c!join (Name)` / `c!leave (Name)` | `c!join Brawlhalla_Tourney` |
| `c!info (Name)` / `c!bracket (Name)` | `c!info Brawlhalla_Tourney` |
| `c!start (Name)`: starts it and DMs players their first match | `c!start Brawlhalla_Tourney` |
| `c!match (Name) [Match #]`: your current match, or a specific one | `c!match Brawlhalla_Tourney 3` |
| `c!report (Name) (Match #) (P1-P2 score) [true]`: `true` makes it final and advances the winner | `c!report Brawlhalla_Tourney 1 2-1 true` |
| `c!edit (Name) (name \| game \| date \| limit) (New value)` | `c!edit Brawlhalla_Tourney limit limit-32` |
| `c!delete (Name)` | `c!delete Brawlhalla_Tourney` |
