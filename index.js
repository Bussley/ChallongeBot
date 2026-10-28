'use strict';

const fs = require('fs');
const path = require('path');
const {
	Client, GatewayIntentBits, Events, ChannelType, PermissionFlagsBits, EmbedBuilder,
} = require('discord.js');
const { Challonge, ChallongeError } = require('./challonge');
const { parseStartTime, isValidTimeZone } = require('./time');

const PREFIX = 'c!';
const MANAGER_ROLE = 'Tournament Manager';
const COMMAND_CHANNEL = 'tournament-commands';
const ROLE_COLOR = 0xFF7324;
// View Channels, Send Messages, Embed Links, Read Message History, Manage Roles, Manage Channels
const INVITE_PERMISSIONS = '268520464';

// ---------------------------------------------------------------- config

function loadConfig() {
	let file = {};
	const configPath = path.join(__dirname, 'config.json');
	if (fs.existsSync(configPath)) {
		try {
			file = JSON.parse(fs.readFileSync(configPath, 'utf8'));
		} catch (err) {
			console.error(`config.json is not valid JSON: ${err.message}`);
			process.exit(1);
		}
	}
	const config = {
		discordToken: process.env.DISCORD_TOKEN || file.discordToken,
		challongeApiKey: process.env.CHALLONGE_API_KEY || file.challongeApiKey,
		timeZone: process.env.TIMEZONE || file.timeZone || 'America/Los_Angeles',
	};
	const missing = [];
	if (!config.discordToken || config.discordToken.startsWith('PASTE')) missing.push('discordToken');
	if (!config.challongeApiKey || config.challongeApiKey.startsWith('PASTE')) missing.push('challongeApiKey');
	if (missing.length) {
		console.error(`Missing ${missing.join(' and ')}. Put them in config.json (see config.example.json).`);
		process.exit(1);
	}
	if (!isValidTimeZone(config.timeZone)) {
		console.error(`"${config.timeZone}" is not a valid time zone. Use a name like "America/Los_Angeles".`);
		process.exit(1);
	}
	return config;
}

// ---------------------------------------------------------------- helpers

// An error whose message is shown to the user as-is (bad usage, not found, etc).
class UserError extends Error {}

const spaced = text => String(text).replace(/_/g, ' ').trim();

function usage(text) {
	return new UserError(`Usage: \`${text}\` — type \`c!help\` for examples.`);
}

function findRole(guild, name) {
	return guild.roles.cache.find(r => r.name === name);
}

async function findOrCreateRole(guild, name) {
	return findRole(guild, name) || guild.roles.create({ name, color: ROLE_COLOR, mentionable: true });
}

function hasRole(member, name) {
	return member.roles.cache.some(r => r.name === name);
}

function isAdmin(member) {
	return member.permissions.has(PermissionFlagsBits.Administrator);
}

function canManage(member) {
	return hasRole(member, MANAGER_ROLE) || isAdmin(member);
}

function isOwner(member, tournament) {
	return hasRole(member, `Owner - ${tournament.name}`) || isAdmin(member);
}

function requireOwner(message, tournament) {
	if (!isOwner(message.member, tournament)) {
		throw new UserError(`Only the owner of **${tournament.name}** can do that.`);
	}
}

async function requireTournament(challonge, nameArg) {
	const tournament = await challonge.findTournament(nameArg);
	if (!tournament) throw new UserError(`I couldn't find a tournament called **${spaced(nameArg)}**.`);
	return tournament;
}

function parseCap(text) {
	const value = String(text).toLowerCase();
	if (value === 'free' || value === 'none' || value === 'unlimited') return null;
	const m = /^(?:limit-)?(\d+)$/.exec(value);
	if (!m || Number(m[1]) < 2) return undefined;
	return Number(m[1]);
}

function mention(participant) {
	if (!participant) return 'TBD';
	return participant.misc ? `<@${participant.misc}>` : participant.name;
}

