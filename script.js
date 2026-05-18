const PLATFORM = "SRF Sport";
const PLATFORM_URL = "https://www.srf.ch/sport";
const IL_BASE = "https://il.srf.ch/integrationlayer/2.0";
const SPORT_TOPIC_ID = "649e36d7-ff57-41c8-9c1b-7892daf15e78";

const SPORT_CATEGORIES = {
    "fussball": { name: "Fussball", keywords: ["fussball", "super league", "champions league", "europa league", "bundesliga", "premier league", "serie a", "la liga", "goal"] },
    "eishockey": { name: "Eishockey", keywords: ["eishockey", "hockey", "nhl", "national league"] },
    "tennis": { name: "Tennis", keywords: ["tennis", "atp", "wta", "wimbledon", "roland garros", "us open", "australian open"] },
    "ski": { name: "Ski / Wintersport", keywords: ["ski", "snowboard", "langlauf", "biathlon", "bob", "skeleton", "curling", "wintersport", "abfahrt", "slalom", "riesenslalom"] },
    "rad": { name: "Radsport", keywords: ["rad", "radsport", "tour de", "giro", "vuelta", "cycling", "velo"] },
    "leichtathletik": { name: "Leichtathletik", keywords: ["leichtathletik", "marathon", "sprint", "athletics"] },
    "motorsport": { name: "Motorsport", keywords: ["motorsport", "formel 1", "f1", "motogp", "formel e"] },
    "schwingen": { name: "Schwingen / Nationalsport", keywords: ["schwingen", "hornussen", "unspunnen"] },
    "andere": { name: "Andere Sportarten", keywords: [] }
};

function categorizeContent(title) {
    var lower = title.toLowerCase();
    var keys = Object.keys(SPORT_CATEGORIES);
    for (var i = 0; i < keys.length; i++) {
        var id = keys[i];
        if (id === "andere") continue;
        var cat = SPORT_CATEGORIES[id];
        for (var j = 0; j < cat.keywords.length; j++) {
            if (lower.indexOf(cat.keywords[j]) >= 0) return id;
        }
    }
    return "andere";
}

function getChannelUrl(categoryId) {
    return PLATFORM_URL + "/kategorie/" + categoryId;
}

function getVideoUrl(urn) {
    var parts = urn.split(":");
    return "https://www.srf.ch/play/tv/redirect/detail/" + parts[parts.length - 1];
}

function getPluginId() {
    if (typeof plugin !== 'undefined' && plugin.config) return plugin.config.id;
    return _config.id || (typeof config !== 'undefined' ? config.id : "");
}

function getYesterdayDate() {
    var d = new Date();
    d.setDate(d.getDate() - 1);
    var month = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + "-" + (month < 10 ? "0" + month : month) + "-" + (day < 10 ? "0" + day : day);
}

function mapMediaToVideo(media) {
    var isLive = media.type === "LIVESTREAM" || media.type === "SCHEDULED_LIVESTREAM";
    var thumbnailUrl = media.imageUrl || (media.episode ? media.episode.imageUrl : "") || "";
    var showTitle = (media.show ? media.show.title : "") || "";
    var categoryId = categorizeContent(media.title + " " + showTitle);
    var channelUrl = getChannelUrl(categoryId);
    var channelName = SPORT_CATEGORIES[categoryId].name;

    var dateVal = 0;
    try {
        dateVal = Math.floor(new Date(media.date).getTime() / 1000);
    } catch(e) {}

    return new PlatformVideo({
        id: new PlatformID(PLATFORM, media.id, getPluginId()),
        name: media.title || "",
        thumbnails: thumbnailUrl ? new Thumbnails([new Thumbnail(thumbnailUrl, 0)]) : new Thumbnails([]),
        author: new PlatformAuthorLink(
            new PlatformID(PLATFORM, categoryId, getPluginId()),
            "SRF Sport - " + channelName,
            channelUrl,
            ""
        ),
        uploadDate: dateVal,
        duration: isLive ? 0 : Math.floor((media.duration || 0) / 1000),
        viewCount: 0,
        url: getVideoUrl(media.urn),
        isLive: isLive
    });
}

