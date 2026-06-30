const PLATFORM = "SRFSport";
const PLATFORM_DISPLAY = "SRF Sport";

// **maybe** make language a setting
const EVENTS_URL =
    "https://sport.api.swisstxt.ch/v1/live_events?lang=de&ignoreLCNextDay=true";
const EVENT_DETAILS_URL =
    "https://event.api.swisstxt.ch/v2/events/srf/byEventItemId/";
const SPORTS_LIST_URL = "https://sport.api.swisstxt.ch/v1/sports";
const TOKEN_URL = "https://tp.srgssr.ch/akahd/token";
const STREAM_URL = "https://srgssrlsvech-d.akamaized.net";

let _config = {};

source.enable = function (config) {
    _config = config || {};
};

source.disable = function () {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fetchJson = (url) => {
    log("SRF: fetching JSON from " + url);
    const response = http.GET(url.toString(), {}, false);
    if (!response.isOk) {
        throw new ScriptException(
            "Request failed (" + response.code + "): " + url,
        );
    }
    try {
        return JSON.parse(response.body);
    } catch (e) {
        throw new ScriptException("Invalid JSON from " + url + ": " + e);
    }
};

const getDateString = (date = new Date()) => {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const getAuthor = (key) => {
    const url = new URL(SPORTS_LIST_URL);
    url.pathname += `/${key}`;
    const sport = fetchJson(url);

    return new PlatformAuthorLink(
        new PlatformID(PLATFORM, sport.key, _config.id),
        // name is currently json in 3 languages
        // TODO use language set in settings
        sport.name.de,
        // TODO
        `https://sport.api.swisstxt.ch/v1/sports/${sport.key}`,
    );
};

// ---------------------------------------------------------------------------
// Video/Event helpers
// ---------------------------------------------------------------------------
const fetchEventDetails = (eventIds) => {
    if (!eventIds || eventIds.length === 0) return {};
    try {
        const out = {};
        const url = new URL(EVENT_DETAILS_URL);
        url.searchParams.set("eids", eventIds.join(","));
        const data = fetchJson(url);
        for (const detail of data) {
            if (detail && detail.eventItemId) out[detail.eventItemId] = detail;
        }
        return out;
    } catch (e) {
        log("SRF: failed to load event details: " + e);
        return {};
    }
};

// TODO refactor this
/*function sortHomeEvents(events, details) {
    const rank = (event) => {
        const detail = details[event.id];
        // TODO description is like never provided so remove it
        const cat =
            (detail && (detail.category || "").toLowerCase()) || event.state;
        if (cat === "live" || event.state === "Live") return 0;
        if (cat === "upcoming" || event.state === "Planned") return 1;
        return 2;
    };
    return events.slice().sort((a, b) => {
        const ra = rank(a),
            rb = rank(b);
        if (ra !== rb) return ra - rb;
        const ta = toUnix((a.dateTimeInfo || {}).fullDateTime);
        const tb = toUnix((b.dateTimeInfo || {}).fullDateTime);
        return ra === 1 ? ta - tb : tb - ta;
    });
} */

const getPlatformVideo = (details) => {
    const state = (details.category || "").toLowerCase(); // past | live | future

    return new PlatformVideo({
        id: new PlatformID(PLATFORM, details.eventItemId, _config.id),
        name: details.title || "Event " + details.eventItemId,
        thumbnails: new Thumbnails([new Thumbnail(details.imageUrl)]),
        author: getAuthor(details.sport),
        uploadDate: Math.round(new Date(details.startDate).getTime() / 1000),
        duration: Math.round(details.duration / 1000),
        viewCount: 1,
        // TODO make to URL helper/const
        url: `https://www.srf.ch/sport/resultcenter/live/${details.sport}/${details.eventItemId}`,
        isLive: state === "live" || state === "future",
    });
};

const getAuthHlsUrl = (hls) => {
    hls = new URL(hls);
    const acl = hls.pathname.replace(/index\.m3u8$/, "*");
    const tokenUrl = new URL(TOKEN_URL);
    tokenUrl.searchParams.set("acl", acl);
    const { authparams } = fetchJson(tokenUrl).token;
    if (!authparams) throw new ScriptException("Failed to get auth token");

    const authHlsUrl = new URL(hls);
    authHlsUrl.searchParams.set("hdnts", authparams.replace("hdnts=", ""));
    authHlsUrl.searchParams.set("start", "0");

    log("authHLS URL: " + authHlsUrl.toString());
    log(http.GET(authHlsUrl.toString(), {}, false));

    return authHlsUrl.toString();
};

// ---------------------------------------------------------------------------
// Grayjay API
// ---------------------------------------------------------------------------

source.getHome = () => {
    let events = [];
    const url = new URL(EVENTS_URL);
    try {
        url.searchParams.set("date", getDateString());
        events.push(...fetchJson(url));
        url.searchParams.set(
            "date",
            getDateString(new Date(Date.now() - 24 * 60 * 60 * 1000)),
        );
        events.push(...fetchJson(url));
    } catch (e) {
        log("SRF: failed to load live events: " + e);
        return new VideoPager([], false, {});
    }

    if (!Array.isArray(events) || events.length === 0) {
        return new VideoPager([], false, {});
    }
    const ids = events.map((e) => e.id);
    const details = fetchEventDetails(ids);
    // const videos =
    //     // sortHomeEvents(events, details)
    //     events
    //         .filter((event) => details[event.id])
    //         .map((event) => getPlatformVideo(details[event.id]));
    const videos = Object.values(details).map((detail) =>
        getPlatformVideo(detail),
    );
    return new VideoPager(videos, false, {});
};

source.getContentDetails = (url) => {
    log("-------------------getContentDetails: " + url);
    url = new URL(url);
    const eventId = url.pathname.split("/").pop();
    if (!eventId) throw new ScriptException("Invalid event URL: " + url);

    const details = fetchEventDetails([eventId])[eventId];
    if (!details) throw new ScriptException("Event not found: " + eventId);

    const plattformVideo = getPlatformVideo(details);
    // const videoSourceDescriptor = new VideoSourceDescriptor([
    //     new HLSSource({
    //         name: "HLS",
    //         duration: plattformVideo.duration,
    //         url: getAuthHlsUrl(details.hls),
    //         // TODO maybe use settings lang
    //         language: details.analyticsMetadata.media_language,
    //     }),
    // ]);

    // TODO maybe set the not needed one to null
    // const videoSource = {};
    // const startDate = new Date(details.startDate);
    // const endDate = new Date(details.endDate);
    // if (startDate < new Date()) {
    //     // Stream is available
    //     if (endDate < new Date()) {
    //         videoSource.hls = videoSourceDescriptor;
    //     } else {
    //         videoSource.live = videoSourceDescriptor;
    //     }
    // }
    // TODO maybe do this:
    // else{
    //   // videoSource.video = new VideoSourceDescriptor([])
    // }

    const hlsSource = new HLSSource({
        name: "HLS",
        duration: plattformVideo.duration,
        url: getAuthHlsUrl(details.hls),
        // url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
        language: details.analyticsMetadata.media_language,
    });

    const videoSource = {
        // live: hlsSource,
        video: new VideoSourceDescriptor([hlsSource]),
    };

    return new PlatformVideoDetails({
        ...plattformVideo,
        ...videoSource,
        description: details.description || "",
    });
};

source.isContentDetailsUrl = (url) => {
    return url.startsWith("https://www.srf.ch/sport/resultcenter/live");
};
