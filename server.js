// server.js — GolDigital con football-data.org (plan free)
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
const webpush = require("web-push");
const { createClient } = require("@supabase/supabase-js");

const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";

const API_BASE = "https://api.football-data.org/v4";
const API_TOKEN = process.env.FOOTBALL_DATA_TOKEN;

if (!API_TOKEN) console.warn("⚠️  Falta FOOTBALL_DATA_TOKEN en .env");
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || "").split(",").map(o => o.trim()).filter(Boolean);
if (IS_PROD && ALLOWED_ORIGINS.length === 0) console.warn("⚠️  FRONTEND_ORIGIN no está seteado en producción");

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:soporte@goldigital.app";
const CRON_SECRET = process.env.CRON_SECRET;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabaseAdmin = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

const FREE_COMPETITIONS = {
    PL: { id: 2021, name: "Premier League" }, PD: { id: 2014, name: "La Liga" }, SA: { id: 2019, name: "Serie A" },
    BL1: { id: 2002, name: "Bundesliga" }, FL1: { id: 2015, name: "Ligue 1" }, CL: { id: 2001, name: "Champions League" },
    ELC: { id: 2016, name: "Championship (ING)" }, PPL: { id: 2017, name: "Primeira Liga" }, DED: { id: 2003, name: "Eredivisie" },
    BSA: { id: 2013, name: "Brasileirão Série A" }, WC: { id: 2000, name: "Mundial" }, EC: { id: 2018, name: "Eurocopa" }
};

const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(morgan(IS_PROD ? "combined" : "dev"));
app.use(cors({ origin(origin, callback) {
    if (!origin || (!IS_PROD && ALLOWED_ORIGINS.length === 0) || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`Origen no permitido por CORS: ${origin}`));
} }));
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: "Demasiados pedidos, esperá un minuto e intentá de nuevo." } });
app.use("/api/", apiLimiter);
app.get("/", (req, res) => res.json({ ok: true, service: "goldigital-backend", env: NODE_ENV }));