function isSportEvent(media) {
    // Full sport events are long-duration EPISODEs (not clips/interviews)
    // CLIPs (show.title = "Sport-Clip") are short: interviews, highlights, moments
    // EPISODEs from magazine shows are analyses/summaries
    // A "sport event" recording is an EPISODE that is NOT from an analysis/magazine show
    if (media.type === "SCHEDULED_LIVESTREAM" || media.type === "LIVESTREAM") return true;
    if (media.type === "CLIP") return false;
    // For EPISODEs: filter out known analysis/magazine show titles
    var showTitle = (media.show ? media.show.title : "") || "";
    var lower = showTitle.toLowerCase();
    var analysisKeywords = ["magazin", "panorama", "lounge", "aktuell", "dok", "reportage", "inside", "talk"];
    for (var i = 0; i < analysisKeywords.length; i++) {
        if (lower.indexOf(analysisKeywords[i]) >= 0) return false;
    }
    // Full match recordings (> 60 min) are always events regardless of show title
    if ((media.duration || 0) > 3600000) return true;
    // Keep EPISODEs with duration > 15 minutes that aren't analysis shows
    return (media.duration || 0) > 900000;
}

var _config = {};
var _settings = {};

source.enable = function(conf, settings, savedState) {
    _config = conf;
    _settings = settings || {};
    log("SRF Sport plugin enabled");
};

source.disable = function() {};

source.getHome = function() {
    var videos = [];
    var sportEventsOnly = _settings.sportEventsOnly === true || _settings.sportEventsOnly === "true";

    // Upcoming scheduled sport livestreams
    try {
        var liveResp = http.GET(IL_BASE + "/srf/mediaList/video/scheduledLivestreams?pageSize=20", {}, false);
        if (liveResp.isOk) {
            var liveData = JSON.parse(liveResp.body);
            if (liveData.mediaList) {
                for (var i = 0; i < liveData.mediaList.length; i++) {
                    var media = liveData.mediaList[i];
                    if (media.creatorUser === "MMSport") {
                        videos.push(mapMediaToVideo(media));
                    }
                }
            }
        } else {
            log("SRF: scheduledLivestreams failed: " + liveResp.code);
        }
    } catch (e) {
        log("SRF: Error fetching livestreams: " + e);
    }

    // Yesterday's sport episodes (episodesByDate, client-side filtered)
    try {
        var yesterday = getYesterdayDate();
        var yResp = http.GET(IL_BASE + "/srf/mediaList/video/episodesByDate/" + yesterday + "?pageSize=100", {}, false);
        if (yResp.isOk) {
            var yData = JSON.parse(yResp.body);
            if (yData.mediaList) {
                for (var i = 0; i < yData.mediaList.length; i++) {
                    var media = yData.mediaList[i];
                    // Only include sport-topic items
                    var isSport = false;
                    if (media.show && media.show.topicList) {
                        for (var t = 0; t < media.show.topicList.length; t++) {
                            if (media.show.topicList[t].id === SPORT_TOPIC_ID || media.show.topicList[t].title === "Sport") {
                                isSport = true;
                                break;
                            }
                        }
                    }
                    if (!isSport) continue;
                    if (sportEventsOnly && !isSportEvent(media)) continue;
                    videos.push(mapMediaToVideo(media));
                }
            }
        } else {
            log("SRF: episodesByDate failed: " + yResp.code);
        }
    } catch (e) {
        log("SRF: Error fetching yesterday's episodes: " + e);
    }

    // Latest sport VODs
    var nextUrl = null;
    try {
        var vodResp = http.GET(IL_BASE + "/srf/mediaList/video/latestByTopic/" + SPORT_TOPIC_ID + "?pageSize=50", {}, false);
        if (vodResp.isOk) {
            var vodData = JSON.parse(vodResp.body);
            if (vodData.mediaList) {
                for (var i = 0; i < vodData.mediaList.length; i++) {
                    var media = vodData.mediaList[i];
                    if (sportEventsOnly && !isSportEvent(media)) continue;
                    videos.push(mapMediaToVideo(media));
                }
            }
            nextUrl = vodData.next || null;
        } else {
            log("SRF: latestByTopic failed: " + vodResp.code);
        }
    } catch (e) {
        log("SRF: Error fetching latest videos: " + e);
    }

    return new SRFHomePager(videos, !!nextUrl, nextUrl);
};

class SRFHomePager extends VideoPager {
    constructor(results, hasMore, nextUrl) {
        super(results, hasMore, { nextUrl: nextUrl });
    }

