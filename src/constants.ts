import { getDateString } from "./helpers";

export const PLATFORM = "SRFSport";
export const PLATFORM_DISPLAY = "SRF Sport";

// **maybe** make language a setting
export const EVENTS_URL =
    "https://sport.api.swisstxt.ch/v1/live_events?lang=de&ignoreLCNextDay=true";
export const EVENT_DETAILS_URL =
    "https://event.api.swisstxt.ch/v2/events/srf/byEventItemId/";
export const SPORTS_LIST_URL = "https://sport.api.swisstxt.ch/v1/sports";
export const TOKEN_URL = "https://tp.srgssr.ch/akahd/token";
export const STREAM_URL = "https://srgssrlsvech-d.akamaized.net";
export const EVENT_PAGE_BASE_URL = "https://www.srf.ch/sport/resultcenter/live";
export const SPORT_PAGE_BASE_URL = "https://www.srf.ch/sport/";

export const getSportUrl = ({
    sportKey,
    language,
}: {
    sportKey?: string;
    language?: "de" | "fr" | "if" | null;
} = {}) => {
    const url = new URL(SPORTS_LIST_URL);
    if (sportKey) url.pathname += `/${sportKey}`;

    if (language === null) {
        url.searchParams.set("lang", "0");
    } else if (language) {
        url.searchParams.set("lang", language);
    }
    return url;
};

export const getEventDetailsUrl = (eventIds: string[]) => {
    const url = new URL(EVENT_DETAILS_URL);
    url.searchParams.set("eids", eventIds.join(","));
    return url;
};

export const getEventPageUrl = (sportKey: string, eventId: string) => {
    return `${EVENT_PAGE_BASE_URL}/${sportKey}/${eventId}`;
};

export const getTokenUrl = (hlsUrl: URL) => {
    const acl = hlsUrl.pathname.replace(/index\.m3u8$/, "*");
    const tokenUrl = new URL(TOKEN_URL);
    tokenUrl.searchParams.set("acl", acl);
    return tokenUrl;
};

export const getEventsUrl = (daysDelta?: number, sportId?: string, language?: "de" | "fr" | "it" | null) => {
    const url = new URL(EVENTS_URL);
    if (daysDelta) {
        const date = new Date(Date.now() + 24 * 60 * 60 * 1000 * daysDelta);
        url.searchParams.set("date", getDateString(date));
    }
    if (sportId) url.searchParams.set("sportId", sportId);
    if (language === null) {
        url.searchParams.set("lang", "0");
    } else if (language) {
        url.searchParams.set("lang", language);
    }
    return url;
};

export const getSportPageUrl = (sportKey: string) => {
    return `${SPORT_PAGE_BASE_URL}${sportKey}`;
};
