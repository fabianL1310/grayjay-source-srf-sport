// SRF Sport Grayjay plugin
//
// Data flow:
//   1. GET https://sport.api.swisstxt.ch/v1/live_events?lang=de&date=<YYYY-MM-DD>&ignoreLCNextDay=true
//      -> list of events for that day (id, displayTitle, sport, dateTimeInfo, state, ...)
//      Also: ?lang=de&sport=<GermanName> (without date) returns upcoming/today for that sport.
//      Note: combining date+sport server-side returns []; for historical sport listings,
//      iterate by date and filter client-side by event.sport.key.
//   2. GET https://event.api.swisstxt.ch/v2/events/srf/byEventItemId/?eids=<comma-separated ids>
//      -> per-event details (hls, imageUrl, duration, description, category, streamType, ...)
//      Events that are not returned have no playable stream and are dropped.
//   3. GET https://sport.api.swisstxt.ch/v1/sports?lang=de
//      -> [{ id, key, name, group? }, ...]  used to map channel-url segments to German names.
//   4. On playback, GET https://tp.srgssr.ch/akahd/token?acl=<acl>
//      -> { token: { authparams: "hdnts=..." } }
//      Build authenticated master HLS url by appending ?<authparams>.
//   5. Fetch the master manifest server-side, rewrite each variant URI to be absolute and
//      to carry "?start=0" (otherwise MediaPackage serves only the last ~30s of the DVR even
//      after the event ends and ENDLIST is present). Return the rewritten manifest to the
//      player as a data: URL. The per-variant `hdntl` token is path-based and covers all
//      segments, so the player never needs to re-fetch the master.
//
// Channel concept:
//   Each SRF "sport" (Fussball, Eishockey, Tennis, ...) is exposed as a Grayjay channel.
//   Canonical channel URL: https://www.srf.ch/sport/<key>  (key from /v1/sports).

const PLATFORM = "SRFSport";
const PLATFORM_DISPLAY = "SRF Sport";

const LIVE_EVENTS_URL    = "https://sport.api.swisstxt.ch/v1/live_events";
const EVENT_DETAILS_URL  = "https://event.api.swisstxt.ch/v2/events/srf/byEventItemId/";
const SPORTS_LIST_URL    = "https://sport.api.swisstxt.ch/v1/sports";
const TOKEN_URL          = "https://tp.srgssr.ch/akahd/token";

const EVENT_URL_PREFIX   = "https://www.srf.ch/sport/event/";
const CHANNEL_URL_PREFIX = "https://www.srf.ch/sport/";

// How many days back the channel pager walks per "next page" call,
// and the hard cutoff (live_events retention is on the order of weeks).
const CHANNEL_DAYS_PER_PAGE = 7;
const CHANNEL_MAX_DAYS_BACK = 60;

const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Accept": "*/*",
    "Accept-Language": "de"
};

let _config = {};

// Lazy-loaded sport list: { key: { id, key, name, group? } }
let _sportsByKey = null;
// Reverse: lower-cased name -> key (so we can also recognise URLs that use the German name).
let _sportsByName = null;

source.enable = function (conf /*, settings, savedState */) {
    _config = conf || {};
};

