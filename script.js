// SRF Sport Grayjay plugin
// Data flow:
//   1. GET https://sport.api.swisstxt.ch/v1/live_events?lang=de&date=<today>&ignoreLCNextDay=true
//      -> list of events for today (id, displayTitle, sport, dateTimeInfo, state, ...)
//   2. GET https://event.api.swisstxt.ch/v2/events/srf/byEventItemId/?eids=<comma-separated ids>
//      -> per-event details (hls, imageUrl, duration, description, category, ...)
//      Events that are not returned have no playable stream and are dropped.
//   3. On playback, GET https://tp.srgssr.ch/akahd/token?acl=<acl from hls path>
//      -> { token: { authparams: "hdnts=..." } }
//      Build final HLS url by appending "?<authparams>" to the master m3u8 url.
//      Token is only valid ~30s, but the variant streams inside the returned
//      manifest carry their own longer-lived `hdntl` tokens, so once the player
//      has fetched the master playlist it does not need to refetch it.

const PLATFORM = "SRFSport";
const PLATFORM_DISPLAY = "SRF Sport";

const LIVE_EVENTS_URL   = "https://sport.api.swisstxt.ch/v1/live_events";
const EVENT_DETAILS_URL = "https://event.api.swisstxt.ch/v2/events/srf/byEventItemId/";
const TOKEN_URL         = "https://tp.srgssr.ch/akahd/token";

const EVENT_URL_PREFIX  = "https://www.srf.ch/sport/event/";
const CHANNEL_URL_PREFIX = "https://www.srf.ch/sport/sport/";

const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Accept": "*/*",
    "Accept-Language": "de"
};

let _config = {};

source.enable = function (conf /*, settings, savedState */) {
    _config = conf || {};
};

source.disable = function () {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayDateString() {
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

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

// Build the authenticated master HLS url for an event.
// Given e.g. https://srgssrlsvech-d.akamaized.net/out/v1/<id>/index.m3u8 ->
//   ACL: /out/v1/<id>/*
//   Token: GET TOKEN_URL?acl=<acl> -> token.authparams
//   Result: <original hls>?<authparams>
function buildAuthenticatedHlsUrl(hlsUrl) {
    if (!hlsUrl) throw new ScriptException("Event has no HLS stream");

    // Derive ACL from the URL path: replace the last path segment with "*".
    const pathStart = hlsUrl.indexOf("/", hlsUrl.indexOf("://") + 3);
    const path = hlsUrl.substring(pathStart);
    const lastSlash = path.lastIndexOf("/");
    const acl = path.substring(0, lastSlash + 1) + "*";

    const tokenUrl = TOKEN_URL + "?acl=" + encodeURIComponent(acl);
    const tokenResp = httpGetJson(tokenUrl);

    const authparams = tokenResp && tokenResp.token && tokenResp.token.authparams;
    if (!authparams) throw new ScriptException("Failed to obtain Akamai token");

    return hlsUrl + (hlsUrl.indexOf("?") === -1 ? "?" : "&") + authparams;
}

// Returns a map { eventItemId(string) -> detailObject } for the given ids.
function fetchEventDetails(ids) {
    if (!ids || ids.length === 0) return {};

    // Endpoint accepts a comma-separated list. Chunk to keep URL length sane.
    const chunkSize = 50;
    const out = {};
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const url = EVENT_DETAILS_URL + "?eids=" + chunk.join(",");
        let data;
        try {
            data = httpGetJson(url);
        } catch (e) {
            log("SRF: details fetch failed: " + e);
            continue;
        }
        if (Array.isArray(data)) {
            for (const item of data) {
                if (item && item.eventItemId) out[String(item.eventItemId)] = item;
            }
        }
    }
    return out;
}

function authorFor(sportName) {
    const name = sportName || "Sport";
    return new PlatformAuthorLink(
        new PlatformID(PLATFORM, "sport-" + name, _config.id),
        name,
        CHANNEL_URL_PREFIX + encodeURIComponent(name),
        null
    );
}

function thumbnailsFor(detail) {
    const url = detail && (detail.imageUrl
        || (detail.analyticsMetadata && detail.analyticsMetadata.media_thumbnail));
    if (!url) return new Thumbnails([]);
    return new Thumbnails([new Thumbnail(url, 0)]);
}

// Maps a (live_events event, detail object) pair to a PlatformVideo.
function eventToPlatformVideo(event, detail) {
    const id = String(event.id);
    const category = (detail.category || "").toLowerCase(); // past | live | upcoming
    const state = event.state || "";                        // Planned | Live | Finished

    const isLive = category === "live" || state === "Live";
    const isPlanned = !isLive && (category === "upcoming" || state === "Planned");

    let name = event.displayTitle || detail.title || "Event " + id;
    if (isPlanned) name = "[Geplant] " + name;

    // Prefer the actual start time from details, fall back to event timestamp.
    const uploadDate = toUnix(detail.startDate)
        || toUnix(event.dateTimeInfo && event.dateTimeInfo.fullDateTime);

    // Duration in seconds. For planned events leave at 0.
    let duration = 0;
    if (typeof detail.duration === "number" && detail.duration > 0) {
        duration = Math.round(detail.duration / 1000);
    } else if (detail.startDate && detail.endDate) {
        duration = Math.max(0, toUnix(detail.endDate) - toUnix(detail.startDate));
    }

    const sportName = (event.sport && event.sport.name) || detail.sport || "Sport";

    return new PlatformVideo({
        id: new PlatformID(PLATFORM, id, _config.id),
        name: name,
        thumbnails: thumbnailsFor(detail),
        author: authorFor(sportName),
        uploadDate: uploadDate,
        duration: duration,
        viewCount: -1,
        url: EVENT_URL_PREFIX + id,
        isLive: isLive
    });
}

// ---------------------------------------------------------------------------
// Grayjay API
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

    // Sort: live first, then planned (soonest first), then finished (newest first).
    const rank = ev => {
        const det = details[String(ev.id)];
        const cat = (det && (det.category || "").toLowerCase()) || ev.state;
        if (cat === "live" || ev.state === "Live") return 0;
        if (cat === "upcoming" || ev.state === "Planned") return 1;
        return 2;
    };

    const videos = events
        .filter(e => details[String(e.id)])
        .sort((a, b) => {
            const ra = rank(a), rb = rank(b);
            if (ra !== rb) return ra - rb;
            const ta = toUnix((a.dateTimeInfo || {}).fullDateTime);
            const tb = toUnix((b.dateTimeInfo || {}).fullDateTime);
            // Planned ascending (soonest first), past descending (newest first), live by time desc.
            return ra === 1 ? ta - tb : tb - ta;
        })
        .map(e => eventToPlatformVideo(e, details[String(e.id)]));

    return new VideoPager(videos, false, {});
};

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

    const sportName = detail.sport || "Sport";
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
        const authedUrl = buildAuthenticatedHlsUrl(detail.hls);
        const hls = new HLSSource({
            name: "HLS",
            duration: duration,
            url: authedUrl,
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
        author: authorFor(sportName),
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
// Unused features – Grayjay still calls some of them, return empty stubs.
// ---------------------------------------------------------------------------

source.searchSuggestions = function () { return []; };
source.getSearchCapabilities = function () {
    return { types: [Type.Feed.Videos], sorts: [], filters: [] };
};
source.search = function () { return new VideoPager([], false, {}); };

source.isChannelUrl = function () { return false; };

log("SRF Sport plugin loaded");