    nextPage() {
        this.results = [];
        this.hasMore = false;
        try {
            if (!this.context.nextUrl) return this;
            var resp = http.GET(this.context.nextUrl, {}, false);
            if (resp.isOk) {
                var data = JSON.parse(resp.body);
                if (data.mediaList) {
                    var sportEventsOnly = _settings.sportEventsOnly === true || _settings.sportEventsOnly === "true";
                    for (var i = 0; i < data.mediaList.length; i++) {
                        var media = data.mediaList[i];
                        if (sportEventsOnly && !isSportEvent(media)) continue;
                        this.results.push(mapMediaToVideo(media));
                    }
                }
                this.context.nextUrl = data.next || null;
                this.hasMore = !!this.context.nextUrl;
            }
        } catch (e) {
            log("SRF: Error in home nextPage: " + e);
        }
        return this;
    }
}

source.searchSuggestions = function(query) {
    return [];
};

source.getSearchCapabilities = function() {
    return {
        types: [Type.Feed.Videos],
        sorts: [Type.Order.Chronological],
        filters: []
    };
};

source.search = function(query, type, order, filters) {
    var videos = [];
    var nextUrl = null;
    try {
        var url = IL_BASE + "/srf/searchResultMediaList?q=" + encodeURIComponent(query) + "&topicId=" + SPORT_TOPIC_ID + "&mediaType=VIDEO&pageSize=20";
        var resp = http.GET(url, {}, false);
        if (resp.isOk) {
            var data = JSON.parse(resp.body);
            var list = data.searchResultMediaList || data.mediaList || [];
            for (var i = 0; i < list.length; i++) {
                var item = list[i];
                var media = item;
                if (item.mediaList && item.mediaList.length > 0) {
                    media = item.mediaList[0];
                }
                if (media && media.id && media.urn) {
                    if (!(_settings.sportEventsOnly === true || _settings.sportEventsOnly === "true") || isSportEvent(media)) {
                        videos.push(mapMediaToVideo(media));
                    }
                }
            }
            nextUrl = data.next || null;
        } else {
            log("SRF: search failed: " + resp.code);
        }
    } catch (e) {
        log("SRF: Error in search: " + e);
    }
    return new SRFSearchPager(videos, !!nextUrl, { query: query, nextUrl: nextUrl });
};

class SRFSearchPager extends VideoPager {
    constructor(results, hasMore, context) {
        super(results, hasMore, context);
    }

    nextPage() {
        var videos = [];
        var nextUrl = null;
        try {
            var resp = http.GET(this.context.nextUrl, {}, false);
            if (resp.isOk) {
                var data = JSON.parse(resp.body);
                var list = data.searchResultMediaList || data.mediaList || [];
                for (var i = 0; i < list.length; i++) {
                    var item = list[i];
                    var media = item;
                    if (item.mediaList && item.mediaList.length > 0) {
                        media = item.mediaList[0];
                    }
                    if (media && media.id && media.urn) {
                        if (!(_settings.sportEventsOnly === true || _settings.sportEventsOnly === "true") || isSportEvent(media)) {
                            videos.push(mapMediaToVideo(media));
                        }
                    }
                }
                nextUrl = data.next || null;
            }
        } catch (e) {
            log("SRF: Error in search nextPage: " + e);
        }
        return new SRFSearchPager(videos, !!nextUrl, { query: this.context.query, nextUrl: nextUrl });
    }
}

source.getSearchChannelContentsCapabilities = function() {
    return { types: [Type.Feed.Videos], sorts: [Type.Order.Chronological], filters: [] };
};

source.searchChannelContents = function(url, query, type, order, filters) {
    return source.getChannelContents(url, type, order, filters);
};

source.searchChannels = function(query) {
    var lower = query.toLowerCase();
    var channels = [];
    var keys = Object.keys(SPORT_CATEGORIES);
    for (var i = 0; i < keys.length; i++) {
        var id = keys[i];
        var cat = SPORT_CATEGORIES[id];
        var match = cat.name.toLowerCase().indexOf(lower) >= 0;
        if (!match) {
            for (var j = 0; j < cat.keywords.length; j++) {
                if (cat.keywords[j].indexOf(lower) >= 0) {
                    match = true;
                    break;
                }
            }
        }
        if (match) {
            channels.push(new PlatformChannel({
                id: new PlatformID(PLATFORM, id, getPluginId()),
                name: "SRF Sport - " + cat.name,
                thumbnail: "",
                banner: "",
                subscribers: 0,
                description: "SRF Sport: " + cat.name,
                url: getChannelUrl(id),
                links: {}
            }));
        }
    }
    return new ChannelPager(channels, false, {});
};