function matchNumber(match) {
	return match.suggested_play_order ?? match.identifier;
}

function describeMatch(match, byId, { mentions = true } = {}) {
	const show = id => {
		const p = byId.get(id);
		if (!p) return 'TBD';
		return mentions ? mention(p) : p.name;
	};
	let text = `Match ${matchNumber(match)}: ${show(match.player1_id)} vs ${show(match.player2_id)}`;
	if (match.state === 'complete') {
		text += ` — finished${match.scores_csv ? ` (${match.scores_csv})` : ''}, winner ${show(match.winner_id)}`;
	} else if (match.state === 'open') {
		text += match.scores_csv ? ` — current score ${match.scores_csv}` : ' — ready to play, no score reported yet';
	} else {
		text += ' — waiting on earlier matches';
	}
	return text;
}

function openMatchFor(matches, participantId) {
	return matches.find(m => m.state === 'open' && (m.player1_id === participantId || m.player2_id === participantId));
}

// DMs both players of each given match. DMs can fail (closed DMs) — that's fine.
async function dmMatches(client, tournament, matchList, byId) {
	for (const match of matchList) {
		const text = `Your next match in **${tournament.name}** is ready!\n${describeMatch(match, byId)}`;
		for (const id of [match.player1_id, match.player2_id]) {
			const player = byId.get(id);
			if (!player || !player.misc) continue;
			try {
				const user = await client.users.fetch(player.misc);
				await user.send(text);
			} catch {
				// user has DMs turned off
			}
		}
	}
}

async function deleteTournamentRoles(guild, tournament) {
	for (const prefix of ['Owner - ', 'Participant - ']) {
		const role = findRole(guild, prefix + tournament.name);
		if (role) await role.delete().catch(err => console.error(`Could not delete role ${role.name}: ${err.message}`));
	}
}

// ---------------------------------------------------------------- server setup

// Makes sure the Tournament Manager role and #tournament-commands channel exist.
async function ensureSetup(guild) {
	await guild.roles.fetch();
	await guild.channels.fetch();

	if (!findRole(guild, MANAGER_ROLE)) {
		await guild.roles.create({ name: MANAGER_ROLE, color: ROLE_COLOR, mentionable: true, reason: 'Challonge bot setup' });
		console.log(`  created the ${MANAGER_ROLE} role in ${guild.name}`);
	}

	let channel = guild.channels.cache.find(c => c.name === COMMAND_CHANNEL && c.type === ChannelType.GuildText);
	let created = false;
	if (!channel) {
		channel = await guild.channels.create({ name: COMMAND_CHANNEL, type: ChannelType.GuildText, reason: 'Challonge bot setup' });
		created = true;
		console.log(`  created #${COMMAND_CHANNEL} in ${guild.name}`);
	}
	return { channel, created };
}

const WELCOME = [
	'Thanks for adding the Challonge bot!',
	`• To create tournaments you need the **${MANAGER_ROLE}** role, which I've created. A server admin can hand it out.`,
	`• I only respond to commands in this channel, #${COMMAND_CHANNEL}.`,
	'• Type `c!help` to see all of the commands.',
].join('\n');

// ---------------------------------------------------------------- commands

