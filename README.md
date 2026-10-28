![N|Solid](https://github.com/Darkspine77/Challonge-Bot/blob/master/challongebot.png)

# Challonge Vote Bracket Bot
Runs an existing Challonge bracket as a series of Discord polls. Every 24 hours (or whatever length you pick), the bot posts a poll for the next match. When it closes, whoever got the most votes wins that match on Challonge and the next poll goes up.

Based on Challonge-Bot by Darkspine77. Powered by the [Challonge API](https://api.challonge.com/v1) and [discord.js v14](https://discord.js.org). Needs Node.js 18 or newer.

## Files

| File | What it is |
| --- | --- |
| `index.js` | The bot: startup, setup and commands |
| `voting.js` | Runs the polls and updates the bracket |
| `challonge.js` | Talks to the Challonge API |
| `config.example.json` | Copy to `config.json` and fill in your keys |
| `vote-state.json` | Created automatically. Saves progress so restarts pick up where they left off |

## Setup

1. **Create the bot.** In the [Discord Developer Portal](https://discord.com/developers/applications), click New Application. On the **Bot** tab, click Reset Token and copy the token, then turn on **Message Content Intent**.
2. **Get a Challonge API key** at Challonge → Settings → Developer API. Brackets you vote on must be on this same Challonge account.
3. **Make `config.json`.** Copy `config.example.json` to `config.json` and paste in both keys. Never share or commit it.
   You can use the environment variables `DISCORD_TOKEN` and `CHALLONGE_API_KEY` instead of the file.
4. **Run it.** `npm install`, then `npm start`. The console prints an invite link with the right permissions, including **Create Polls**. Open it to add the bot to your server.

### Hosting on bot-hosting.net
- Create a **Node.js** server (Node 18 or newer).
- Upload `index.js`, `voting.js`, `challonge.js`, `package.json` and `config.json` in the File Manager. Don't upload `node_modules`; the host installs packages from `package.json`.
- Set the startup file to `index.js` and press Start.

## Using it

When the bot joins a server it creates:
- a **Tournament Manager** role. People with this role, or server admins, can start, skip and stop vote brackets.
- a **#tournament-commands** channel. The bot only answers commands posted there, but the polls can go in any channel.

Make the bracket on the Challonge website with whatever participants you like (pizza toppings, movies, anything), then:

```
c!vote start https://challonge.com/abc123
c!vote start Best_Pizza 24 #polls
```

You can use the bracket's link or its name (with `_` in place of spaces). The hours (1–168, default 24) and channel (default: this one) are optional.

- One match at a time. Most votes wins, and the vote counts are saved as the match score on Challonge.
- **Ties, including zero votes, go to the higher seed.**
- If the bracket hasn't been started on Challonge yet, the bot starts it.
- When the final is decided, the bot finalizes the bracket and announces the champion.
- If a poll gets deleted, the bot posts it again.

| Command | What it does |
| --- | --- |
| `c!help` | Shows the commands |
| `c!vote start (Name or link) [hours] [#channel]` | Starts running a bracket as polls |
| `c!vote status` | Lists running vote brackets and when each poll closes |
| `c!vote next (Name)` | Closes the current poll now and moves on |
| `c!vote stop (Name)` | Stops posting polls. The open poll isn't counted, and Challonge is left as it is |
