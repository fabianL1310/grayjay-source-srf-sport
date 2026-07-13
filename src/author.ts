import { getSportUrl, PLATFORM } from "./constants";
import { fetchJson } from "./helpers";
import { getConfig } from "./state";

export const getAuthor = (key: string) => {
    const sport = fetchJson(getSportUrl(key));

    return new PlatformAuthorLink(
        new PlatformID(PLATFORM, sport.key, getConfig("id")),
        // TODO use language set in settings
        sport.name.de,
        // TODO
        `https://sport.api.swisstxt.ch/v1/sports/${sport.key}`,
        getSportIconUrl(sport.key),
    );
};

const getSportIconUrl = (sportKey: string) => {
    const sourceUrl = getConfig<string>("sourceUrl");

    const url = `${sourceUrl.slice(0, sourceUrl.lastIndexOf("/"))}/dist/icons/${sportKey}.svg`;
    const response = http.request("HEAD", url, {}, false);
    if (!response.isOk) return;
    return url;
};
