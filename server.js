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

if (!API_TOKEN) {
    console.warn("⚠️  Falta FOOTBALL_DATA_TOKEN en .env");
}

const PORT = process.env.PORT || 3000;

// FRONTEND_ORIGIN admite uno o varios orígenes separados por coma, ej:
// "https://gol-digital.vercel.app,https://www.goldigital.com"
// En desarrollo, si no está seteado, se permite cualquier origen para no trabar el testeo local.
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || "")
    .split(",")
    .map(o => o.trim())
    .filter(Boolean);

if (IS_PROD && ALLOWED_ORIGINS.length === 0) {
    console.warn("⚠️  FRONTEND_ORIGIN no está seteado en producción — el backend va a rechazar todos los orígenes por CORS hasta que lo configures en Render.");
}

// ======= NOTIFICACIONES PUSH =======
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:soporte@goldigital.app";
const CRON_SECRET = process.env.CRON_SECRET;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
    console.warn("⚠️  Faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY — las notificaciones push no van a funcionar hasta que las configures.");
}

// Cliente de Supabase con la service role key: SOLO se usa acá en el backend,
// nunca en el frontend — bypassea RLS a propósito para guardar/leer suscripciones.
const supabaseAdmin =
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
        ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
        : null;

if (!supabaseAdmin) {
    console.warn("⚠️  Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — las suscripciones push no se van a poder guardar.");
}

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
    "BSA": { id: 2013, name: "Brasileirão Série A" },
    "WC":  { id: 2000, name: "Mundial" },
    "EC":  { id: 2018, name: "Eurocopa" }
    // Estas 12 son las que confirma el plan free en football-data.org/pricing.
    // Si en algún momento cambia tu plan, agregá/sacá acá.
};

const app = express();

// Render está detrás de un proxy — hace falta para que express-rate-limit
// identifique bien la IP real del visitante en vez de la del proxy.
app.set("trust proxy", 1);

app.use(helmet());
app.use(morgan(IS_PROD ? "combined" : "dev"));

app.use(cors({
    origin(origin, callback) {
        // Pedidos sin header Origin (curl, health checks del propio Render) siempre pasan.
        if (!origin) return callback(null, true);
        // En desarrollo sin FRONTEND_ORIGIN seteado, permitimos todo para no trabar el testeo local.
        if (!IS_PROD && ALLOWED_ORIGINS.length === 0) return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        callback(new Error(`Origen no permitido por CORS: ${origin}`));
    }
}));

// Protege la cuota diaria/por-minuto de football-data.org: como el backend es
// público, sin esto cualquiera podría bombardearlo de pedidos y agotar tu cupo.
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30, // 30 pedidos por minuto por IP — de sobra para uso normal del sitio
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: "Demasiados pedidos, esperá un minuto e intentá de nuevo." }
});
app.use("/api/", apiLimiter);

// Sanity check al entrar directo a la URL del backend en el navegador.
app.get("/", (req, res) => {
    res.json({ ok: true, service: "goldigital-backend", env: NODE_ENV });
});

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
        },
        id: m.id
    };
}