source.disable = function () {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d) {
    const pad = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function todayDateString() { return formatDate(new Date()); }

function toUnix(iso) {
    if (!iso) return 0;
    const t = Date.parse(iso);
    return isNaN(t) ? 0 : Math.floor(t / 1000);
}

function httpGetJson(url, headers) {
    const resp = http.GET(url, headers || DEFAULT_HEADERS, false);
    if (!resp.isOk) {
        throw new ScriptException("Request failed (" + resp.code + "): " + url);
    }
    try {
        return JSON.parse(resp.body);
    } catch (e) {
        throw new ScriptException("Invalid JSON from " + url + ": " + e);
    }
}

function loadSports() {
    if (_sportsByKey) return;
    _sportsByKey = {};
    _sportsByName = {};
    try {
        const list = httpGetJson(SPORTS_LIST_URL + "?lang=de");
        if (Array.isArray(list)) {
            for (const s of list) {
                if (!s || !s.key) continue;
                _sportsByKey[s.key.toLowerCase()] = s;
                if (s.name) _sportsByName[s.name.toLowerCase()] = s;
            }
        }
    } catch (e) {
        log("SRF: failed to load sports list: " + e);
    }
}

function resolveSport(segment) {
    if (!segment) return null;
    loadSports();
    const key = decodeURIComponent(segment).toLowerCase();
    if (_sportsByKey[key]) return _sportsByKey[key];
    if (_sportsByName[key]) return _sportsByName[key];
    // Fallback: synthesize a minimal record so channel pages still work for unknown keys.
    return { key: key, name: key };
}

// ---------------------------------------------------------------------------
// HLS / token handling
// ---------------------------------------------------------------------------

function aclFromHlsUrl(hlsUrl) {
    const pathStart = hlsUrl.indexOf("/", hlsUrl.indexOf("://") + 3);
    const path = hlsUrl.substring(pathStart);
    const q = path.indexOf("?");
    const pathOnly = q === -1 ? path : path.substring(0, q);
    const lastSlash = pathOnly.lastIndexOf("/");
    return pathOnly.substring(0, lastSlash + 1) + "*";
}

function fetchAkamaiAuthparams(hlsUrl) {
    const acl = aclFromHlsUrl(hlsUrl);
    const tokenResp = httpGetJson(TOKEN_URL + "?acl=" + encodeURIComponent(acl));
    const authparams = tokenResp && tokenResp.token && tokenResp.token.authparams;
    if (!authparams) throw new ScriptException("Failed to obtain Akamai token");
    return authparams;
}

function authenticatedMasterUrl(hlsUrl, startTime) {
    const authparams = fetchAkamaiAuthparams(hlsUrl);
    let url = hlsUrl + (hlsUrl.indexOf("?") === -1 ? "?" : "&") + authparams;
    if (startTime) {
        const u = new URL(url);
        u.searchParams.set("start", String(startTime));
        url = u.toString();
    }
    return url;
}

// Resolve a possibly relative URI against a base URL.
function absoluteUrl(uri, baseUrl) {
    if (/^https?:\/\//i.test(uri)) return uri;
    if (uri.indexOf("//") === 0) {
        const scheme = baseUrl.substring(0, baseUrl.indexOf(":"));
        return scheme + ":" + uri;
    }
    if (uri.charAt(0) === "/") {
        const m = /^(https?:\/\/[^\/]+)/i.exec(baseUrl);
        return (m ? m[1] : "") + uri;
    }
    // Strip query/fragment from base, then take its directory.
    let b = baseUrl;
    const q = b.indexOf("?");
    if (q !== -1) b = b.substring(0, q);
    const h = b.indexOf("#");
    if (h !== -1) b = b.substring(0, h);
    const slash = b.lastIndexOf("/");
    return b.substring(0, slash + 1) + uri;
}

function appendStartZero(url) {
    return url + (url.indexOf("?") === -1 ? "?" : "&") + "start=0";
}

// Fetch the live/DVR master manifest, rewrite variant URIs so the player gets the full
// recording instead of the last ~30 s of the sliding window. Returned as a data: URL.
function buildFullDvrMasterDataUrl(hlsUrl, startTime) {
    const masterUrl = authenticatedMasterUrl(hlsUrl, startTime);
    const resp = http.GET(masterUrl, DEFAULT_HEADERS, false);
    if (!resp.isOk) {
        throw new ScriptException("Failed to fetch master manifest (" + resp.code + ")");
    }
    const body = resp.body || "";
    const lines = body.split(/\r?\n/);
    const out = [];
    const uriAttrRe = /URI="([^"]+)"/;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.length === 0) { out.push(line); continue; }
        if (trimmed.charAt(0) === "#") {
            // Rewrite URI="..." attributes (EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF, ...).
            const m = uriAttrRe.exec(line);
            if (m) {
                const abs = absoluteUrl(m[1], masterUrl);
                const fixed = appendStartZero(abs);
                out.push(line.replace(uriAttrRe, 'URI="' + fixed + '"'));
            } else {
                out.push(line);
            }
            continue;
        }
        // Plain variant URI line.
        const abs = absoluteUrl(trimmed, masterUrl);
        out.push(appendStartZero(abs));
    }
    const rewritten = out.join("\n");
    return "data:application/vnd.apple.mpegurl;charset=utf-8," + encodeURIComponent(rewritten);
}

