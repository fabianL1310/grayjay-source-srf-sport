"use strict";
(() => {
  // src/helpers.ts
  var fetchJson = (url) => {
    const response = http.GET(url.toString(), {}, false);
    if (!response.isOk) {
      throw new ScriptException(
        "Request failed (" + response.code + "): " + url
      );
    }
    try {
      return JSON.parse(response.body);
    } catch (e) {
      throw new ScriptException("Invalid JSON from " + url + ": " + e);
    }
  };
  var batchFetchJson = (urls, method = "GET") => {
    const batch = urls.reduce(
      (batch2, url) => batch2.request(method, url.toString(), {}, false),
      http.batch()
    );
    const responses = batch.execute();
    return responses.map((response, i) => {
      if (method === "HEAD") {
        return response;
      }
      try {
        return {
          ...response,
          body: JSON.parse(response.body)
        };
      } catch (e) {
        throw new ScriptException(
          "Invalid JSON from " + urls[i] + ": " + e
        );
      }
    });
  };
  var getDateString = (date = /* @__PURE__ */ new Date()) => {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };

  // src/constants.ts
  var PLATFORM = "SRFSport";
  var EVENTS_URL = "https://sport.api.swisstxt.ch/v1/live_events?lang=de&ignoreLCNextDay=true";
  var EVENT_DETAILS_URL = "https://event.api.swisstxt.ch/v2/events/srf/byEventItemId/";
  var SPORTS_LIST_URL = "https://sport.api.swisstxt.ch/v1/sports";
  var TOKEN_URL = "https://tp.srgssr.ch/akahd/token";
  var EVENT_PAGE_BASE_URL = "https://www.srf.ch/sport/resultcenter/live";
  var getSportUrl = (sportKey) => {
    const url = new URL(SPORTS_LIST_URL);
    url.pathname += `/${sportKey}`;
    return url;
  };
  var getEventDetailsUrl = (eventIds) => {
    const url = new URL(EVENT_DETAILS_URL);
    url.searchParams.set("eids", eventIds.join(","));
    return url;
  };
  var getEventPageUrl = (sportKey, eventId) => {
    return `${EVENT_PAGE_BASE_URL}/${sportKey}/${eventId}`;
  };
  var getTokenUrl = (hlsUrl) => {
    const acl = hlsUrl.pathname.replace(/index\.m3u8$/, "*");
    const tokenUrl = new URL(TOKEN_URL);
    tokenUrl.searchParams.set("acl", acl);
    return tokenUrl;
  };
  var getEventsUrl = (daysDelta = 0) => {
    const date = new Date(Date.now() + 24 * 60 * 60 * 1e3 * daysDelta);
    const url = new URL(EVENTS_URL);
    if (daysDelta) url.searchParams.set("date", getDateString(date));
    return url;
  };

  // src/state.ts
  var _config = null;
  var _settings = {};
  function setConfig(config) {
    _config = config || {};
  }
  function getConfig(key) {
    if (!_config) throw new Error("Config accessed before source.enable() was called");
    if (key) {
      return _config[key];
    }
    return _config;
  }
  function setSettings(settings) {
    _settings = settings || {};
  }
  function getSettings(key) {
    if (key) {
      return _settings[key];
    }
    return _settings;
  }

  // src/author.ts
  var getAuthors = (keys) => {
    const icons = getSportIconUrls(keys);
    const sports = batchFetchJson(keys.map(getSportUrl)).map((res) => res.body).reduce((acc, sport) => {
      sport.iconUrl = icons[sport.key];
      acc[sport.key] = sport;
      return acc;
    }, {});
    const configId = getConfig("id");
    return keys.reduce(
      (acc, key) => {
        const sport = sports[key];
        if (!sport) return acc;
        acc[key] = new PlatformAuthorLink(
          new PlatformID(PLATFORM, sport.key, configId),
          // TODO use language set in settings
          sport.name.de,
          // TODO
          `https://sport.api.swisstxt.ch/v1/sports/${sport.key}`,
          sport.iconUrl
        );
        return acc;
      },
      {}
    );
  };
  var getSportIconUrls = (sportKeys) => {
    const sourceUrl = getConfig("sourceUrl");
    const baseUrl = `${sourceUrl.slice(0, sourceUrl.lastIndexOf("/"))}/dist/icons/`;
    const responses = batchFetchJson(
      sportKeys.map((key) => new URL(`${baseUrl}${key}.svg`)),
      "HEAD"
    );
    return responses.reduce((acc, response, index) => {
      if (response.isOk) {
        acc[sportKeys[index]] = `${baseUrl}${sportKeys[index]}.svg`;
      }
      return acc;
    }, {});
  };

  // src/eventDetails.ts
  var fetchEventDetails = (eventIds) => {
    if (eventIds.length === 0) return [];
    try {
      return fetchJson(getEventDetailsUrl(eventIds));
    } catch (e) {
      log("SRF: failed to load event details: " + e);
      return [];
    }
  };
  var sortEventDetails = (a, b) => {
    if (getSettings("showLiveFirst") && a.category !== b.category) {
      if (a.category === "present") return -1;
      if (b.category === "present") return 1;
    }
    return new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
  };
  var getPlatformVideos = (details) => {
    const authorKeys = [...new Set(details.map((d) => d.sport))];
    const authors = getAuthors(authorKeys);
    const configId = getConfig("id");
    return details.map(
      (detail) => new PlatformVideo({
        id: new PlatformID(PLATFORM, detail.eventItemId, configId),
        name: detail.title || "Event " + detail.eventItemId,
        thumbnails: new Thumbnails([new Thumbnail(detail.imageUrl)]),
        author: authors[detail.sport],
        uploadDate: Math.floor(
          new Date(detail.startDate).getTime() / 1e3
        ),
        duration: Math.floor(detail.duration / 1e3),
        viewCount: 0,
        url: getEventPageUrl(detail.sport, detail.eventItemId),
        isLive: detail.category === "present" || detail.category === "future"
      })
    );
  };
  var getAuthHlsUrl = (detail) => {
    const hlsUrl = new URL(detail.hls);
    const { authparams } = fetchJson(getTokenUrl(hlsUrl)).token;
    if (!authparams) throw new ScriptException("Failed to get auth token");
    hlsUrl.searchParams.set("hdnts", authparams.replace("hdnts=", ""));
    hlsUrl.searchParams.set(
      "start",
      Math.floor(new Date(detail.startDate).getTime() / 1e3).toString()
    );
    hlsUrl.searchParams.set(
      "end",
      Math.floor(new Date(detail.endDate).getTime() / 1e3).toString()
    );
    return hlsUrl.toString();
  };

  // src/source.ts
  source.enable = (config, settings) => {
    setConfig(config);
    setSettings(settings);
  };
  source.setSettings = (settings) => {
    setSettings(settings);
  };
  source.reEnable = (config, settings) => {
    return source.enable(config != null ? config : getConfig(), settings != null ? settings : getSettings());
  };
  source.disable = () => {
  };
  source.getHome = () => {
    let events = [...fetchJson(getEventsUrl()), ...fetchJson(getEventsUrl(-1))];
    if (!events.length) return new VideoPager([], false, {});
    const ids = events.map((event) => event.id);
    const details = fetchEventDetails(ids);
    const videos = getPlatformVideos(details.sort(sortEventDetails));
    return new VideoPager(videos, false, {});
  };
  source.getContentDetails = (url) => {
    const eventId = url.split("/").pop();
    if (!eventId) throw new ScriptException("Invalid event URL: " + url);
    const detail = fetchEventDetails([eventId])[0];
    if (!detail) throw new ScriptException("Event not found: " + eventId);
    const plattformVideo = getPlatformVideos([detail])[0];
    const videoSource = {
      hls: null,
      dash: null,
      live: null,
      video: new VideoSourceDescriptor([])
    };
    if (new Date(detail.startDate) <= /* @__PURE__ */ new Date()) {
      const hlsSource = new HLSSource({
        name: "HLS",
        duration: plattformVideo.duration,
        url: getAuthHlsUrl(detail),
        language: detail.analyticsMetadata.media_language
      });
      videoSource.hls = hlsSource;
      if (plattformVideo.isLive) videoSource.live = hlsSource;
      videoSource.video = new VideoSourceDescriptor([hlsSource]);
    }
    return new PlatformVideoDetails({
      ...plattformVideo,
      ...videoSource,
      description: detail.description
    });
  };
  source.isContentDetailsUrl = (url) => {
    return url.startsWith(EVENT_PAGE_BASE_URL);
  };
})();