// Versión extendida para el detalle de un partido puntual: agrega todo lo
// "extra" que venga en la respuesta (árbitro, estadio, instancia del torneo),
// para poder ver de un vistazo qué te da realmente tu plan.
function normalizeMatchDetail(m) {
    const base = normalizeMatch(m);
    return {
        ...base,
        matchday: m.matchday ?? null,
        stage: m.stage ?? null,
        group: m.group ?? null,
        venue: m.venue ?? null,
        referees: Array.isArray(m.referees) ? m.referees.map(r => r.name) : [],
        halfTime: m.score && m.score.halfTime ? m.score.halfTime : null,
        // Estos dos campos solo existen si tu plan incluye estadísticas/alineaciones —
        // si vienen undefined, es la confirmación de que el plan free no los da.
        homeLineup: m.homeTeam ? m.homeTeam.lineup ?? undefined : undefined,
        awayLineup: m.awayTeam ? m.awayTeam.lineup ?? undefined : undefined,
        statistics: m.statistics ?? undefined
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

// 4.1 Tabla de posiciones. Cache: 15 min (cambia poco de un día a otro).
app.get("/api/standings", async (req, res) => {
    try {
        const compId = getCompetitionId(req);
        const { data, fromCache } = await fetchFootballData(`/competitions/${compId}/standings`, 15 * 60 * 1000);
        // "TOTAL" es la tabla general. Competiciones por grupos (Mundial, Champions,
        // Eurocopa) devuelven varias tablas (una por grupo) en vez de una sola general.
        const groups = (data.standings || []).filter(s => s.type === "TOTAL");
        const mapRow = row => ({
            position: row.position,
            team: { name: row.team.name, crest: row.team.crest },
            played: row.playedGames,
            won: row.won,
            draw: row.draw,
            lost: row.lost,
            goalDifference: row.goalDifference,
            points: row.points
        });
        const table = groups.length === 1 ? groups[0].table.map(mapRow) : null;
        const byGroup = groups.length > 1
            ? groups.map(g => ({ group: g.group, table: g.table.map(mapRow) }))
            : null;
        res.json({ ok: true, cached: fromCache, response: table, byGroup });
    } catch (err) {
        console.error(err.message);
        res.status(err.status || 500).json({ ok: false, error: err.message });
    }
});

// 4.2 Equipos de una liga — para armar el selector de "equipo favorito".
// Cache larga: la lista de equipos de una competición casi no cambia en la temporada.
app.get("/api/teams", async (req, res) => {
    try {
        const compId = getCompetitionId(req);
        const { data, fromCache } = await fetchFootballData(`/competitions/${compId}/teams`, 60 * 60 * 1000);
        const teams = (data.teams || []).map(t => ({ id: t.id, name: t.name, crest: t.crest }));
        res.json({ ok: true, cached: fromCache, response: teams });
    } catch (err) {
        console.error(err.message);
        res.status(err.status || 500).json({ ok: false, error: err.message });
    }
});

// 4.3 Resumen de un equipo puntual: en vivo ahora / último resultado / próximo partido.
// Usa /teams/:id/matches, que trae los partidos del equipo en TODAS las competiciones
// en las que juega (liga local + copas internacionales), no solo una.
app.get("/api/team/:id/overview", async (req, res) => {
    const teamId = req.params.id;
    try {
        const [liveRes, lastRes, nextRes] = await Promise.all([
            fetchFootballData(`/teams/${teamId}/matches?status=LIVE`, 60 * 1000),
            fetchFootballData(`/teams/${teamId}/matches?status=FINISHED&dateFrom=${isoDaysAgo(45)}&dateTo=${todayISO()}`, 10 * 60 * 1000),
            fetchFootballData(`/teams/${teamId}/matches?status=SCHEDULED&dateFrom=${todayISO()}&dateTo=${isoInDays(45)}`, 10 * 60 * 1000)
        ]);
        const live = (liveRes.data.matches || []).map(normalizeMatch);
        const finished = lastRes.data.matches || [];
        const scheduled = nextRes.data.matches || [];
        // La API devuelve los partidos ordenados por fecha ascendente: el último
        // jugado es el final del array de finalizados, el próximo es el primero de los programados.
        const last = finished.length ? normalizeMatch(finished[finished.length - 1]) : null;
        const next = scheduled.length ? normalizeMatch(scheduled[0]) : null;
        res.json({ ok: true, response: { live, last, next } });
    } catch (err) {
        console.error(err.message);
        res.status(err.status || 500).json({ ok: false, error: err.message });
    }
});

// 5.1 Detalle de un partido puntual — para ver qué trae realmente tu plan
// (estadísticas, alineaciones, árbitro, etc). Probalo con un id que veas en
// la respuesta de /api/live, /api/results o /api/upcoming (campo "id").
app.get("/api/match/:id", async (req, res) => {
    try {
        const { data, fromCache } = await fetchFootballData(`/matches/${req.params.id}`, 30 * 1000);
        res.json({
            ok: true,
            cached: fromCache,
            normalized: normalizeMatchDetail(data),
            raw: data // dejamos el JSON crudo completo para poder ver TODO lo que manda la API
        });
    } catch (err) {
        console.error(err.message);
        res.status(err.status || 500).json({ ok: false, error: err.message });
    }
});

// 5.2 Status
// ======= RUTAS DE NOTIFICACIONES PUSH =======

// El frontend pide la clave pública para poder suscribirse (evita hardcodearla ahí también)
app.get("/api/push/public-key", (req, res) => {
    if (!VAPID_PUBLIC_KEY) return res.status(500).json({ ok: false, error: "VAPID_PUBLIC_KEY no configurada" });
    res.json({ ok: true, key: VAPID_PUBLIC_KEY });
});

// Guarda (o actualiza, si ya existe ese endpoint) la suscripción del navegador,
// asociada al equipo que el usuario eligió como favorito.
app.post("/api/push/subscribe", express.json(), async (req, res) => {
    if (!supabaseAdmin) return res.status(500).json({ ok: false, error: "Supabase no configurado en el backend" });
    const { subscription, teamId } = req.body || {};
    if (!subscription || !subscription.endpoint || !subscription.keys || !teamId) {
        return res.status(400).json({ ok: false, error: "Falta subscription o teamId" });
    }
    const { error } = await supabaseAdmin.from("push_subscriptions").upsert({
        endpoint: subscription.endpoint,
        team_id: String(teamId),
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth
    });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true });
});