const cache = new Map();
function getCached(key) { const hit = cache.get(key); if (hit && hit.expires > Date.now()) return hit.data; if (hit) cache.delete(key); return null; }
function setCached(key, data, ttlMs) { cache.set(key, { data, expires: Date.now() + ttlMs }); }
async function fetchFootballData(path, ttlMs) {
    const cached = getCached(path);
    if (cached) return { data: cached, fromCache: true };
    const res = await fetch(`${API_BASE}${path}`, { headers: { "X-Auth-Token": API_TOKEN } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(json.message || `football-data.org respondió ${res.status}`); err.status = res.status; throw err; }
    setCached(path, json, ttlMs);
    return { data: json, fromCache: false };
}

function normalizeStatus(status) {
    switch (status) {
        case "IN_PLAY": case "PAUSED": return "LIVE";
        case "FINISHED": return "FT";
        case "POSTPONED": return "PST";
        case "SUSPENDED": return "SUSP";
        case "CANCELLED": return "CANC";
        default: return "NS";
    }
}
function normalizeMatch(m) {
    return {
        fixture: { date: m.utcDate, status: { short: normalizeStatus(m.status), elapsed: typeof m.minute === "number" ? m.minute : null } },
        league: { name: m.competition ? m.competition.name : "" },
        teams: { home: { name: m.homeTeam.name, logo: m.homeTeam.crest }, away: { name: m.awayTeam.name, logo: m.awayTeam.crest } },
        goals: { home: m.score?.fullTime?.home ?? null, away: m.score?.fullTime?.away ?? null },
        id: m.id
    };
}
function normalizeMatchDetail(m) {
    const base = normalizeMatch(m);
    return { ...base, matchday: m.matchday ?? null, stage: m.stage ?? null, group: m.group ?? null, venue: m.venue ?? null, referees: Array.isArray(m.referees) ? m.referees.map(r => r.name) : [], halfTime: m.score?.halfTime ?? null, homeLineup: m.homeTeam?.lineup ?? undefined, awayLineup: m.awayTeam?.lineup ?? undefined, statistics: m.statistics ?? undefined };
}

const SITE_TIMEZONE = process.env.SITE_TIMEZONE || "America/Argentina/Buenos_Aires";
function dateKeyInTZ(date, timeZone) { return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function isoInDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function isoDaysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
function getCompetitionId(req) { const key = (req.query.league || "PL").toUpperCase(); const comp = FREE_COMPETITIONS[key]; if (!comp) { const err = new Error(`Liga '${key}' no disponible en el plan free.`); err.status = 400; throw err; } return comp.id; }

app.get("/api/leagues", (req, res) => res.json({ ok: true, response: Object.entries(FREE_COMPETITIONS).map(([id, info]) => ({ id, name: info.name })) }));

app.get("/api/live", async (req, res) => { try { const compId = getCompetitionId(req); const { data, fromCache } = await fetchFootballData(`/matches?competitions=${compId}&status=LIVE`, 60000); res.json({ ok: true, cached: fromCache, response: (data.matches || []).map(normalizeMatch) }); } catch (err) { console.error(err.message); res.status(err.status || 500).json({ ok: false, error: err.message }); } });
app.get("/api/results", async (req, res) => { try { const compId = getCompetitionId(req); const { data, fromCache } = await fetchFootballData(`/matches?competitions=${compId}&dateFrom=${isoDaysAgo(1)}&dateTo=${isoInDays(1)}&status=FINISHED`, 300000); const todayLocal = dateKeyInTZ(new Date(), SITE_TIMEZONE); const matches = (data.matches || []).filter(m => dateKeyInTZ(new Date(m.utcDate), SITE_TIMEZONE) === todayLocal).map(normalizeMatch); res.json({ ok: true, cached: fromCache, response: matches }); } catch (err) { console.error(err.message); res.status(err.status || 500).json({ ok: false, error: err.message }); } });
app.get("/api/upcoming", async (req, res) => { try { const compId = getCompetitionId(req); const { data, fromCache } = await fetchFootballData(`/matches?competitions=${compId}&dateFrom=${todayISO()}&dateTo=${isoInDays(10)}&status=SCHEDULED`, 600000); res.json({ ok: true, cached: fromCache, response: (data.matches || []).slice(0, 6).map(normalizeMatch) }); } catch (err) { console.error(err.message); res.status(err.status || 500).json({ ok: false, error: err.message }); } });
app.get("/api/calendar", async (req, res) => {
    try {
        const league = String(req.query.league || "PL").toUpperCase();
        const date = String(req.query.date || todayISO());
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: "Fecha inválida. Usá YYYY-MM-DD." });
        const path = league === "ALL"
            ? `/matches?dateFrom=${date}&dateTo=${date}`
            : `/matches?competitions=${getCompetitionId(req)}&dateFrom=${date}&dateTo=${date}`;
        const { data, fromCache } = await fetchFootballData(path, 120000);
        res.json({ ok: true, cached: fromCache, date, response: (data.matches || []).map(normalizeMatch) });
    } catch (err) { console.error(err.message); res.status(err.status || 500).json({ ok: false, error: err.message }); }
});
app.get("/api/standings", async (req, res) => { try { const compId = getCompetitionId(req); const { data, fromCache } = await fetchFootballData(`/competitions/${compId}/standings`, 900000); const groups = (data.standings || []).filter(s => s.type === "TOTAL"); const mapRow = row => ({ position: row.position, team: { name: row.team.name, crest: row.team.crest }, played: row.playedGames, won: row.won, draw: row.draw, lost: row.lost, goalDifference: row.goalDifference, points: row.points }); const table = groups.length === 1 ? groups[0].table.map(mapRow) : null; const byGroup = groups.length > 1 ? groups.map(g => ({ group: g.group, table: g.table.map(mapRow) })) : null; res.json({ ok: true, cached: fromCache, response: table, byGroup }); } catch (err) { console.error(err.message); res.status(err.status || 500).json({ ok: false, error: err.message }); } });
app.get("/api/teams", async (req, res) => { try { const compId = getCompetitionId(req); const { data, fromCache } = await fetchFootballData(`/competitions/${compId}/teams`, 3600000); res.json({ ok: true, cached: fromCache, response: (data.teams || []).map(t => ({ id: t.id, name: t.name, shortName: t.shortName, tla: t.tla, crest: t.crest })) }); } catch (err) { console.error(err.message); res.status(err.status || 500).json({ ok: false, error: err.message }); } });

app.get("/api/team/:id/overview", async (req, res) => {
    const teamId = req.params.id;
    try {
        const [teamRes, liveRes, lastRes, nextRes] = await Promise.all([
            fetchFootballData(`/teams/${teamId}`, 3600000),
            fetchFootballData(`/teams/${teamId}/matches?status=LIVE`, 60000),
            fetchFootballData(`/teams/${teamId}/matches?status=FINISHED&dateFrom=${isoDaysAgo(45)}&dateTo=${todayISO()}`, 600000),
            fetchFootballData(`/teams/${teamId}/matches?status=SCHEDULED&dateFrom=${todayISO()}&dateTo=${isoInDays(45)}`, 600000)
        ]);
        const team = teamRes.data;
        const finished = lastRes.data.matches || [];
        const scheduled = nextRes.data.matches || [];
        const live = (liveRes.data.matches || []).map(normalizeMatch);
        const last = finished.length ? normalizeMatch(finished[finished.length - 1]) : null;
        const next = scheduled.length ? normalizeMatch(scheduled[0]) : null;
        res.json({ ok: true, response: { team: { id: team.id, name: team.name, shortName: team.shortName, tla: team.tla, crest: team.crest, website: team.website, founded: team.founded, venue: team.venue }, live, last, next } });
    } catch (err) { console.error(err.message); res.status(err.status || 500).json({ ok: false, error: err.message }); }
});

