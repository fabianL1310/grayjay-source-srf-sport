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
var _settings = {};

source.enable = function (config, settings) {
    _config = config || {};
    _settings = settings || {};
};

source.setSettings = function (settings) {
    _settings = settings;
};

source.reEnable = (config, settings) => {
    return source.enable(config ?? _config, settings ?? _settings);
};

source.disable = function () {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// TODO caching?
const fetchJson = (url) => {
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

const sortDetails = (a, b) => {
    if (_settings.showLiveFirst && a.category !== b.category) {
        if (a.category === "present") return -1;
        if (b.category === "present") return 1;
    }
    return new Date(a.startDate) - new Date(b.startDate);
};

const getPlatformVideo = (detail) => {
    const state = (detail.category || "").toLowerCase(); // past | present | future

    return new PlatformVideo({
        id: new PlatformID(PLATFORM, detail.eventItemId, _config.id),
        name: detail.title || "Event " + detail.eventItemId,
        thumbnails: new Thumbnails([new Thumbnail(detail.imageUrl)]),
        author: getAuthor(detail.sport),
        uploadDate: Math.round(new Date(detail.startDate).getTime() / 1000),
        duration: Math.round(detail.duration / 1000),
        viewCount: 1,
        // TODO make to URL helper/const
        url: `https://www.srf.ch/sport/resultcenter/live/${detail.sport}/${detail.eventItemId}`,
        isLive: state === "present" || state === "future",
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
    // TODO use actual start and end times
    authHlsUrl.searchParams.set("start", "0");

    return authHlsUrl.toString();
};

// ---------------------------------------------------------------------------
// Grayjay API
// ---------------------------------------------------------------------------

source.getHome = () => {
    let events = [];
    const url = new URL(EVENTS_URL);
    try {
      // date is not needed to get todays events
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

    const videos = Object.values(details)
        .sort(sortDetails)
        .map(getPlatformVideo);
    return new VideoPager(videos, false, {});
};

source.getContentDetails = (url) => {
    url = new URL(url);
    const eventId = url.pathname.split("/").pop();
    if (!eventId) throw new ScriptException("Invalid event URL: " + url);

    const details = fetchEventDetails([eventId])[eventId];
    if (!details) throw new ScriptException("Event not found: " + eventId);

    const plattformVideo = getPlatformVideo(details);

    const getVideoSource = () => {
        if (new Date(details.startDate) > new Date()) {
            return {
                hls: null,
                live: null,
                video: new VideoSourceDescriptor([]),
            };
        }

        const hlsSource = new HLSSource({
            name: "HLS",
            duration: plattformVideo.duration,
            url: getAuthHlsUrl(details.hls),
            language: details.analyticsMetadata.media_language,
        });

        return {
            hls: hlsSource,
            live: plattformVideo.isLive ? hlsSource : null,
            video: new VideoSourceDescriptor([hlsSource]),
        };
    };

    return new PlatformVideoDetails({
        ...plattformVideo,
        ...getVideoSource(),
        description: details.description || "",
    });
};

source.isContentDetailsUrl = (url) => {
    return url.startsWith("https://www.srf.ch/sport/resultcenter/live");
};
