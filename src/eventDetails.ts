import { getAuthor } from "./author";
import {
    getEventDetailsUrl,
    getEventPageUrl,
    getTokenUrl,
    PLATFORM,
} from "./constants";
import { fetchJson } from "./helpers";
import { getConfig, getSettings } from "./state";
import type { EventDetail } from "./types/eventDetail.types";

export const fetchEventDetails = (eventIds: string[]) => {
    if (eventIds.length === 0) return {};
    try {
        const out: Record<string, any> = {};
        const data = fetchJson<EventDetail[]>(getEventDetailsUrl(eventIds));
        for (const detail of data) {
            if (detail.eventItemId) out[detail.eventItemId] = detail;
        }
        return out;
    } catch (e) {
        log("SRF: failed to load event details: " + e);
        return {};
    }
};

export const sortEventDetails = (a: EventDetail, b: EventDetail) => {
    if (getSettings("showLiveFirst") && a.category !== b.category) {
        if (a.category === "present") return -1;
        if (b.category === "present") return 1;
    }
    return new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
};

export const getPlatformVideo = (detail: EventDetail) => {
    return new PlatformVideo({
        id: new PlatformID(PLATFORM, detail.eventItemId, getConfig("id")),
        name: detail.title || "Event " + detail.eventItemId,
        thumbnails: new Thumbnails([new Thumbnail(detail.imageUrl)]),
        author: getAuthor(detail.sport),
        uploadDate: Math.floor(new Date(detail.startDate).getTime() / 1000),
        duration: Math.floor(detail.duration / 1000),
        viewCount: 0,
        url: getEventPageUrl(detail.sport, detail.eventItemId),
        isLive: detail.category === "present" || detail.category === "future",
    });
};

export const getAuthHlsUrl = (detail: EventDetail) => {
    const hlsUrl = new URL(detail.hls);
    const { authparams } = fetchJson(getTokenUrl(hlsUrl)).token;
    if (!authparams) throw new ScriptException("Failed to get auth token");

    hlsUrl.searchParams.set("hdnts", authparams.replace("hdnts=", ""));
    hlsUrl.searchParams.set(
        "start",
        Math.floor(new Date(detail.startDate).getTime() / 1000).toString(),
    );
    hlsUrl.searchParams.set(
        "end",
        Math.floor(new Date(detail.endDate).getTime() / 1000).toString(),
    );

    return hlsUrl.toString()
};
