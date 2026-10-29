'use strict';

const fs = require('fs');
const path = require('path');
const {
	Client, GatewayIntentBits, Events, ChannelType, PermissionFlagsBits, EmbedBuilder,
} = require('discord.js');
const { Challonge, ChallongeError } = require('./challonge');
const { makeVoting } = require('./voting');

const PREFIX = 'c!';
const MANAGER_ROLE = 'Tournament Manager';
const COMMAND_CHANNEL = 'tournament';
const ROLE_COLOR = 0xFF7324;
const INVITE_PERMISSIONS = '562950221941776';

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
	};
	const missing = [];
	if (!config.discordToken || config.discordToken.startsWith('PASTE')) missing.push('discordToken');
	if (!config.challongeApiKey || config.challongeApiKey.startsWith('PASTE')) missing.push('challongeApiKey');
	if (missing.length) {
		console.error(`Missing ${missing.join(' and ')}. Put them in config.json (see config.example.json).`);
		process.exit(1);
	}
	return config;
}

// ---------------------------------------------------------------- helpers

// An error whose message is shown to the user as-is (bad usage, not found, etc).
class UserError extends Error {}

function canManage(member) {
	return member.roles.cache.some(r => r.name === MANAGER_ROLE) || member.permissions.has(PermissionFlagsBits.Administrator);
}

// Makes sure the Tournament Manager role and #tournament channel exist.
async function ensureSetup(guild) {
	await guild.roles.fetch();
	await guild.channels.fetch();

	if (!guild.roles.cache.find(r => r.name === MANAGER_ROLE)) {
		await guild.roles.create({ name: MANAGER_ROLE, color: ROLE_COLOR, mentionable: true, reason: 'Challonge bot setup' });
		console.log(`  created the ${MANAGER_ROLE} role in ${guild.name}`);
	}

	let channel = guild.channels.cache.find(c => c.name === COMMAND_CHANNEL && c.type === ChannelType.GuildText);
	if (!channel) {
		channel = await guild.channels.create({ name: COMMAND_CHANNEL, type: ChannelType.GuildText, reason: 'Challonge bot setup' });
		console.log(`  created #${COMMAND_CHANNEL} in ${guild.name}`);
	}
	return channel;
}

const WELCOME = [
	'Thanks for adding the Challonge vote bracket bot!',
	`• To run vote brackets you need the **${MANAGER_ROLE}** role, which I've created. A server admin can hand it out.`,
	`• I only respond to commands in this channel, #${COMMAND_CHANNEL}. The polls themselves can go in any channel.`,
	'• Type `c!help` to see the commands.',
].join('\n');

function helpEmbed() {
	return new EmbedBuilder()
		.setColor(ROLE_COLOR)
		.setTitle('Challonge vote bracket commands')
		.setDescription(
			'Runs an existing Challonge bracket as Discord polls: one match at a time, and the most votes wins and advances on Challonge. ' +
			`Ties go to the higher seed. Starting, skipping and stopping need the ${MANAGER_ROLE} role.`,
		)
		.addFields(
			{ name: 'c!vote start (Name or Challonge link) [hours] [#channel]',
				value: 'Start running a bracket as polls (default 24-hour polls, posted in this channel).\n`c!vote start https://challonge.com/abc123 24`' },
			{ name: 'c!vote status', value: 'List running vote brackets and when each poll closes.' },
			{ name: 'c!vote next (Name)', value: 'Close the current poll now and move on to the next match.' },
			{ name: 'c!vote stop (Name)', value: 'Stop posting polls. The open poll isn\'t counted.' },
		);
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
				reply = 'I\'m missing a permission for that. Make sure I can view, send messages and **Create Polls** in that channel.';
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
	const voting = makeVoting({
		client, challonge, UserError, canManage,
		statePath: path.join(__dirname, 'vote-state.json'),
	});
	const commands = {
		help: async message => { await message.channel.send({ embeds: [helpEmbed()] }); },
		vote: voting.command,
	};

	client.once(Events.ClientReady, async () => {
		console.log(`Logged in as ${client.user.tag}`);
		console.log(`Invite link: https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot&permissions=${INVITE_PERMISSIONS}`);
		for (const guild of client.guilds.cache.values()) {
			console.log(`Connected to ${guild.name}`);
			await ensureSetup(guild).catch(err => console.error(`  setup failed in ${guild.name}: ${err.message}`));
		}
		voting.startScheduler();
	});

	client.on(Events.GuildCreate, async guild => {
		console.log(`Joined ${guild.name}`);
		try {
			const channel = await ensureSetup(guild);
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

module.exports = { makeMessageHandler, ensureSetup, UserError, canManage, helpEmbed };