function helpEmbed() {
	return new EmbedBuilder()
		.setColor(ROLE_COLOR)
		.setTitle('Challonge Bot commands')
		.setDescription('Use `_` instead of spaces in names, e.g. `Brawlhalla_Tourney`.')
		.addFields(
			{ name: 'c!create (Name) (Game) (Year-Month-Day-Hour-Minute) (limit-N | free)',
				value: `Create a tournament. Needs the ${MANAGER_ROLE} role. Time is 24-hour.\n\`c!create Brawlhalla_Tourney Brawlhalla 2026-11-07-18-30 limit-16\`` },
			{ name: 'c!join (Name)  ·  c!leave (Name)', value: 'Sign up for, or drop out of, a tournament.\n`c!join Brawlhalla_Tourney`' },
			{ name: 'c!info (Name)  ·  c!bracket (Name)', value: 'Show tournament details, or a link to the bracket.' },
			{ name: 'c!start (Name)', value: 'Start the tournament and DM everyone their first match. Owner only.' },
			{ name: 'c!match (Name) [Match Number]', value: 'Show your current match, or a specific match.\n`c!match Brawlhalla_Tourney` · `c!match Brawlhalla_Tourney 3`' },
			{ name: 'c!report (Name) (Match Number) (Score) [true]',
				value: 'Report a score (player 1 first). Add `true` to make it final and advance the winner. Owner only.\n`c!report Brawlhalla_Tourney 1 2-1 true`' },
			{ name: 'c!edit (Name) (name | game | date | limit) (New Value)', value: 'Change tournament details. Owner only.\n`c!edit Brawlhalla_Tourney limit limit-32`' },
			{ name: 'c!delete (Name)', value: 'Delete a tournament. Owner only.' },
		);
}

