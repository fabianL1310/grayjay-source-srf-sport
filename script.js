const PLATFORM = "SRF Sport";
const PLATFORM_URL = "https://www.srf.ch/sport";
const IL_BASE = "https://il.srf.ch/integrationlayer/2.0";
const SPORT_TOPIC_ID = "649e36d7-ff57-41c8-9c1b-7892daf15e78";

// Sport categories derived from show titles - used as "channels"
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
    const lower = title.toLowerCase();
    for (const [id, cat] of Object.entries(SPORT_CATEGORIES)) {
        if (id === "andere") continue;
        for (const kw of cat.keywords) {
            if (lower.includes(kw)) return id;
        }
    }
    return "andere";
}

function getChannelUrl(categoryId) {
    return PLATFORM_URL + "/kategorie/" + categoryId;
}

function getVideoUrl(urn) {
    return "https://www.srf.ch/play/tv/redirect/detail/" + urn.split(":").pop();
}

function mapMediaToVideo(media) {
    const isLive = media.type === "LIVESTREAM" || media.type === "SCHEDULED_LIVESTREAM";
    const thumbnailUrl = media.imageUrl || (media.episode && media.episode.imageUrl) || "";
    const showTitle = (media.show && media.show.title) || "";
    const categoryId = categorizeContent(media.title + " " + showTitle);
    const channelUrl = getChannelUrl(categoryId);
    const channelName = SPORT_CATEGORIES[categoryId].name;

    return new PlatformVideo({
        id: new PlatformID(PLATFORM, media.id, config.id),
        name: media.title,
        thumbnails: new Thumbnails([new Thumbnail(thumbnailUrl, 0)]),
        author: new PlatformAuthorLink(
            new PlatformID(PLATFORM, categoryId, config.id),
            "SRF Sport - " + channelName,
            channelUrl,
            ""
        ),
        uploadDate: Math.floor(new Date(media.date).getTime() / 1000),
        duration: isLive ? 0 : Math.floor((media.duration || 0) / 1000),
        viewCount: 0,
        url: getVideoUrl(media.urn),
        isLive: isLive
    });
}

source.enable = function(conf, settings) {
    // Nothing to initialize
};

source.disable = function() {};

source.getHome = function(continuationToken) {
    return getHomePager(continuationToken);
};

function getHomePager(continuationToken) {
    // Fetch both scheduled livestreams and latest sport videos
    const videos = [];

    // First, get scheduled livestreams (sport events)
    try {
        const liveUrl = continuationToken && continuationToken.liveNext
            ? continuationToken.liveNext
            : IL_BASE + "/srf/mediaList/video/scheduledLivestreams?pageSize=20";
        const liveResp = http.GET(liveUrl, {});
        if (liveResp.code === 200) {
            const liveData = JSON.parse(liveResp.body);
            if (liveData.mediaList) {
                for (const media of liveData.mediaList) {
                    // Only include sport streams
                    if (media.creatorUser === "MMSport") {
                        videos.push(mapMediaToVideo(media));
                    }
                }
            }
        }
    } catch (e) {}

    // Then get latest sport videos
    let nextUrl = null;
    try {
        const vodUrl = continuationToken && continuationToken.vodNext
            ? continuationToken.vodNext
            : IL_BASE + "/srf/mediaList/video/latestByTopic/" + SPORT_TOPIC_ID + "?pageSize=20";
        const vodResp = http.GET(vodUrl, {});
        if (vodResp.code === 200) {
            const vodData = JSON.parse(vodResp.body);
            if (vodData.mediaList) {
                for (const media of vodData.mediaList) {
                    videos.push(mapMediaToVideo(media));
                }
            }
            nextUrl = vodData.next || null;
        }
    } catch (e) {}

    const hasMore = !!nextUrl;
    const context = { vodNext: nextUrl };
    return new HomePager(videos, hasMore, context);
}

