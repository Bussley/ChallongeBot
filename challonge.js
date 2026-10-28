'use strict';

// Small wrapper around the Challonge v1 REST API (https://api.challonge.com/v1).
// Every method returns a Promise and throws a ChallongeError when Challonge
// rejects the request, so the bot can tell the user what went wrong.

const BASE_URL = 'https://api.challonge.com/v1';

class ChallongeError extends Error {
	constructor(message, status) {
		super(message);
		this.name = 'ChallongeError';
		this.status = status;
	}
}

// Tournament names are typed with underscores in place of spaces
// ("Brawlhalla_Tourney"), so compare names case-insensitively with
// underscores and spaces treated as the same thing.
function normalizeName(name) {
	return String(name).replace(/_/g, ' ').trim().replace(/\s+/g, ' ').toLowerCase();
}

function randomUrl() {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let id = 'cb_';
	for (let i = 0; i < 10; i++) id += chars[Math.floor(Math.random() * chars.length)];
	return id;
}

class Challonge {
	constructor(apiKey) {
		if (!apiKey) throw new Error('A Challonge API key is required.');
		this.apiKey = apiKey;
	}

	async request(method, path, params = {}) {
		const url = new URL(`${BASE_URL}/${path}.json`);
		const options = {
			method,
			headers: { Accept: 'application/json', 'User-Agent': 'Challonge-Discord-Bot' },
		};

		if (method === 'GET') {
			url.searchParams.set('api_key', this.apiKey);
			for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value ?? '');
		} else {
			const body = new URLSearchParams();
			body.set('api_key', this.apiKey);
			for (const [key, value] of Object.entries(params)) body.set(key, value ?? '');
			options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
			options.body = body;
		}

		let res;
		try {
			res = await fetch(url, options);
		} catch (err) {
			throw new ChallongeError(`could not reach Challonge (${err.message})`);
		}

		const text = await res.text();
		let data = null;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {
			data = null;
		}

		if (!res.ok) {
			let message = `HTTP ${res.status}`;
			if (data && data.errors) message = [].concat(data.errors).join(', ');
			else if (res.status === 401) message = 'the Challonge API key was rejected (401). Check challongeApiKey in your config.';
			throw new ChallongeError(message, res.status);
		}
		return data;
	}

	// ---- Tournaments ----

	async listTournaments() {
		const data = await this.request('GET', 'tournaments');
		return (data || []).map(t => t.tournament);
	}

	// Finds a tournament on this Challonge account by name. Returns null if none match.
	async findTournament(name) {
		const wanted = normalizeName(name);
		const matches = (await this.listTournaments()).filter(t => normalizeName(t.name) === wanted);
		if (matches.length === 0) return null;
		// If there are several with the same name, use the newest one.
		matches.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
		return matches[0];
	}

	async getTournament(tournament) {
		const data = await this.request('GET', `tournaments/${tournament.id}`);
		return data.tournament;
	}

	async createTournament({ name, game, startAt, signupCap }) {
		const data = await this.request('POST', 'tournaments', {
			'tournament[name]': name,
			'tournament[url]': randomUrl(),
			'tournament[game_name]': game,
			'tournament[start_at]': startAt ? startAt.toISOString() : '',
			'tournament[signup_cap]': signupCap ?? '',
			'tournament[open_signup]': 'false',
		});
		return data.tournament;
	}

	// fields: { name, game, startAt (Date), signupCap (number or null) } — any subset.
	async updateTournament(tournament, fields) {
		const params = {};
		if ('name' in fields) params['tournament[name]'] = fields.name;
		if ('game' in fields) params['tournament[game_name]'] = fields.game;
		if ('startAt' in fields) params['tournament[start_at]'] = fields.startAt.toISOString();
		if ('signupCap' in fields) params['tournament[signup_cap]'] = fields.signupCap ?? '';
		const data = await this.request('PUT', `tournaments/${tournament.id}`, params);
		return data.tournament;
	}

	async deleteTournament(tournament) {
		await this.request('DELETE', `tournaments/${tournament.id}`);
	}

	async startTournament(tournament) {
		const data = await this.request('POST', `tournaments/${tournament.id}/start`);
		return data.tournament;
	}

	async finalizeTournament(tournament) {
		const data = await this.request('POST', `tournaments/${tournament.id}/finalize`);
		return data.tournament;
	}

	bracketUrl(tournament) {
		return tournament.full_challonge_url || `https://challonge.com/${tournament.url}`;
	}

	// ---- Participants ----
	// Each participant's Discord user ID is stored in Challonge's "misc" field,
	// so the bot can find and @mention them later.

	async listParticipants(tournament) {
		const data = await this.request('GET', `tournaments/${tournament.id}/participants`);
		return (data || []).map(p => p.participant);
	}

	async addParticipant(tournament, name, discordId) {
		const data = await this.request('POST', `tournaments/${tournament.id}/participants`, {
			'participant[name]': name,
			'participant[misc]': discordId,
		});
		return data.participant;
	}

	async removeParticipant(tournament, participant) {
		await this.request('DELETE', `tournaments/${tournament.id}/participants/${participant.id}`);
	}

	// ---- Matches ----

	async listMatches(tournament) {
		const data = await this.request('GET', `tournaments/${tournament.id}/matches`);
		return (data || []).map(m => m.match);
	}

	async updateMatch(tournament, match, scoresCsv, winnerId) {
		const params = { 'match[scores_csv]': scoresCsv };
		if (winnerId) params['match[winner_id]'] = winnerId;
		const data = await this.request('PUT', `tournaments/${tournament.id}/matches/${match.id}`, params);
		return data.match;
	}
}

module.exports = { Challonge, ChallongeError, normalizeName };