// ---------------------------------------------------------------------------
// Event detail / video mapping
// ---------------------------------------------------------------------------

function fetchEventDetails(ids) {
    if (!ids || ids.length === 0) return {};
    const chunkSize = 50;
    const out = {};
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const url = EVENT_DETAILS_URL + "?eids=" + chunk.join(",");
        let data;
        try { data = httpGetJson(url); }
        catch (e) { log("SRF: details fetch failed: " + e); continue; }
        if (Array.isArray(data)) {
            for (const item of data) {
                if (item && item.eventItemId) out[String(item.eventItemId)] = item;
            }
        }
    }
    return out;
}

function authorFor(sport) {
    // `sport` can be the event.sport object, the detail.sport string, or just a name.
    let key = null, name = null;
    if (sport && typeof sport === "object") {
        key = sport.key || null;
        name = sport.name || null;
    } else if (typeof sport === "string") {
        // detail.sport is the lower-case key (e.g. "football"); try to resolve to a name.
        key = sport;
        loadSports();
        const rec = _sportsByKey[sport.toLowerCase()];
        if (rec) name = rec.name;
    }
    if (!key && name) {
        loadSports();
        const rec = _sportsByName[name.toLowerCase()];
        if (rec) key = rec.key;
    }
    if (!key) key = "sport";
    if (!name) name = key;
    return new PlatformAuthorLink(
        new PlatformID(PLATFORM, "sport-" + key, _config.id),
        name,
        CHANNEL_URL_PREFIX + encodeURIComponent(key),
        null
    );
}

function thumbnailsFor(detail) {
    const url = detail && (detail.imageUrl
        || (detail.analyticsMetadata && detail.analyticsMetadata.media_thumbnail));
    if (!url) return new Thumbnails([]);
    return new Thumbnails([new Thumbnail(url, 0)]);
}

function eventToPlatformVideo(event, detail) {
    const id = String(event.id);
    const category = (detail.category || "").toLowerCase(); // past | live | upcoming
    const state = event.state || "";                        // Planned | Live | Finished

    const isLive = category === "live" || state === "Live";
    const isPlanned = !isLive && (category === "upcoming" || state === "Planned");

    let name = event.displayTitle || detail.title || "Event " + id;
    if (isPlanned) name = "[Geplant] " + name;

    const uploadDate = toUnix(detail.startDate)
        || toUnix(event.dateTimeInfo && event.dateTimeInfo.fullDateTime);

    let duration = 0;
    if (typeof detail.duration === "number" && detail.duration > 0) {
        duration = Math.round(detail.duration / 1000);
    } else if (detail.startDate && detail.endDate) {
        duration = Math.max(0, toUnix(detail.endDate) - toUnix(detail.startDate));
    }

    const sportObj = (event.sport && typeof event.sport === "object")
        ? event.sport
        : (detail.sport || "Sport");

    return new PlatformVideo({
        id: new PlatformID(PLATFORM, id, _config.id),
        name: name,
        thumbnails: thumbnailsFor(detail),
        author: authorFor(sportObj),
        uploadDate: uploadDate,
        duration: duration,
        viewCount: -1,
        url: EVENT_URL_PREFIX + id,
        isLive: isLive
    });
}

// Generic helper: takes raw live_events results, fetches details, returns PlatformVideos.
function eventsToVideos(events) {
    if (!Array.isArray(events) || events.length === 0) return [];
    const ids = events.map(e => String(e.id));
    const details = fetchEventDetails(ids);
    return events
        .filter(e => details[String(e.id)])
        .map(e => eventToPlatformVideo(e, details[String(e.id)]));
}