class HomePager extends VideoPager {
    constructor(results, hasMore, context) {
        super(results, hasMore, context);
    }
    nextPage() {
        return getHomePager(this.context);
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

source.search = function(query, type, order, filters, continuationToken) {
    return searchPager(query, type, order, filters, continuationToken);
};

function searchPager(query, type, order, filters, continuationToken) {
    // SRF doesn't have a direct search API via IL for video, so we filter latest sport videos
    // Actually use the search endpoint
    const videos = [];
    let nextUrl = null;

    try {
        const url = continuationToken
            ? continuationToken
            : IL_BASE + "/srf/searchResultMedia/video?q=" + encodeURIComponent(query) + "&pageSize=20";
        const resp = http.GET(url, {});
        if (resp.code === 200) {
            const data = JSON.parse(resp.body);
            const list = data.searchResultMediaList || data.mediaList || [];
            for (const item of list) {
                const media = item.mediaList ? item.mediaList[0] : item;
                if (!media) continue;
                // Check if it's sport related
                const isSport = (media.show && media.show.topicList &&
                    media.show.topicList.some(t => t.id === SPORT_TOPIC_ID)) ||
                    media.tagList && media.tagList.some(t => Object.keys(SPORT_CATEGORIES).some(k => SPORT_CATEGORIES[k].keywords.some(kw => t.includes(kw))));
                videos.push(mapMediaToVideo(media));
            }
            nextUrl = data.next || null;
        }
    } catch (e) {}

    const hasMore = !!nextUrl;
    return new SearchPager(videos, hasMore, { query, type, order, filters, continuationToken: nextUrl });
}

class SearchPager extends VideoPager {
    constructor(results, hasMore, context) {
        super(results, hasMore, context);
    }
    nextPage() {
        return searchPager(this.context.query, this.context.type, this.context.order, this.context.filters, this.context.continuationToken);
    }
}

source.getSearchChannelContentsCapabilities = function() {
    return { types: [Type.Feed.Videos], sorts: [Type.Order.Chronological], filters: [] };
};

source.searchChannelContents = function(url, query, type, order, filters, continuationToken) {
    // Get channel contents filtered by query
    const allVideos = getChannelVideosList(url, continuationToken);
    const lower = query.toLowerCase();
    const filtered = allVideos.videos.filter(v => v.name.toLowerCase().includes(lower));
    return new ChannelContentsPager(filtered, allVideos.hasMore, { url, query, type, order, filters, continuationToken: allVideos.nextToken });
};

source.searchChannels = function(query, continuationToken) {
    const lower = query.toLowerCase();
    const channels = [];
    for (const [id, cat] of Object.entries(SPORT_CATEGORIES)) {
        if (cat.name.toLowerCase().includes(lower) || cat.keywords.some(kw => kw.includes(lower))) {
            channels.push(new PlatformChannel({
                id: new PlatformID(PLATFORM, id, config.id),
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
    return url.startsWith(PLATFORM_URL + "/kategorie/");
};

source.getChannel = function(url) {
    const categoryId = url.split("/kategorie/")[1];
    const cat = SPORT_CATEGORIES[categoryId] || SPORT_CATEGORIES["andere"];
    return new PlatformChannel({
        id: new PlatformID(PLATFORM, categoryId, config.id),
        name: "SRF Sport - " + cat.name,
        thumbnail: "",
        banner: "",
        subscribers: 0,
        description: "SRF Sport: " + cat.name,
        url: url,
        links: {}
    });
};

source.getChannelContents = function(url, type, order, filters, continuationToken) {
    const result = getChannelVideosList(url, continuationToken);
    return new ChannelContentsPager(result.videos, result.hasMore, { url, type, order, filters, continuationToken: result.nextToken });
};

function getChannelVideosList(url, continuationToken) {
    const categoryId = url.split("/kategorie/")[1] || "andere";
    const cat = SPORT_CATEGORIES[categoryId];
    const videos = [];
    let nextUrl = null;

    try {
        const apiUrl = continuationToken
            ? continuationToken
            : IL_BASE + "/srf/mediaList/video/latestByTopic/" + SPORT_TOPIC_ID + "?pageSize=50";
        const resp = http.GET(apiUrl, {});
        if (resp.code === 200) {
            const data = JSON.parse(resp.body);
            if (data.mediaList) {
                for (const media of data.mediaList) {
                    const vidCat = categorizeContent(media.title + " " + ((media.show && media.show.title) || ""));
                    if (vidCat === categoryId || categoryId === "andere") {
                        videos.push(mapMediaToVideo(media));
                    }
                }
            }
            nextUrl = data.next || null;
        }
    } catch (e) {}

    // Also include scheduled livestreams for this category
    if (!continuationToken) {
        try {
            const liveResp = http.GET(IL_BASE + "/srf/mediaList/video/scheduledLivestreams?pageSize=50", {});
            if (liveResp.code === 200) {
                const liveData = JSON.parse(liveResp.body);
                if (liveData.mediaList) {
                    for (const media of liveData.mediaList) {
                        if (media.creatorUser !== "MMSport") continue;
                        const vidCat = categorizeContent(media.title);
                        if (vidCat === categoryId || categoryId === "andere") {
                            videos.push(mapMediaToVideo(media));
                        }
                    }
                }
            }
        } catch (e) {}
    }

    return { videos, hasMore: !!nextUrl, nextToken: nextUrl };
}

class ChannelContentsPager extends VideoPager {
    constructor(results, hasMore, context) {
        super(results, hasMore, context);
    }
    nextPage() {
        return source.getChannelContents(this.context.url, this.context.type, this.context.order, this.context.filters, this.context.continuationToken);
    }
}

source.isContentDetailsUrl = function(url) {
    return url.includes("srf.ch/play/tv") || url.includes("srf.ch/sport");
};

source.getContentDetails = function(url) {
    // Extract video ID from URL
    const idMatch = url.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    if (!idMatch) throw new ScriptException("Cannot extract video ID from URL: " + url);

    const videoId = idMatch[1];

    // Try regular video URN first, then scheduled_livestream URN
    let composition = null;
    const urns = [
        "urn:srf:video:" + videoId,
        "urn:srf:scheduled_livestream:video:" + videoId
    ];

    for (const urn of urns) {
        try {
            const resp = http.GET(IL_BASE + "/mediaComposition/byUrn/" + urn, {});
            if (resp.code === 200) {
                composition = JSON.parse(resp.body);
                break;
            }
        } catch (e) {}
    }

    if (!composition) throw new ScriptException("Could not load media composition for: " + videoId);

    const chapter = composition.chapterList && composition.chapterList[0];
    if (!chapter) throw new ScriptException("No chapter found for: " + videoId);

    const isLive = chapter.type === "LIVESTREAM" || chapter.type === "SCHEDULED_LIVESTREAM" ||
        (composition.analyticsMetadata && composition.analyticsMetadata.media_is_livestream === "true");

    const showTitle = (composition.show && composition.show.title) || "";
    const categoryId = categorizeContent((chapter.title || "") + " " + showTitle);
    const channelName = SPORT_CATEGORIES[categoryId].name;

    // Build sources
    const videoSources = [];
    let liveSource = null;

    if (chapter.resourceList) {
        for (const resource of chapter.resourceList) {
            if (resource.streaming === "HLS" || resource.protocol === "HLS" || resource.protocol === "HLS-DVR") {
                const hlsSource = new HLSSource({
                    name: (resource.quality || "Auto") + " HLS",
                    duration: Math.floor((chapter.duration || 0) / 1000),
                    url: resource.url,
                    priority: true
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
                    codec: "h264",
                    name: (resource.quality || "SD") + " MP4",
                    bitrate: 0,
                    duration: Math.floor((chapter.duration || 0) / 1000),
                    url: resource.url
                }));
            } else if (resource.streaming === "DASH" || resource.protocol === "DASH" || resource.protocol === "DASH-DVR") {
                if (isLive || resource.live) {
                    liveSource = new DashSource({
                        name: (resource.quality || "Auto") + " DASH",
                        duration: Math.floor((chapter.duration || 0) / 1000),
                        url: resource.url
                    });
                } else {
                    videoSources.push(new DashSource({
                        name: (resource.quality || "Auto") + " DASH",
                        duration: Math.floor((chapter.duration || 0) / 1000),
                        url: resource.url
                    }));
                }
            }
        }
    }

    // Build subtitles
    const subtitles = [];
    if (chapter.subtitleList) {
        for (const sub of chapter.subtitleList) {
            if (sub.format === "VTT" || sub.url.endsWith(".vtt")) {
                subtitles.push({
                    name: sub.language || "Deutsch",
                    url: sub.url,
                    format: "text/vtt"
                });
            }
        }
    }

    const thumbnailUrl = chapter.imageUrl || (composition.episode && composition.episode.imageUrl) || "";
    const description = chapter.lead || chapter.description || (composition.episode && composition.episode.lead) || "";

    return new PlatformVideoDetails({
        id: new PlatformID(PLATFORM, videoId, config.id),
        name: chapter.title || "",
        thumbnails: new Thumbnails([new Thumbnail(thumbnailUrl, 0)]),
        author: new PlatformAuthorLink(
            new PlatformID(PLATFORM, categoryId, config.id),
            "SRF Sport - " + channelName,
            getChannelUrl(categoryId),
            ""
        ),
        uploadDate: Math.floor(new Date(chapter.date || composition.episode.publishedDate).getTime() / 1000),
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