app.get("/api/match/:id", async (req, res) => { try { const { data, fromCache } = await fetchFootballData(`/matches/${req.params.id}`, 30000); res.json({ ok: true, cached: fromCache, normalized: normalizeMatchDetail(data), raw: data }); } catch (err) { console.error(err.message); res.status(err.status || 500).json({ ok: false, error: err.message }); } });

app.get("/api/push/public-key", (req, res) => { if (!VAPID_PUBLIC_KEY) return res.status(500).json({ ok: false, error: "VAPID_PUBLIC_KEY no configurada" }); res.json({ ok: true, key: VAPID_PUBLIC_KEY }); });
app.post("/api/push/subscribe", express.json(), async (req, res) => {
    if (!supabaseAdmin) return res.status(500).json({ ok: false, error: "Supabase no configurado en el backend" });
    const { subscription, teamId, teamIds, preferences = {} } = req.body || {};
    const ids = [...new Set((Array.isArray(teamIds) ? teamIds : [teamId]).filter(Boolean).map(String))];
    if (!subscription?.endpoint || !subscription.keys || ids.length === 0) return res.status(400).json({ ok: false, error: "Falta subscription o equipos" });
    const prefs = {
        notify_start: preferences.start !== false,
        notify_score: preferences.score !== false,
        notify_final: preferences.final !== false
    };
    await supabaseAdmin.from("push_subscriptions").delete().eq("endpoint", subscription.endpoint);
    const rows = ids.map(id => ({ endpoint: subscription.endpoint, team_id: id, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, ...prefs }));
    const { error } = await supabaseAdmin.from("push_subscriptions").insert(rows);
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, teams: ids.length });
});
app.post("/api/push/test", express.json(), async (req, res) => { const { subscription } = req.body || {}; if (!subscription?.endpoint || !subscription.keys) return res.status(400).json({ ok: false, error: "Falta subscription" }); try { await webpush.sendNotification(subscription, JSON.stringify({ title: "GolDigital", body: "Notificación de prueba — si ves esto, ¡el circuito funciona! 🎉", url: "/" })); res.json({ ok: true }); } catch (err) { console.error("Error en push de prueba:", err.message); res.status(err.statusCode || 500).json({ ok: false, error: err.message }); } });
app.post("/api/push/unsubscribe", express.json(), async (req, res) => { if (!supabaseAdmin) return res.status(500).json({ ok: false, error: "Supabase no configurado en el backend" }); const { endpoint } = req.body || {}; if (!endpoint) return res.status(400).json({ ok: false, error: "Falta endpoint" }); await supabaseAdmin.from("push_subscriptions").delete().eq("endpoint", endpoint); res.json({ ok: true }); });