function sortHomeEvents(events, details) {
    const rank = ev => {
        const det = details[String(ev.id)];
        const cat = (det && (det.category || "").toLowerCase()) || ev.state;
        if (cat === "live" || ev.state === "Live") return 0;
        if (cat === "upcoming" || ev.state === "Planned") return 1;
        return 2;
    };
    return events.slice().sort((a, b) => {
        const ra = rank(a), rb = rank(b);
        if (ra !== rb) return ra - rb;
        const ta = toUnix((a.dateTimeInfo || {}).fullDateTime);
        const tb = toUnix((b.dateTimeInfo || {}).fullDateTime);
        return ra === 1 ? ta - tb : tb - ta;
    });
}

// ---------------------------------------------------------------------------
// Grayjay API: Home
// ---------------------------------------------------------------------------

source.getHome = function () {
    let events;
    try {
        events = httpGetJson(LIVE_EVENTS_URL
            + "?lang=de&date=" + todayDateString()
            + "&ignoreLCNextDay=true");
    } catch (e) {
        log("SRF: failed to load live events: " + e);
        return new VideoPager([], false, {});
    }
    if (!Array.isArray(events) || events.length === 0) {
        return new VideoPager([], false, {});
    }
    const ids = events.map(e => String(e.id));
    const details = fetchEventDetails(ids);
    const videos = sortHomeEvents(events, details)
        .filter(e => details[String(e.id)])
        .map(e => eventToPlatformVideo(e, details[String(e.id)]));
    return new VideoPager(videos, false, {});
};

// ---------------------------------------------------------------------------
// Grayjay API: Content details
// ---------------------------------------------------------------------------

source.isContentDetailsUrl = function (url) {
    return typeof url === "string" && url.indexOf(EVENT_URL_PREFIX) === 0;
};