function makeCommands({ client, challonge, timeZone }) {
	const unix = date => Math.floor(new Date(date).getTime() / 1000);

	return {
		async help(message) {
			await message.channel.send({ embeds: [helpEmbed()] });
		},

		async create(message, args) {
			if (!canManage(message.member)) throw new UserError(`You need the **${MANAGER_ROLE}** role to create tournaments.`);
			if (args.length !== 4) throw usage('c!create (Name) (Game) (Year-Month-Day-Hour-Minute) (limit-N | free)');
			const [nameArg, gameArg, timeArg, capArg] = args;

			const startAt = parseStartTime(timeArg, timeZone);
			if (!startAt) throw new UserError('That start time doesn\'t look right. Use Year-Month-Day-Hour-Minute with a 24-hour clock, e.g. `2026-11-07-18-30`.');
			const signupCap = parseCap(capArg);
			if (signupCap === undefined) throw new UserError('The participant amount should be `free` or `limit-N` (N at least 2), e.g. `limit-16`.');

			const name = spaced(nameArg);
			if (await challonge.findTournament(name)) throw new UserError(`There's already a tournament called **${name}**. Pick another name.`);

			const tournament = await challonge.createTournament({ name, game: spaced(gameArg), startAt, signupCap });
			await findOrCreateRole(message.guild, `Participant - ${tournament.name}`);
			const ownerRole = await findOrCreateRole(message.guild, `Owner - ${tournament.name}`);
			await message.member.roles.add(ownerRole);

			await message.channel.send(
				`**${tournament.name}** was created! It starts <t:${unix(startAt)}:F>.\n` +
				`Join with \`c!join ${nameArg}\` · Bracket: ${challonge.bracketUrl(tournament)}`,
			);
		},

		async join(message, args) {
			if (args.length !== 1) throw usage('c!join (Name)');
			const tournament = await requireTournament(challonge, args[0]);
			if (tournament.state !== 'pending') throw new UserError(`**${tournament.name}** has already started, so sign-ups are closed.`);

			const participants = await challonge.listParticipants(tournament);
			if (participants.some(p => p.misc === message.author.id)) {
				throw new UserError(`You're already entered in **${tournament.name}**.`);
			}
			await challonge.addParticipant(tournament, message.author.username, message.author.id);
			const role = findRole(message.guild, `Participant - ${tournament.name}`);
			if (role) await message.member.roles.add(role);
			await message.channel.send(`${message.author} is now entered in **${tournament.name}**!`);
		},

		async leave(message, args) {
			if (args.length !== 1) throw usage('c!leave (Name)');
			const tournament = await requireTournament(challonge, args[0]);
			const participants = await challonge.listParticipants(tournament);
			const me = participants.find(p => p.misc === message.author.id);
			if (!me) throw new UserError(`You're not entered in **${tournament.name}**.`);

			await challonge.removeParticipant(tournament, me);
			const role = findRole(message.guild, `Participant - ${tournament.name}`);
			if (role) await message.member.roles.remove(role);
			const note = tournament.state === 'underway' ? ' (the tournament was underway, so Challonge counts it as a forfeit)' : '';
			await message.channel.send(`${message.author} is no longer entered in **${tournament.name}**${note}.`);
		},

		async info(message, args) {
			if (args.length !== 1) throw usage('c!info (Name)');
			const tournament = await challonge.getTournament(await requireTournament(challonge, args[0]));
			const embed = new EmbedBuilder()
				.setColor(ROLE_COLOR)
				.setTitle(tournament.name)
				.setURL(challonge.bracketUrl(tournament))
				.addFields(
					{ name: 'Game', value: tournament.game_name || '—', inline: true },
					{ name: 'Status', value: tournament.state, inline: true },
					{ name: 'Participants', value: `${tournament.participants_count}${tournament.signup_cap ? ` / ${tournament.signup_cap}` : ''}`, inline: true },
					{ name: 'Starts', value: tournament.start_at ? `<t:${unix(tournament.start_at)}:F>` : '—', inline: true },
					{ name: 'Progress', value: `${tournament.progress_meter ?? 0}%`, inline: true },
					{ name: 'Created', value: `<t:${unix(tournament.created_at)}:d>`, inline: true },
				);
			await message.channel.send({ embeds: [embed] });
		},

		async bracket(message, args) {
			if (args.length !== 1) throw usage('c!bracket (Name)');
			const tournament = await requireTournament(challonge, args[0]);
			await message.channel.send(`**${tournament.name}** bracket: ${challonge.bracketUrl(tournament)}`);
		},

		async start(message, args) {
			if (args.length !== 1) throw usage('c!start (Name)');
			const tournament = await requireTournament(challonge, args[0]);
			requireOwner(message, tournament);
			if (tournament.state !== 'pending') throw new UserError(`**${tournament.name}** has already been started.`);

			await challonge.startTournament(tournament);
			const [participants, matches] = await Promise.all([challonge.listParticipants(tournament), challonge.listMatches(tournament)]);
			const byId = new Map(participants.map(p => [p.id, p]));
			const open = matches.filter(m => m.state === 'open').sort((a, b) => matchNumber(a) - matchNumber(b));

			const role = findRole(message.guild, `Participant - ${tournament.name}`);
			let text = `**${tournament.name}** has started! ${role ? role.toString() : ''}\n`;
			text += open.length ? `First matches:\n${open.map(m => describeMatch(m, byId)).join('\n')}` : '';
			text += `\nBracket: ${challonge.bracketUrl(tournament)}`;
			await message.channel.send(text.slice(0, 2000));
			await dmMatches(client, tournament, open, byId);
		},

		async match(message, args) {
			if (args.length !== 1 && args.length !== 2) throw usage('c!match (Name) [Match Number]');
			const tournament = await requireTournament(challonge, args[0]);
			const [participants, matches] = await Promise.all([challonge.listParticipants(tournament), challonge.listMatches(tournament)]);
			const byId = new Map(participants.map(p => [p.id, p]));

			if (args.length === 2) {
				const match = matches.find(m => String(matchNumber(m)) === args[1]);
				if (!match) throw new UserError(`There's no match ${args[1]} in **${tournament.name}**.`);
				await message.channel.send({ content: describeMatch(match, byId), allowedMentions: { parse: [] } });
				return;
			}

			const me = participants.find(p => p.misc === message.author.id);
			if (!me) throw new UserError(`You're not entered in **${tournament.name}**.`);
			if (tournament.state === 'pending') throw new UserError(`**${tournament.name}** hasn't started yet.`);
			const match = openMatchFor(matches, me.id);
			if (!match) {
				await message.channel.send(`You don't have a match to play right now in **${tournament.name}**.`);
				return;
			}
			await message.channel.send({ content: describeMatch(match, byId), allowedMentions: { parse: [] } });
		},

		async report(message, args) {
			if (args.length !== 3 && args.length !== 4) throw usage('c!report (Name) (Match Number) (Score) [true]');
			const [nameArg, numberArg, scoreArg, finalArg = 'false'] = args;
			const tournament = await requireTournament(challonge, nameArg);
			requireOwner(message, tournament);

			const score = /^(\d+)-(\d+)$/.exec(scoreArg);
			if (!score) throw new UserError('Write the score as `P1-P2`, e.g. `2-1`.');
			const final = finalArg.toLowerCase() === 'true';

			const [participants, matches] = await Promise.all([challonge.listParticipants(tournament), challonge.listMatches(tournament)]);
			const byId = new Map(participants.map(p => [p.id, p]));
			const match = matches.find(m => String(matchNumber(m)) === numberArg);
			if (!match) throw new UserError(`There's no match ${numberArg} in **${tournament.name}**.`);
			if (!match.player1_id || !match.player2_id) throw new UserError(`Match ${numberArg} doesn't have both players yet.`);

			let winnerId = null;
			if (final) {
				const [a, b] = [Number(score[1]), Number(score[2])];
				if (a === b) throw new UserError('A final score can\'t be a tie — someone has to win to advance.');
				winnerId = a > b ? match.player1_id : match.player2_id;
			}

			await challonge.updateMatch(tournament, match, scoreArg, winnerId);
			if (!final) {
				await message.channel.send(`Score for match ${matchNumber(match)} updated to ${scoreArg}.`);
				return;
			}
			await message.channel.send(`${mention(byId.get(winnerId))} won match ${matchNumber(match)} (${scoreArg})!`);

			const updated = await challonge.listMatches(tournament);
			const unfinished = updated.filter(m => m.state !== 'complete');
			if (unfinished.length === 0) {
				// Every match is done: finalize on Challonge and crown the winner.
				await challonge.finalizeTournament(tournament);
				const ranked = await challonge.listParticipants(tournament);
				const champion = ranked.find(p => p.final_rank === 1) || byId.get(winnerId);
				if (champion && champion.misc) {
					const winnerRole = await findOrCreateRole(message.guild, `Winner - ${tournament.name}`);
					const member = await message.guild.members.fetch(champion.misc).catch(() => null);
					if (member) await member.roles.add(winnerRole);
				}
				await message.channel.send(`🏆 ${mention(champion)} has won **${tournament.name}**! Final bracket: ${challonge.bracketUrl(tournament)}`);
				await deleteTournamentRoles(message.guild, tournament);
				return;
			}

			// Tell both players about any match they now have waiting.
			const next = [match.player1_id, match.player2_id]
				.map(id => openMatchFor(updated, id))
				.filter((m, i, list) => m && list.findIndex(x => x && x.id === m.id) === i);
			await dmMatches(client, tournament, next, byId);
		},

		async edit(message, args) {
			if (args.length < 3) throw usage('c!edit (Name) (name | game | date | limit) (New Value)');
			const [nameArg, attrArg] = args;
			const value = args.slice(2).join(' ');
			const tournament = await requireTournament(challonge, nameArg);
			requireOwner(message, tournament);

			const attr = attrArg.toLowerCase();
			let fields;
			if (attr === 'name') {
				const newName = spaced(value);
				if (await challonge.findTournament(newName)) throw new UserError(`There's already a tournament called **${newName}**.`);
				fields = { name: newName };
			} else if (attr === 'game') {
				fields = { game: spaced(value) };
			} else if (attr === 'date') {
				const startAt = parseStartTime(value, timeZone);
				if (!startAt) throw new UserError('Use Year-Month-Day-Hour-Minute with a 24-hour clock, e.g. `2026-11-07-18-30`.');
				fields = { startAt };
			} else if (attr === 'limit') {
				const signupCap = parseCap(value);
				if (signupCap === undefined) throw new UserError('The limit should be `free` or `limit-N`, e.g. `limit-16`.');
				fields = { signupCap };
			} else {
				throw new UserError('You can edit `name`, `game`, `date` or `limit`.');
			}

			const updated = await challonge.updateTournament(tournament, fields);
			if (fields.name) {
				for (const prefix of ['Owner - ', 'Participant - ']) {
					const role = findRole(message.guild, prefix + tournament.name);
					if (role) await role.setName(prefix + updated.name);
				}
			}
			await message.channel.send(`**${updated.name}** was updated.`);
		},

		async delete(message, args) {
			if (args.length !== 1) throw usage('c!delete (Name)');
			const tournament = await requireTournament(challonge, args[0]);
			requireOwner(message, tournament);
			await challonge.deleteTournament(tournament);
			await deleteTournamentRoles(message.guild, tournament);
			await message.channel.send(`**${tournament.name}** was deleted.`);
		},
	};
}

