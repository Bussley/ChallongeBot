'use strict';

// Small wrapper around the Challonge v1 REST API (https://api.challonge.com/v1).

const BASE_URL = 'https://api.challonge.com/v1';

class ChallongeError extends Error {
	constructor(message, status) {
		super(message);
		this.name = 'ChallongeError';
		this.status = status;
	}
}

// underscores and spaces treated as the same thing.
function normalizeName(name) {
	return String(name).replace(/_/g, ' ').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Returns null if the text isn't a Challonge link.
function identifierFromLink(text) {
	let url;
	try {
		url = new URL(String(text).trim().replace(/^<|>$/g, ''));
	} catch {
		return null;
	}
	const host = url.hostname.toLowerCase();
	if (host !== 'challonge.com' && !host.endsWith('.challonge.com')) return null;
	const parts = url.pathname.split('/').filter(Boolean);
	// Skip a language prefix like /en/ or /de/.
	if (parts.length > 1 && /^[a-z]{2}$/.test(parts[0])) parts.shift();
	if (parts.length === 0) return null;
	const sub = host.replace(/\.?challonge\.com$/, '').replace(/^www$/, '');
	return sub ? `${sub}-${parts[0]}` : parts[0];
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

	// Finds a tournament by name on this Challonge account, or by its link
	async findTournament(nameOrLink) {
		const identifier = identifierFromLink(nameOrLink);
		if (!identifier) {
			const wanted = normalizeName(nameOrLink);
			const matches = (await this.listTournaments()).filter(t => normalizeName(t.name) === wanted);
			if (matches.length > 0) {
				// If there are several with the same name, use the newest one.
				matches.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
				return matches[0];
			}
		}
		const code = identifier || String(nameOrLink).trim();
		if (!/^[A-Za-z0-9_-]+$/.test(code)) return null;
		try {
			const data = await this.request('GET', `tournaments/${code}`);
			return data.tournament;
		} catch (err) {
			if (err.status === 404) return null;
			throw err;
		}
	}

	async getTournament(tournament) {
		const data = await this.request('GET', `tournaments/${tournament.id}`);
		return data.tournament;
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

	async listParticipants(tournament) {
		const data = await this.request('GET', `tournaments/${tournament.id}/participants`);
		return (data || []).map(p => p.participant);
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

module.exports = { Challonge, ChallongeError, normalizeName, identifierFromLink };
