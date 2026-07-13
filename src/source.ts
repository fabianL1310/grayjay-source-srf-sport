import { EVENT_PAGE_BASE_URL, getEventsUrl } from "./constants";
import {
    fetchEventDetails,
    getPlatformVideo,
    getAuthHlsUrl,
    sortEventDetails,
} from "./eventDetails";
import { fetchJson } from "./helpers";
import { getConfig, getSettings, setConfig, setSettings } from "./state";

source.enable = (config: any, settings: any) => {
    setConfig(config);
    setSettings(settings);
};

source.setSettings = (settings: any) => {
    setSettings(settings);
};

source.reEnable = (config: any, settings: any) => {
    return source.enable(config ?? getConfig(), settings ?? getSettings());
};

source.disable = () => {};

source.getHome = (): VideoPager => {
    let events = [...fetchJson(getEventsUrl()), ...fetchJson(getEventsUrl(-1))];
    if (!events.length) return new VideoPager([], false, {});

    const ids = events.map((event) => event.id);
    const details = fetchEventDetails(ids);

    const videos = Object.values(details)
        .sort(sortEventDetails)
        .map(getPlatformVideo);

    return new VideoPager(videos, false, {});
};

source.getContentDetails = (url: string): PlatformVideoDetails => {
    const eventId = url.split("/").pop();
    if (!eventId) throw new ScriptException("Invalid event URL: " + url);

    const detail = fetchEventDetails([eventId])[eventId];
    if (!detail) throw new ScriptException("Event not found: " + eventId);

    const plattformVideo = getPlatformVideo(detail);
    const videoSource: {
        hls: HLSSource | null;
        dash: DashSource | null;
        live: HLSSource | DashSource | null;
        video: VideoSourceDescriptor;
    } = {
        hls: null,
        dash: null,
        live: null,
        video: new VideoSourceDescriptor([]),
    };
    if (new Date(detail.startDate) <= new Date()) {
        const hlsSource = new HLSSource({
            name: "HLS",
            duration: plattformVideo.duration,
            url: getAuthHlsUrl(detail),
            language: detail.analyticsMetadata.media_language,
        });

        videoSource.hls = hlsSource;
        if (plattformVideo.isLive) videoSource.live = hlsSource;
        videoSource.video = new VideoSourceDescriptor([hlsSource]);
    }

    return new PlatformVideoDetails({
        ...plattformVideo,
        ...videoSource,
        description: detail.description,
    } as PlatformVideoDetailsDef);
};

source.isContentDetailsUrl = (url: string): boolean => {
    return url.startsWith(EVENT_PAGE_BASE_URL);
};