source.isChannelUrl = function(url) {
    return url.indexOf(PLATFORM_URL + "/kategorie/") === 0;
};

source.getChannel = function(url) {
    var parts = url.split("/kategorie/");
    var categoryId = parts.length > 1 ? parts[1] : "andere";
    var cat = SPORT_CATEGORIES[categoryId] || SPORT_CATEGORIES["andere"];
    return new PlatformChannel({
        id: new PlatformID(PLATFORM, categoryId, getPluginId()),
        name: "SRF Sport - " + cat.name,
        thumbnail: "",
        banner: "",
        subscribers: 0,
        description: "SRF Sport: " + cat.name,
        url: url,
        links: {}
    });
};

source.getChannelContents = function(url, type, order, filters) {
    var parts = url.split("/kategorie/");
    var categoryId = parts.length > 1 ? parts[1] : "andere";
    var sportEventsOnly = _settings.sportEventsOnly === true || _settings.sportEventsOnly === "true";
    var videos = [];
    var nextUrl = null;

    try {
        var apiUrl = IL_BASE + "/srf/mediaList/video/latestByTopic/" + SPORT_TOPIC_ID + "?pageSize=50";
        var resp = http.GET(apiUrl, {}, false);
        if (resp.isOk) {
            var data = JSON.parse(resp.body);
            if (data.mediaList) {
                for (var i = 0; i < data.mediaList.length; i++) {
                    var media = data.mediaList[i];
                    var vidCat = categorizeContent(media.title + " " + ((media.show ? media.show.title : "") || ""));
                    if (vidCat === categoryId || categoryId === "andere") {
                        if (!sportEventsOnly || isSportEvent(media)) {
                            videos.push(mapMediaToVideo(media));
                        }
                    }
                }
            }
            nextUrl = data.next || null;
        }
    } catch (e) {
        log("SRF: Error in getChannelContents: " + e);
    }

    try {
        var liveResp = http.GET(IL_BASE + "/srf/mediaList/video/scheduledLivestreams?pageSize=50", {}, false);
        if (liveResp.isOk) {
            var liveData = JSON.parse(liveResp.body);
            if (liveData.mediaList) {
                for (var i = 0; i < liveData.mediaList.length; i++) {
                    var media = liveData.mediaList[i];
                    if (media.creatorUser !== "MMSport") continue;
                    var vidCat = categorizeContent(media.title);
                    if (vidCat === categoryId || categoryId === "andere") {
                        if (!sportEventsOnly || isSportEvent(media)) {
                            videos.push(mapMediaToVideo(media));
                        }
                    }
                }
            }
        }
    } catch (e) {
        log("SRF: Error fetching livestreams for channel: " + e);
    }

    return new SRFChannelPager(videos, !!nextUrl, { url: url, categoryId: categoryId, nextUrl: nextUrl });
};

class SRFChannelPager extends VideoPager {
    constructor(results, hasMore, context) {
        super(results, hasMore, context);
    }

    nextPage() {
        var videos = [];
        var nextUrl = null;
        try {
            var resp = http.GET(this.context.nextUrl, {}, false);
            if (resp.isOk) {
                var data = JSON.parse(resp.body);
                if (data.mediaList) {
                    for (var i = 0; i < data.mediaList.length; i++) {
                        var media = data.mediaList[i];
                        var vidCat = categorizeContent(media.title + " " + ((media.show ? media.show.title : "") || ""));
                        if (vidCat === this.context.categoryId || this.context.categoryId === "andere") {
                            videos.push(mapMediaToVideo(media));
                        }
                    }
                }
                nextUrl = data.next || null;
            }
        } catch (e) {
            log("SRF: Error in channel nextPage: " + e);
        }
        return new SRFChannelPager(videos, !!nextUrl, { url: this.context.url, categoryId: this.context.categoryId, nextUrl: nextUrl });
    }
}

source.isContentDetailsUrl = function(url) {
    return url.indexOf("srf.ch/play/tv") >= 0 || url.indexOf("srf.ch/sport") >= 0;
};

