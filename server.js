// server.js — GolDigital con football-data.org (plan free)
require("dotenv").config();
const express = require("express");
const cors = require("cors");

const API_BASE = "https://api.football-data.org/v4";
const API_TOKEN = process.env.FOOTBALL_DATA_TOKEN;

if (!API_TOKEN) {
    console.warn("⚠️  Falta FOOTBALL_DATA_TOKEN en .env");
}

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

// ======= LIGAS DISPONIBLES EN EL PLAN FREE =======
// (Actualizado con los IDs correctos de football-data.org)
const FREE_COMPETITIONS = {
    "PL":  { id: 2021, name: "Premier League" },
    "PD":  { id: 2014, name: "La Liga" },
    "SA":  { id: 2019, name: "Serie A" },
    "BL1": { id: 2002, name: "Bundesliga" },
    "FL1": { id: 2015, name: "Ligue 1" },
    "CL":  { id: 2001, name: "Champions League" },
    "ELC": { id: 2016, name: "Championship (ING)" },
    "PPL": { id: 2017, name: "Primeira Liga" },
    "DED": { id: 2003, name: "Eredivisie" },
    // Podés agregar más si el plan free las cubre (ej. Liga MX no está)
};

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));

// ======= CACHE EN MEMORIA =======
const cache = new Map();

function getCached(key) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.data;
    if (hit) cache.delete(key);
    return null;
}

function setCached(key, data, ttlMs) {
    cache.set(key, { data, expires: Date.now() + ttlMs });
}

// ======= FETCH PROXY =======
async function fetchFootballData(path, ttlMs) {
    const cached = getCached(path);
    if (cached) return { data: cached, fromCache: true };

    const res = await fetch(`${API_BASE}${path}`, {
        headers: { "X-Auth-Token": API_TOKEN }
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
        const err = new Error(json.message || `football-data.org respondió ${res.status}`);
        err.status = res.status;
        throw err;
    }

    setCached(path, json, ttlMs);
    return { data: json, fromCache: false };
}

// ======= NORMALIZACIÓN =======
function normalizeStatus(status) {
    switch (status) {
        case "IN_PLAY":
        case "PAUSED":
            return "LIVE";
        case "FINISHED":
            return "FT";
        case "POSTPONED":
            return "PST";
        case "SUSPENDED":
            return "SUSP";
        case "CANCELLED":
            return "CANC";
        default:
            return "NS";
    }
}

function normalizeMatch(m) {
    const shortStatus = normalizeStatus(m.status);
    return {
        fixture: {
            date: m.utcDate,
            status: {
                short: shortStatus,
                elapsed: typeof m.minute === "number" ? m.minute : null
            }
        },
        league: { name: m.competition ? m.competition.name : "" },
        teams: {
            home: { name: m.homeTeam.name, logo: m.homeTeam.crest },
            away: { name: m.awayTeam.name, logo: m.awayTeam.crest }
        },
        goals: {
            home: m.score && m.score.fullTime ? m.score.fullTime.home : null,
            away: m.score && m.score.fullTime ? m.score.fullTime.away : null
        }
    };
}

// ======= ZONA HORARIA =======
const SITE_TIMEZONE = process.env.SITE_TIMEZONE || "America/Argentina/Buenos_Aires";

function dateKeyInTZ(date, timeZone) {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function todayISO() {
    return new Date().toISOString().slice(0, 10);
}
function isoInDays(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
}
function isoDaysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
}

function getCompetitionId(req) {
    const leagueKey = (req.query.league || "PL").toUpperCase();
    const comp = FREE_COMPETITIONS[leagueKey];
    if (!comp) {
        const err = new Error(`Liga '${leagueKey}' no disponible en el plan free.`);
        err.status = 400;
        throw err;
    }
    return comp.id;
}

// ======= RUTAS =======

// 1. Lista de ligas disponibles (el frontend la usa para llenar el selector)
app.get("/api/leagues", (req, res) => {
    const leagues = Object.entries(FREE_COMPETITIONS).map(([key, info]) => ({
        id: key,          // Ej: "PL", "PD", etc.
        name: info.name
    }));
    res.json({ ok: true, response: leagues });
});

// 2. En vivo
app.get("/api/live", async (req, res) => {
    try {
        const compId = getCompetitionId(req);
        const { data, fromCache } = await fetchFootballData(
            `/matches?competitions=${compId}&status=LIVE`,
            60 * 1000
        );
        const matches = (data.matches || []).map(normalizeMatch);
        res.json({ ok: true, cached: fromCache, response: matches });
    } catch (err) {
        console.error(err.message);
        res.status(err.status || 500).json({ ok: false, error: err.message });
    }
});

// 3. Resultados de hoy
app.get("/api/results", async (req, res) => {
    try {
        const compId = getCompetitionId(req);
        const from = isoDaysAgo(1);
        const to = isoInDays(1);
        const todayLocal = dateKeyInTZ(new Date(), SITE_TIMEZONE);
        const { data, fromCache } = await fetchFootballData(
            `/matches?competitions=${compId}&dateFrom=${from}&dateTo=${to}&status=FINISHED`,
            5 * 60 * 1000
        );
        const todaysMatches = (data.matches || []).filter(
            m => dateKeyInTZ(new Date(m.utcDate), SITE_TIMEZONE) === todayLocal
        );
        res.json({ ok: true, cached: fromCache, response: todaysMatches.map(normalizeMatch) });
    } catch (err) {
        console.error(err.message);
        res.status(err.status || 500).json({ ok: false, error: err.message });
    }
});

// 4. Próximos
app.get("/api/upcoming", async (req, res) => {
    try {
        const compId = getCompetitionId(req);
        const from = todayISO();
        const to = isoInDays(10);
        const { data, fromCache } = await fetchFootballData(
            `/matches?competitions=${compId}&dateFrom=${from}&dateTo=${to}&status=SCHEDULED`,
            10 * 60 * 1000
        );
        const matches = (data.matches || []).slice(0, 6).map(normalizeMatch);
        res.json({ ok: true, cached: fromCache, response: matches });
    } catch (err) {
        console.error(err.message);
        res.status(err.status || 500).json({ ok: false, error: err.message });
    }
});

// 5. Status
app.get("/api/status", async (req, res) => {
    try {
        const r = await fetch(`${API_BASE}/competitions/PL`, { headers: { "X-Auth-Token": API_TOKEN } });
        const json = await r.json();
        res.json({ ok: r.ok, backend: "up", footballData: r.ok ? { name: json.name } : json });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`GolDigital backend (football-data.org) en puerto ${PORT}`);
});