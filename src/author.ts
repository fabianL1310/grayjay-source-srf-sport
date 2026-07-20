import { getSportUrl, PLATFORM } from "./constants";
import { batchFetchJson } from "./helpers";
import { getConfig } from "./state";
import { Author } from "./types/author.types";

export const getAuthors = (keys: string[]) => {
    const icons = getSportIconUrls(keys);
    const sports = batchFetchJson<Author>(keys.map(getSportUrl))
        .map((res) => res.body)
        .reduce((acc, sport) => {
            sport.iconUrl = icons[sport.key];
            acc[sport.key] = sport;
            return acc;
        }, {} as Record<string, Author>);

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
                sport.iconUrl,
            );
            return acc;
        },
        {} as Record<string, PlatformAuthorLink>,
    );
};

const getSportIconUrls = (sportKeys: string[]) => {
    const sourceUrl = getConfig<string>("sourceUrl");
    const baseUrl = `${sourceUrl.slice(0, sourceUrl.lastIndexOf("/"))}/dist/icons/`;

    const responses = batchFetchJson(
        sportKeys.map((key) => new URL(`${baseUrl}${key}.svg`)),
        "HEAD",
    );

    return responses.reduce((acc, response, index) => {
        if (response.isOk) {
            acc[sportKeys[index]] = `${baseUrl}${sportKeys[index]}.svg`;
        }
        return acc;
    }, {} as Record<string, string>);
};