source.getContentDetails = function(url) {
    var idMatch = url.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    if (!idMatch) throw new ScriptException("Cannot extract video ID from URL: " + url);

    var videoId = idMatch[1];

    var composition = null;
    var urns = [
        "urn:srf:video:" + videoId,
        "urn:srf:scheduled_livestream:video:" + videoId
    ];

    for (var u = 0; u < urns.length; u++) {
        try {
            var compResp = http.GET(IL_BASE + "/mediaComposition/byUrn/" + urns[u], {}, false);
            if (compResp.isOk) {
                composition = JSON.parse(compResp.body);
                break;
            }
        } catch (e) {}
    }

    if (!composition) throw new ScriptException("Could not load media composition for: " + videoId);

    var chapter = composition.chapterList && composition.chapterList[0];
    if (!chapter) throw new ScriptException("No chapter found for: " + videoId);

    var isLive = chapter.type === "LIVESTREAM" || chapter.type === "SCHEDULED_LIVESTREAM" ||
        (composition.analyticsMetadata && composition.analyticsMetadata.media_is_livestream === "true");

    var showTitle = (composition.show ? composition.show.title : "") || "";
    var categoryId = categorizeContent((chapter.title || "") + " " + showTitle);
    var channelName = SPORT_CATEGORIES[categoryId].name;

    var videoSources = [];
    var liveSource = null;

    if (chapter.resourceList) {
        for (var r = 0; r < chapter.resourceList.length; r++) {
            var resource = chapter.resourceList[r];
            if (resource.streaming === "HLS" || resource.protocol === "HLS") {
                var hlsSource = new HLSSource({
                    name: (resource.quality || "Auto") + " HLS",
                    duration: Math.floor((chapter.duration || 0) / 1000),
                    url: resource.url,
                    priority: resource.quality === "HD"
                });
                if (isLive || resource.live) {
                    liveSource = hlsSource;
                } else {
                    videoSources.push(hlsSource);
                }
            } else if (resource.streaming === "PROGRESSIVE" && resource.mimeType === "video/mp4") {
                videoSources.push(new VideoUrlSource({
                    width: resource.quality === "HD" ? 1280 : 640,
                    height: resource.quality === "HD" ? 720 : 360,
                    container: "video/mp4",
                    name: (resource.quality || "SD") + " MP4",
                    bitrate: 0,
                    duration: Math.floor((chapter.duration || 0) / 1000),
                    url: resource.url
                }));
            }
        }
    }

    var subtitles = [];
    if (chapter.subtitleList) {
        for (var s = 0; s < chapter.subtitleList.length; s++) {
            var sub = chapter.subtitleList[s];
            if (sub.format === "VTT" || (sub.url && sub.url.indexOf(".vtt") >= 0)) {
                subtitles.push({
                    name: sub.language || "Deutsch",
                    url: sub.url,
                    format: "text/vtt"
                });
            }
        }
    }

    var thumbnailUrl = chapter.imageUrl || (composition.episode ? composition.episode.imageUrl : "") || "";
    var description = chapter.lead || chapter.description || (composition.episode ? composition.episode.lead : "") || "";

    var dateStr = chapter.date || (composition.episode ? composition.episode.publishedDate : null);
    var dateVal = 0;
    try {
        if (dateStr) dateVal = Math.floor(new Date(dateStr).getTime() / 1000);
    } catch(e) {}

    return new PlatformVideoDetails({
        id: new PlatformID(PLATFORM, videoId, getPluginId()),
        name: chapter.title || "",
        thumbnails: thumbnailUrl ? new Thumbnails([new Thumbnail(thumbnailUrl, 0)]) : new Thumbnails([]),
        author: new PlatformAuthorLink(
            new PlatformID(PLATFORM, categoryId, getPluginId()),
            "SRF Sport - " + channelName,
            getChannelUrl(categoryId),
            ""
        ),
        uploadDate: dateVal,
        duration: isLive ? 0 : Math.floor((chapter.duration || 0) / 1000),
        viewCount: 0,
        url: url,
        isLive: isLive,
        description: description,
        video: new VideoSourceDescriptor(videoSources),
        live: liveSource,
        rating: new RatingLikes(0),
        subtitles: subtitles
    });
};

source.getComments = function(url) {
    return new CommentPager([], false, {});
};

source.getSubComments = function(comment) {
    return new CommentPager([], false, {});
};

log("SRF Sport plugin loaded");