// ---------------------------------------------------------------- message handling

function makeMessageHandler(commands) {
	return async function onMessage(message) {
		if (message.author.bot || !message.guild) return;
		if (message.channel.name !== COMMAND_CHANNEL) return;

		const content = message.content.trim();
		if (!content.toLowerCase().startsWith(PREFIX)) return;
		const args = content.slice(PREFIX.length).trim().split(/\s+/).filter(Boolean);
		const name = (args.shift() || '').toLowerCase();
		const command = Object.prototype.hasOwnProperty.call(commands, name) ? commands[name] : null;
		if (!command) return;

		try {
			await message.channel.sendTyping().catch(() => {});
			await command(message, args);
		} catch (err) {
			let reply;
			if (err instanceof UserError) {
				reply = err.message;
			} else if (err instanceof ChallongeError) {
				reply = `Challonge returned an error: ${err.message}`;
			} else if (err && err.code === 50013) {
				reply = 'I\'m missing a permission for that. Make sure my role has **Manage Roles** and sits **above** the tournament roles in Server Settings → Roles.';
			} else {
				console.error(`Error running c!${name}:`, err);
				reply = 'Something went wrong running that command. Check the bot\'s console for details.';
			}
			await message.reply({ content: reply, allowedMentions: { repliedUser: false } }).catch(() => {});
		}
	};
}

