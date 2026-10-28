'use strict';

// Vote brackets: run an existing Challonge bracket as a series of Discord polls.
//
// Every cycle (24 hours by default) the bot posts a poll for the next open match.
// When the poll closes, whichever participant got more votes wins the match on
// Challonge (the vote counts become the score), and the next poll goes up.
// Ties go to the better (lower-numbered) seed.
//
// Progress is saved to vote-state.json so a restart picks up where it left off.

const fs = require('fs');

const DEFAULT_HOURS = 24;
const MAX_HOURS = 168; // one week
const TICK_MS = 60 * 1000;
// After a poll's time is up, wait this long for Discord to finish counting before
// using whatever counts are there.
const FINALIZE_GRACE_MS = 5 * 60 * 1000;

function makeVoting({ client, challonge, statePath, UserError, canManage, now = () => Date.now() }) {
	// ---- saved state
	let state = { brackets: {} };
	if (fs.existsSync(statePath)) {
		try {
			state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
			if (!state.brackets) state.brackets = {};
		} catch (err) {
			console.error(`Could not read ${statePath}, starting with no vote brackets: ${err.message}`);
		}
	}
	function save() {
		const tmp = `${statePath}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
		fs.renameSync(tmp, statePath);
	}

	const matchNumber = m => m.suggested_play_order ?? m.identifier;
	const answerText = name => (name.length > 55 ? `${name.slice(0, 54)}…` : name);

	async function fetchChannel(bracket) {
		return client.channels.fetch(bracket.channelId).catch(() => null);
	}

	// ---- posting and closing polls

	async function postNext(bracket) {
		const channel = await fetchChannel(bracket);
		if (!channel) {
			console.error(`Vote bracket "${bracket.name}": channel ${bracket.channelId} is gone, stopping.`);
			delete state.brackets[bracket.tournamentId];
			save();
			return;
		}

		const tournament = { id: bracket.tournamentId };
		const [participants, matches] = await Promise.all([challonge.listParticipants(tournament), challonge.listMatches(tournament)]);
		const byId = new Map(participants.map(p => [p.id, p]));
		const open = matches
			.filter(m => m.state === 'open' && m.player1_id && m.player2_id)
			.sort((a, b) => (matchNumber(a) ?? 0) - (matchNumber(b) ?? 0));

		if (open.length === 0) {
			if (matches.length > 0 && matches.every(m => m.state === 'complete')) {
				await finish(bracket, channel);
			}
			// Otherwise matches are waiting on something outside the bot; check again next tick.
			return;
		}

		const match = open[0];
		const p1 = byId.get(match.player1_id);
		const p2 = byId.get(match.player2_id);
		const message = await channel.send({
			content: `🗳️ **${bracket.name}** — Match ${matchNumber(match)}. Voting closes <t:${Math.floor((now() + bracket.hours * 3600e3) / 1000)}:R>.`,
			poll: {
				question: { text: `Match ${matchNumber(match)}: which is better?` },
				answers: [{ text: answerText(p1.name) }, { text: answerText(p2.name) }],
				duration: bracket.hours,
				allowMultiselect: false,
			},
		});

		bracket.current = {
			matchId: match.id,
			matchNumber: matchNumber(match),
			messageId: message.id,
			players: [match.player1_id, match.player2_id],
			endsAt: message.poll?.expiresTimestamp || now() + bracket.hours * 3600e3,
		};
		save();
	}

	// Closes the current poll and reports the result. Returns false if Discord
	// hasn't finished counting yet (try again on the next tick).
	async function resolve(bracket, { force = false } = {}) {
		const current = bracket.current;
		const channel = await fetchChannel(bracket);
		if (!channel) return postNext(bracket); // postNext handles the missing channel

		let message = await channel.messages.fetch(current.messageId).catch(() => null);
		if (!message || !message.poll) {
			// Poll was deleted — post it again.
			await channel.send(`The poll for match ${current.matchNumber} of **${bracket.name}** was deleted, so I'm posting it again.`);
			bracket.current = null;
			save();
			await postNext(bracket);
			return true;
		}

		if (!message.poll.resultsFinalized) {
			if (force) {
				message = await message.poll.end().catch(() => message);
				message = await channel.messages.fetch({ message: current.messageId, force: true }).catch(() => message);
			} else if (now() < current.endsAt + FINALIZE_GRACE_MS) {
				return false;
			}
		}

		const answers = [...message.poll.answers.values()].sort((a, b) => a.id - b.id);
		const votes = [answers[0]?.voteCount ?? 0, answers[1]?.voteCount ?? 0];

		const tournament = { id: bracket.tournamentId };
		const [participants, matches] = await Promise.all([challonge.listParticipants(tournament), challonge.listMatches(tournament)]);
		const byId = new Map(participants.map(p => [p.id, p]));
		const match = matches.find(m => m.id === current.matchId);

		bracket.current = null;
		save();

		if (!match || match.state === 'complete') {
			await channel.send(`Match ${current.matchNumber} of **${bracket.name}** was already decided on Challonge, so this poll didn't count.`);
			await postNext(bracket);
			return true;
		}

		const [id1, id2] = current.players;
		const [p1, p2] = [byId.get(id1), byId.get(id2)];
		let winner;
		let note = '';
		if (votes[0] !== votes[1]) {
			winner = votes[0] > votes[1] ? p1 : p2;
		} else {
			const seed = p => p?.seed ?? Number.MAX_SAFE_INTEGER;
			winner = seed(p1) <= seed(p2) ? p1 : p2;
			note = votes[0] === 0 ? ' (no votes, so the higher seed advances)' : ' (tied, so the higher seed advances)';
		}
		const loser = winner === p1 ? p2 : p1;

		// Challonge scores are always player1-player2.
		const scores = match.player1_id === id1 ? `${votes[0]}-${votes[1]}` : `${votes[1]}-${votes[0]}`;
		await challonge.updateMatch(tournament, match, scores, winner.id);
		const [wv, lv] = winner === p1 ? votes : [votes[1], votes[0]];
		await channel.send(`✅ **${winner.name}** beat **${loser.name}** ${wv}–${lv}${note} and moves on in **${bracket.name}**!`);

		await postNext(bracket);
		return true;
	}

	async function finish(bracket, channel) {
		const tournament = { id: bracket.tournamentId };
		let info = await challonge.getTournament(tournament);
		if (info.state !== 'complete') info = await challonge.finalizeTournament(tournament);
		const participants = await challonge.listParticipants(tournament);
		const champion = participants.find(p => p.final_rank === 1);
		await channel.send(
			`🏆 **${champion ? champion.name : 'The winner'}** has won **${bracket.name}**! ` +
			`Final bracket: ${challonge.bracketUrl(info)}`,
		);
		delete state.brackets[bracket.tournamentId];
		save();
	}

	// ---- scheduler

	let busy = false;
	let timer = null;
	async function tick() {
		if (busy) return;
		busy = true;
		try {
			for (const bracket of Object.values(state.brackets)) {
				try {
					if (!bracket.current) await postNext(bracket);
					else if (now() >= bracket.current.endsAt) await resolve(bracket);
				} catch (err) {
					console.error(`Vote bracket "${bracket.name}" error:`, err.message || err);
				}
			}
		} finally {
			busy = false;
		}
	}

	function startScheduler() {
		if (timer) return;
		tick();
		timer = setInterval(tick, TICK_MS);
	}

	// ---- c!vote command

	function findBracket(tournament) {
		return state.brackets[tournament.id];
	}

	async function lookup(nameArg) {
		const tournament = await challonge.findTournament(nameArg);
		if (!tournament) throw new UserError(`I couldn't find a tournament called **${nameArg}** on your Challonge account. You can also paste the bracket's link.`);
		return tournament;
	}

	async function command(message, args) {
		const sub = (args.shift() || '').toLowerCase();

		if (sub === 'status') {
			const list = Object.values(state.brackets);
			if (list.length === 0) {
				await message.channel.send('No vote brackets are running.');
				return;
			}
			const lines = list.map(b => {
				const where = `<#${b.channelId}>`;
				if (!b.current) return `• **${b.name}** in ${where} — getting the next match ready`;
				return `• **${b.name}** in ${where} — match ${b.current.matchNumber} poll closes <t:${Math.floor(b.current.endsAt / 1000)}:R>`;
			});
			await message.channel.send(lines.join('\n'));
			return;
		}

		if (!['start', 'stop', 'next'].includes(sub)) {
			throw new UserError('Usage: `c!vote start (Name or link) [hours] [#channel]`, `c!vote next (Name)`, `c!vote stop (Name)` or `c!vote status`.');
		}
		if (!canManage(message.member)) throw new UserError('You need the **Tournament Manager** role to run vote brackets.');

		if (sub === 'start') {
			const channelArg = args.find(a => /^<#\d+>$/.test(a));
			const rest = args.filter(a => a !== channelArg);
			let hours = DEFAULT_HOURS;
			if (rest.length > 1 && /^\d+$/.test(rest[rest.length - 1])) hours = Number(rest.pop());
			if (rest.length !== 1) throw new UserError('Usage: `c!vote start (Name or link) [hours] [#channel]` — e.g. `c!vote start Best_Pizza 24 #polls`');
			if (hours < 1 || hours > MAX_HOURS) throw new UserError(`Poll length must be between 1 and ${MAX_HOURS} hours.`);

			const channel = channelArg ? message.guild.channels.cache.get(channelArg.slice(2, -1)) : message.channel;
			if (!channel) throw new UserError('I can\'t see that channel.');

			let tournament = await lookup(rest[0]);
			if (findBracket(tournament)) throw new UserError(`**${tournament.name}** is already running as a vote bracket. Use \`c!vote status\`.`);
			if (tournament.state === 'complete') throw new UserError(`**${tournament.name}** is already finished.`);
			if (tournament.state === 'pending') {
				tournament = await challonge.startTournament(tournament);
			}

			const bracket = {
				tournamentId: tournament.id,
				name: tournament.name,
				guildId: message.guild.id,
				channelId: channel.id,
				hours,
				current: null,
			};
			state.brackets[tournament.id] = bracket;
			save();
			await message.channel.send(
				`Running **${tournament.name}** as a vote bracket in ${channel}: one match at a time, ${hours}-hour polls. ` +
				'The most votes wins and advances on Challonge; ties go to the higher seed.',
			);
			await postNext(bracket);
			return;
		}

		if (args.length !== 1) throw new UserError(`Usage: \`c!vote ${sub} (Name)\``);
		const tournament = await lookup(args[0]);
		const bracket = findBracket(tournament);
		if (!bracket) throw new UserError(`**${tournament.name}** isn't running as a vote bracket.`);

		if (sub === 'stop') {
			delete state.brackets[tournament.id];
			save();
			await message.channel.send(`Stopped the vote bracket for **${tournament.name}**. Any open poll won't be counted. The bracket on Challonge is unchanged.`);
			return;
		}

		// sub === 'next': close the current poll early and move on.
		if (!bracket.current) {
			await postNext(bracket);
			return;
		}
		await resolve(bracket, { force: true });
	}

	return { command, startScheduler, tick, state };
}

module.exports = { makeVoting };