// Manda una notificación de prueba DIRECTO a una suscripción puntual, sin tocar
// Supabase ni depender de ningún partido real — para confirmar rápido que todo
// el circuito (VAPID + service worker + navegador) funciona de punta a punta.
app.post("/api/push/test", express.json(), async (req, res) => {
    const { subscription } = req.body || {};
    if (!subscription || !subscription.endpoint || !subscription.keys) {
        return res.status(400).json({ ok: false, error: "Falta subscription" });
    }
    try {
        await webpush.sendNotification(
            subscription,
            JSON.stringify({
                title: "GolDigital",
                body: "Notificación de prueba — si ves esto, ¡el circuito funciona! 🎉",
                url: "/"
            })
        );
        res.json({ ok: true });
    } catch (err) {
        console.error("Error en push de prueba:", err.message);
        res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});

app.post("/api/push/unsubscribe", express.json(), async (req, res) => {
    if (!supabaseAdmin) return res.status(500).json({ ok: false, error: "Supabase no configurado en el backend" });
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ ok: false, error: "Falta endpoint" });
    await supabaseAdmin.from("push_subscriptions").delete().eq("endpoint", endpoint);
    res.json({ ok: true });
});

async function alreadyNotified(matchId, kind) {
    const { data } = await supabaseAdmin
        .from("push_notifications_sent")
        .select("match_id")
        .eq("match_id", String(matchId))
        .eq("kind", kind)
        .maybeSingle();
    return !!data;
}

async function markNotified(matchId, kind) {
    await supabaseAdmin.from("push_notifications_sent").insert({ match_id: String(matchId), kind });
}

async function notifySubscribers(subs, payload) {
    await Promise.all(
        subs.map(async (s) => {
            const pushSub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
            try {
                await webpush.sendNotification(pushSub, JSON.stringify(payload));
            } catch (err) {
                // 404/410 = el navegador invalidó esa suscripción (desinstaló, borró datos, etc.) — la limpiamos.
                if (err.statusCode === 404 || err.statusCode === 410) {
                    await supabaseAdmin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
                } else {
                    console.error("Error enviando push:", err.message);
                }
            }
        })
    );
}

// Disparador periódico — lo llama un cron externo (cron-job.org, GitHub Actions, etc.)
// cada 1-2 minutos, protegido por CRON_SECRET para que nadie más lo dispare.
app.get("/api/push/check", async (req, res) => {
    if (!CRON_SECRET || req.query.key !== CRON_SECRET) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    if (!supabaseAdmin) return res.status(500).json({ ok: false, error: "Supabase no configurado en el backend" });

    try {
        const { data: subs, error } = await supabaseAdmin.from("push_subscriptions").select("*");
        if (error) throw error;

        const teamIds = [...new Set((subs || []).map((s) => s.team_id))];
        let notificationsSent = 0;
        const today = todayISO();

        for (const teamId of teamIds) {
            const teamSubs = subs.filter((s) => s.team_id === teamId);

            const [liveRes, todayRes] = await Promise.all([
                fetchFootballData(`/teams/${teamId}/matches?status=LIVE`, 30 * 1000),
                fetchFootballData(`/teams/${teamId}/matches?status=SCHEDULED&dateFrom=${today}&dateTo=${today}`, 30 * 1000)
            ]);

            // 1) Arranca en los próximos 10 minutos
            for (const m of todayRes.data.matches || []) {
                const minsUntil = (new Date(m.utcDate).getTime() - Date.now()) / 60000;
                if (minsUntil > 0 && minsUntil <= 10 && !(await alreadyNotified(m.id, "starting"))) {
                    await notifySubscribers(teamSubs, {
                        title: "GolDigital",
                        body: `${m.homeTeam.name} vs ${m.awayTeam.name} arranca en breve`,
                        url: "/"
                    });
                    await markNotified(m.id, "starting");
                    notificationsSent++;
                }
            }

            // 2) Ya está en vivo
            for (const m of liveRes.data.matches || []) {
                if (!(await alreadyNotified(m.id, "live"))) {
                    const home = m.score?.fullTime?.home ?? 0;
                    const away = m.score?.fullTime?.away ?? 0;
                    await notifySubscribers(teamSubs, {
                        title: "¡Arrancó!",
                        body: `${m.homeTeam.name} ${home} - ${away} ${m.awayTeam.name}`,
                        url: "/"
                    });
                    await markNotified(m.id, "live");
                    notificationsSent++;
                }
            }
        }

        res.json({ ok: true, teamsChecked: teamIds.length, notificationsSent });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.get("/api/status", async (req, res) => {
    try {
        const r = await fetch(`${API_BASE}/competitions/PL`, { headers: { "X-Auth-Token": API_TOKEN } });
        const json = await r.json();
        res.json({ ok: r.ok, backend: "up", footballData: r.ok ? { name: json.name } : json });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Handler final: si algo tira error (ej. CORS rechazado) devolvemos JSON prolijo,
// no un stack trace HTML de Express.
app.use((err, req, res, next) => {
    console.error(err.message);
    res.status(err.status || 500).json({ ok: false, error: err.message || "Error interno" });
});

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    // Dejamos que Render reinicie el proceso en vez de seguir en un estado inconsistente.
    process.exit(1);
});

app.listen(PORT, () => {
    console.log(`GolDigital backend (football-data.org) en puerto ${PORT} — entorno: ${NODE_ENV}`);
    if (ALLOWED_ORIGINS.length) console.log(`CORS habilitado para: ${ALLOWED_ORIGINS.join(", ")}`);
});