source.getContentDetails = function (url) {
    const id = url.substring(EVENT_URL_PREFIX.length).split(/[?#/]/)[0];
    if (!id) throw new ScriptException("Invalid event url: " + url);

    const details = fetchEventDetails([id]);
    const detail = details[id];
    if (!detail) throw new ScriptException("Event " + id + " has no playable stream");

    const category = (detail.category || "").toLowerCase();
    const isLive = category === "live";
    const isPlanned = category === "upcoming";

    const sportObj = detail.sport || "Sport";
    let name = detail.title || "Event " + id;
    if (isPlanned) name = "[Geplant] " + name;

    const uploadDate = toUnix(detail.startDate);
    let duration = 0;
    if (typeof detail.duration === "number" && detail.duration > 0) {
        duration = Math.round(detail.duration / 1000);
    } else if (detail.startDate && detail.endDate) {
        duration = Math.max(0, toUnix(detail.endDate) - toUnix(detail.startDate));
    }

    let videoSource = null;
    let liveSource = null;

    if (detail.hls && !isPlanned) {
        // Always rewrite the master to force ?start=0 on variants. Without this,
        // MediaPackage serves only the last ~30 s of the sliding DVR window
        // (even for finished events that have ENDLIST in the variant playlist).
        const startTime = toUnix(detail.startDate);
        let manifestUrl;
        try {
            manifestUrl = buildFullDvrMasterDataUrl(detail.hls, startTime);
        } catch (e) {
            log("SRF: manifest rewrite failed, falling back to raw master: " + e);
            manifestUrl = authenticatedMasterUrl(detail.hls, startTime);
        }

        const hls = new HLSSource({
            name: "HLS",
            duration: duration,
            url: manifestUrl,
            priority: true,
            language: (detail.analyticsMetadata && detail.analyticsMetadata.media_language) || "ger"
        });
        if (isLive) {
            liveSource = hls;
        } else {
            videoSource = new VideoSourceDescriptor([hls]);
        }
    }

    return new PlatformVideoDetails({
        id: new PlatformID(PLATFORM, id, _config.id),
        name: name,
        thumbnails: thumbnailsFor(detail),
        author: authorFor(sportObj),
        uploadDate: uploadDate,
        duration: duration,
        viewCount: -1,
        url: EVENT_URL_PREFIX + id,
        isLive: isLive,
        description: detail.description || "",
        video: videoSource || new VideoSourceDescriptor([]),
        live: liveSource,
        rating: null,
        subtitles: []
    });
};

// ---------------------------------------------------------------------------
// Grayjay API: Channels (one channel per sport)
// ---------------------------------------------------------------------------

source.isChannelUrl = function (url) {
    if (typeof url !== "string") return false;
    if (url.indexOf(CHANNEL_URL_PREFIX) !== 0) return false;
    const rest = url.substring(CHANNEL_URL_PREFIX.length).split(/[?#]/)[0];
    if (!rest) return false;
    // The /sport/event/ path is the per-video URL, not a channel.
    if (rest.indexOf("event/") === 0) return false;
    // Single-segment paths only (e.g. "fussball", "eishockey"), no further slashes.
    if (rest.indexOf("/") !== -1 && rest.indexOf("/") !== rest.length - 1) return false;
    return true;
};

source.getChannel = function (url) {
    const segment = url.substring(CHANNEL_URL_PREFIX.length).split(/[?#/]/)[0];
    const sport = resolveSport(segment);
    const channelUrl = CHANNEL_URL_PREFIX + encodeURIComponent(sport.key);
    return new PlatformChannel({
        id: new PlatformID(PLATFORM, "sport-" + sport.key, _config.id),
        name: sport.name,
        thumbnail: null,
        banner: null,
        subscribers: -1,
        description: "SRF Sport – " + sport.name,
        url: channelUrl,
        links: {}
    });
};

source.getChannelCapabilities = function () {
    return {
        types: [Type.Feed.Mixed],
        sorts: []
    };
};

// Pager that walks back day-by-day, filtering by sport.key client-side.
class SrfSportChannelPager extends VideoPager {
    constructor(results, hasMore, context) {
        super(results, hasMore, context);
    }
    nextPage() {
        const ctx = this.context || {};
        const videos = [];
        let daysBack = ctx.daysBack || 0;
        let exhausted = false;
        let queriedDays = 0;
        while (queriedDays < CHANNEL_DAYS_PER_PAGE) {
            daysBack += 1;
            if (daysBack > CHANNEL_MAX_DAYS_BACK) { exhausted = true; break; }
            const d = new Date();
            d.setDate(d.getDate() - daysBack);
            const dateStr = formatDate(d);
            queriedDays += 1;
            let events;
            try {
                events = httpGetJson(LIVE_EVENTS_URL
                    + "?lang=de&date=" + dateStr + "&ignoreLCNextDay=true");
            } catch (e) {
                log("SRF: channel page fetch failed for " + dateStr + ": " + e);
                continue;
            }
            if (!Array.isArray(events) || events.length === 0) continue;
            const filtered = events.filter(e =>
                e && e.sport && (
                    (e.sport.key && e.sport.key.toLowerCase() === ctx.key) ||
                    (e.sport.name && ctx.name && e.sport.name.toLowerCase() === ctx.name.toLowerCase())
                )
            );
            if (filtered.length === 0) continue;
            const mapped = eventsToVideos(filtered);
            for (const v of mapped) videos.push(v);
        }
        ctx.daysBack = daysBack;
        this.context = ctx;
        this.results = videos;
        this.hasMore = !exhausted && daysBack < CHANNEL_MAX_DAYS_BACK;
        return this;
    }
}

source.getChannelContents = function (url, type, order, filters) {
    const segment = url.substring(CHANNEL_URL_PREFIX.length).split(/[?#/]/)[0];
    const sport = resolveSport(segment);
    const keyLc = sport.key.toLowerCase();
    const nameLc = (sport.name || "").toLowerCase();

    // First page: today's events plus upcoming (server-side sport filter is reliable
    // when no date is given, but we still want to include actual past events for "today"
    // so we also fetch today by date and merge.).
    const initial = [];
    const seen = {};

    try {
        const todayEvents = httpGetJson(LIVE_EVENTS_URL
            + "?lang=de&date=" + todayDateString() + "&ignoreLCNextDay=true");
        if (Array.isArray(todayEvents)) {
            for (const e of todayEvents) {
                if (!e || !e.sport) continue;
                const k = (e.sport.key || "").toLowerCase();
                const n = (e.sport.name || "").toLowerCase();
                if (k === keyLc || (nameLc && n === nameLc)) {
                    const id = String(e.id);
                    if (!seen[id]) { seen[id] = true; initial.push(e); }
                }
            }
        }
    } catch (e) {
        log("SRF: today fetch for channel failed: " + e);
    }

    try {
        const upcoming = httpGetJson(LIVE_EVENTS_URL
            + "?lang=de&sport=" + encodeURIComponent(sport.name || sport.key));
        if (Array.isArray(upcoming)) {
            for (const e of upcoming) {
                if (!e) continue;
                const id = String(e.id);
                if (!seen[id]) { seen[id] = true; initial.push(e); }
            }
        }
    } catch (e) {
        log("SRF: upcoming fetch for channel failed: " + e);
    }

    // Sort live > planned > finished, then by time as in home.
    const ids0 = initial.map(e => String(e.id));
    const det0 = fetchEventDetails(ids0);
    const videos = sortHomeEvents(initial, det0)
        .filter(e => det0[String(e.id)])
        .map(e => eventToPlatformVideo(e, det0[String(e.id)]));

    return new SrfSportChannelPager(videos, true, {
        key: keyLc,
        name: sport.name || sport.key,
        daysBack: 0
    });
};

// Optional: search within a channel — simple client-side title filter over the
// channel's content. (No server-side endpoint exists for searching a sport.)
source.getSearchChannelContentsCapabilities = function () {
    return { types: [Type.Feed.Mixed], sorts: [] };
};

source.searchChannelContents = function (channelUrl, query, type, order, filters) {
    const q = (query || "").toLowerCase().trim();
    const base = source.getChannelContents(channelUrl, type, order, filters);
    if (!q) return base;
    const match = v => (v && v.name && v.name.toLowerCase().indexOf(q) !== -1);
    base.results = (base.results || []).filter(match);
    // Wrap so nextPage() also filters.
    const inner = base;
    return new (class extends VideoPager {
        constructor() { super(inner.results, inner.hasMore, inner.context); }
        nextPage() {
            inner.nextPage();
            this.results = (inner.results || []).filter(match);
            this.hasMore = inner.hasMore;
            this.context = inner.context;
            return this;
        }
    })();
};

// ---------------------------------------------------------------------------
// Search (platform-wide). The SRF Sport API has no general search endpoint;
// the best we can do is filter today's events by title.
// ---------------------------------------------------------------------------

source.searchSuggestions = function () { return []; };

source.getSearchCapabilities = function () {
    return { types: [Type.Feed.Videos], sorts: [], filters: [] };
};

source.search = function (query /*, type, order, filters */) {
    const q = (query || "").toLowerCase().trim();
    if (!q) return new VideoPager([], false, {});
    let events;
    try {
        events = httpGetJson(LIVE_EVENTS_URL
            + "?lang=de&date=" + todayDateString() + "&ignoreLCNextDay=true");
    } catch (e) {
        log("SRF: search fetch failed: " + e);
        return new VideoPager([], false, {});
    }
    if (!Array.isArray(events)) return new VideoPager([], false, {});
    const filtered = events.filter(e => {
        const t = (e.displayTitle || "").toLowerCase();
        const sn = (e.sport && e.sport.name || "").toLowerCase();
        return t.indexOf(q) !== -1 || sn.indexOf(q) !== -1;
    });
    return new VideoPager(eventsToVideos(filtered), false, {});
};

log("SRF Sport plugin loaded");