async function alreadyNotified(matchId, kind) { const { data } = await supabaseAdmin.from("push_notifications_sent").select("match_id").eq("match_id", String(matchId)).eq("kind", kind).maybeSingle(); return !!data; }
async function markNotified(matchId, kind) { await supabaseAdmin.from("push_notifications_sent").insert({ match_id: String(matchId), kind }); }
async function notifySubscribers(subs, payload) { await Promise.all(subs.map(async s => { const pushSub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }; try { await webpush.sendNotification(pushSub, JSON.stringify(payload)); } catch (err) { if (err.statusCode === 404 || err.statusCode === 410) await supabaseAdmin.from("push_subscriptions").delete().eq("endpoint", s.endpoint); else console.error("Error enviando push:", err.message); } })); }
app.get("/api/push/check", async (req, res) => {
    if (!CRON_SECRET || req.query.key !== CRON_SECRET) return res.status(401).json({ ok: false, error: "unauthorized" });
    if (!supabaseAdmin) return res.status(500).json({ ok: false, error: "Supabase no configurado en el backend" });
    try {
        const { data: subs, error } = await supabaseAdmin.from("push_subscriptions").select("*");
        if (error) throw error;
        const teamIds = [...new Set((subs || []).map(s => String(s.team_id)))];
        const followedTeams = new Set(teamIds);
        let notificationsSent = 0;

        // Una sola consulta global por ejecución. Pedimos un margen de tres días UTC
        // y luego filtramos por el día local del sitio para no perder partidos cerca de medianoche.
        const matchesRes = await fetchFootballData(
            `/matches?dateFrom=${isoDaysAgo(1)}&dateTo=${isoInDays(1)}`,
            30000
        );
        const todayLocal = dateKeyInTZ(new Date(), SITE_TIMEZONE);
        const matches = (matchesRes.data.matches || []).filter(m => {
            const homeId = String(m.homeTeam?.id || "");
            const awayId = String(m.awayTeam?.id || "");
            return (followedTeams.has(homeId) || followedTeams.has(awayId))
                && dateKeyInTZ(new Date(m.utcDate), SITE_TIMEZONE) === todayLocal;
        });

        for (const m of matches) {
            const homeId = String(m.homeTeam?.id || "");
            const awayId = String(m.awayTeam?.id || "");
            const relevantTeamIds = new Set([homeId, awayId].filter(id => followedTeams.has(id)));

            // Unimos los suscriptores de ambos equipos y deduplicamos por endpoint.
            // Así un partido se procesa una sola vez y nadie queda afuera por seguir al rival.
            const matchSubs = [...new Map(
                (subs || [])
                    .filter(s => relevantTeamIds.has(String(s.team_id)))
                    .map(s => [s.endpoint, s])
            ).values()];
            const startSubs = matchSubs.filter(s => s.notify_start !== false);
            const scoreSubs = matchSubs.filter(s => s.notify_score !== false);
            const finalSubs = matchSubs.filter(s => s.notify_final !== false);
            if (matchSubs.length === 0) continue;

            const targetTeamId = relevantTeamIds.values().next().value;
            const targetUrl = `/team/${targetTeamId}`;

            if (m.status === "SCHEDULED" || m.status === "TIMED") {
                const minsUntil = (new Date(m.utcDate).getTime() - Date.now()) / 60000;
                if (minsUntil > 0 && minsUntil <= 10 && !(await alreadyNotified(m.id, "starting"))) {
                    await notifySubscribers(startSubs, {
                        title: "⚽ Partido en breve",
                        body: `${m.homeTeam.name} vs ${m.awayTeam.name} arranca en menos de 10 minutos`,
                        url: targetUrl,
                        tag: `match-${m.id}-starting`
                    });
                    await markNotified(m.id, "starting");
                    notificationsSent++;
                }
            }

            if (m.status === "IN_PLAY" || m.status === "PAUSED") {
                if (!(await alreadyNotified(m.id, "live"))) {
                    await notifySubscribers(startSubs, {
                        title: "🔴 ¡Arrancó!",
                        body: `${m.homeTeam.name} vs ${m.awayTeam.name} ya está en juego`,
                        url: targetUrl,
                        tag: `match-${m.id}-live`
                    });
                    await markNotified(m.id, "live");
                    notificationsSent++;
                }

                const home = m.score?.fullTime?.home ?? m.score?.halfTime?.home;
                const away = m.score?.fullTime?.away ?? m.score?.halfTime?.away;
                if (home != null && away != null) {
                    const scoreKind = `score-${home}-${away}`;
                    if (!(await alreadyNotified(m.id, scoreKind))) {
                        await notifySubscribers(scoreSubs, {
                            title: "⚽ Cambio en el marcador",
                            body: `${m.homeTeam.name} ${home} - ${away} ${m.awayTeam.name}`,
                            url: targetUrl,
                            tag: `match-${m.id}-score`
                        });
                        await markNotified(m.id, scoreKind);
                        notificationsSent++;
                    }
                }
            }

            if (m.status === "FINISHED" && !(await alreadyNotified(m.id, "finished"))) {
                const home = m.score?.fullTime?.home ?? 0;
                const away = m.score?.fullTime?.away ?? 0;
                await notifySubscribers(finalSubs, {
                    title: "🏁 Final del partido",
                    body: `${m.homeTeam.name} ${home} - ${away} ${m.awayTeam.name}`,
                    url: targetUrl,
                    tag: `match-${m.id}-finished`
                });
                await markNotified(m.id, "finished");
                notificationsSent++;
            }
        }

        res.json({
            ok: true,
            teamsChecked: teamIds.length,
            matchesChecked: matches.length,
            footballDataRequests: 1,
            notificationsSent
        });
    } catch (err) { console.error(err.message); res.status(500).json({ ok: false, error: err.message }); }
});
app.get("/api/status", async (req, res) => { try { const r = await fetch(`${API_BASE}/competitions/PL`, { headers: { "X-Auth-Token": API_TOKEN } }); const json = await r.json(); res.json({ ok: r.ok, backend: "up", footballData: r.ok ? { name: json.name } : json }); } catch (err) { res.status(500).json({ ok: false, error: err.message }); } });
app.use((err, req, res, next) => { console.error(err.message); res.status(err.status || 500).json({ ok: false, error: err.message || "Error interno" }); });
process.on("unhandledRejection", reason => console.error("Unhandled rejection:", reason));
process.on("uncaughtException", err => { console.error("Uncaught exception:", err); process.exit(1); });
app.listen(PORT, () => console.log(`GolDigital backend (football-data.org) en puerto ${PORT} — entorno: ${NODE_ENV}`));