// ---------------------------------------------------------------- startup

function start() {
	const config = loadConfig();
	const challonge = new Challonge(config.challongeApiKey);
	const client = new Client({
		intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
	});
	const commands = makeCommands({ client, challonge, timeZone: config.timeZone });

	client.once(Events.ClientReady, async () => {
		console.log(`Logged in as ${client.user.tag}`);
		console.log(`Invite link: https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot&permissions=${INVITE_PERMISSIONS}`);
		for (const guild of client.guilds.cache.values()) {
			console.log(`Connected to ${guild.name}`);
			await ensureSetup(guild).catch(err => console.error(`  setup failed in ${guild.name}: ${err.message}`));
		}
	});

	client.on(Events.GuildCreate, async guild => {
		console.log(`Joined ${guild.name}`);
		try {
			const { channel } = await ensureSetup(guild);
			await channel.send(WELCOME);
		} catch (err) {
			console.error(`  setup failed in ${guild.name}: ${err.message}`);
		}
	});

	client.on(Events.GuildDelete, guild => console.log(`Left ${guild.name}`));
	client.on(Events.MessageCreate, makeMessageHandler(commands));

	client.login(config.discordToken).catch(err => {
		if (/disallowed intents/i.test(err.message)) {
			console.error('Login failed: turn on "Message Content Intent" in the Discord Developer Portal (your app → Bot).');
		} else {
			console.error(`Login failed: ${err.message}`);
		}
		process.exit(1);
	});
}

process.on('unhandledRejection', err => {
	console.error('Unhandled promise rejection:', err);
});

if (require.main === module) start();

module.exports = { makeCommands, makeMessageHandler, ensureSetup, UserError, parseCap };
